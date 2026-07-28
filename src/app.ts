import {
  DEFAULT_CONFIG,
  OPERATIONS,
  OPERATION_DETAILS,
  createRandomSeed,
  formatExpression,
  generateProblems,
  speakExpression,
  validateConfig,
  type Operation,
  type TrainingConfig,
} from './math/engine'
import {
  advanceSession,
  appendCurrentDigit,
  checkCurrentAnswer,
  clearCurrentDraft,
  createTrainingSession,
  deleteCurrentDigit,
  formatDuration,
  getElapsedMs,
  pauseSession,
  resumeSession,
  revealCurrentAnswer,
  setCurrentDraft,
  summarizeSession,
  type TrainingSession,
} from './state/session'
import {
  APP_SCHEMA_VERSION,
  ProgressStore,
  type PersistedAppState,
  type StoreLoadResult,
} from './storage/progress-store'

type StorePort = Pick<ProgressStore, 'load' | 'save' | 'clear'>

export interface AppDependencies {
  store?: StorePort
  now?: () => number
  createSeed?: () => number
}

interface Notice {
  message: string
  tone: 'info' | 'warning'
}

export class MathTrainingApp {
  private readonly root: HTMLElement
  private readonly store: StorePort
  private readonly now: () => number
  private readonly createSeed: () => number
  private state: PersistedAppState
  private notice: Notice | null = null
  private timerId: number | null = null
  private lastPersistedAt = 0
  private storageWarningShown = false
  private started = false

  constructor(root: HTMLElement, dependencies: AppDependencies = {}) {
    this.root = root
    this.store = dependencies.store ?? new ProgressStore()
    this.now = dependencies.now ?? Date.now
    this.createSeed = dependencies.createSeed ?? createRandomSeed
    this.state = createDefaultAppState()
  }

  start(): void {
    if (this.started) return
    this.started = true

    this.restore(this.store.load())
    this.root.addEventListener('click', this.handleClick)
    this.root.addEventListener('change', this.handleChange)
    this.root.addEventListener('input', this.handleInput)
    this.root.addEventListener('submit', this.handleSubmit)
    this.root.addEventListener('keydown', this.handleKeydown)
    document.addEventListener('visibilitychange', this.handleVisibilityChange)
    window.addEventListener('beforeunload', this.handleBeforeUnload)
    this.timerId = window.setInterval(this.handleTimerTick, 250)

    this.render()
    this.focusCurrentView()
  }

  destroy(): void {
    if (!this.started) return
    this.persist(true)
    this.root.removeEventListener('click', this.handleClick)
    this.root.removeEventListener('change', this.handleChange)
    this.root.removeEventListener('input', this.handleInput)
    this.root.removeEventListener('submit', this.handleSubmit)
    this.root.removeEventListener('keydown', this.handleKeydown)
    document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    window.removeEventListener('beforeunload', this.handleBeforeUnload)
    if (this.timerId !== null) window.clearInterval(this.timerId)
    this.timerId = null
    this.started = false
  }

  private readonly handleClick = (event: MouseEvent): void => {
    const target = event.target
    if (!(target instanceof Element)) return

    const actionElement = target.closest<HTMLElement>('[data-action]')
    if (!actionElement || !this.root.contains(actionElement)) return

    const action = actionElement.dataset.action
    switch (action) {
      case 'home':
        this.goHome()
        break
      case 'resume-session':
        this.resumeSavedSession()
        break
      case 'open-discard':
        this.openDialog('discard-dialog', actionElement)
        break
      case 'confirm-discard':
        this.discardSession()
        break
      case 'confirm-replace':
        this.startNewSession()
        break
      case 'save-exit':
        this.saveAndExit()
        break
      case 'open-restart':
        this.openDialog('restart-dialog', actionElement)
        break
      case 'confirm-restart':
        this.restartSession()
        break
      case 'open-reveal':
        this.openDialog('reveal-dialog', actionElement)
        break
      case 'confirm-reveal':
        this.confirmReveal()
        break
      case 'keypad':
        this.useKeypad(actionElement.dataset.key ?? '')
        break
      case 'question-count':
        this.setQuestionCount(actionElement.dataset.value ?? '', actionElement)
        break
      case 'practice-again':
        this.restartSession()
        break
      case 'change-settings':
        this.changeSettings()
        break
      default:
        break
    }
  }

  private readonly handleChange = (event: Event): void => {
    const target = event.target
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return
    if (!target.closest('#setup-form')) return

    const next = cloneConfig(this.state.settings)
    const focusId = target.id

    if (target.name === 'minDigits') {
      next.minDigits = Number(target.value)
      if (next.minDigits > next.maxDigits) next.maxDigits = next.minDigits
    } else if (target.name === 'maxDigits') {
      next.maxDigits = Number(target.value)
      if (next.maxDigits < next.minDigits) next.minDigits = next.maxDigits
    } else if (target.name === 'operatorCount') {
      next.operatorCount = Number(target.value)
    } else if (target.name === 'operationMode') {
      next.operationMode = target.value === 'mixed' ? 'mixed' : 'same'
    } else if (target.name === 'operation' && target instanceof HTMLInputElement) {
      const operation = target.value as Operation
      if (target.checked) {
        next.operations = [...new Set([...next.operations, operation])]
      } else if (next.operations.length === 1) {
        this.announce('Keep at least one operation selected.')
        target.checked = true
        return
      } else {
        next.operations = next.operations.filter((item) => item !== operation)
      }
    } else if (target.name === 'problemCount') {
      next.problemCount = clampInteger(Number(target.value), 1, 50)
    } else {
      return
    }

    if (next.operationMode === 'mixed' && (next.operations.length < 2 || next.operatorCount < 2)) {
      next.operationMode = 'same'
      this.notice = {
        message: 'Mixed mode needs at least two operations and two operator positions, so Same mode is active.',
        tone: 'info',
      }
    }

    this.state = { ...this.state, settings: next }
    this.persist()
    this.render()
    window.requestAnimationFrame(() => document.getElementById(focusId)?.focus())
  }

  private readonly handleInput = (event: Event): void => {
    const target = event.target
    if (!(target instanceof HTMLInputElement)) return

    if (target.id === 'answer-input') {
      const session = this.state.session
      if (!session) return
      const updated = setCurrentDraft(session, target.value)
      this.state = { ...this.state, session: updated }
      this.syncAnswerControls()
      this.persist()
      return
    }

    if (target.name === 'problemCount') {
      const value = Number(target.value)
      if (Number.isInteger(value) && value >= 1 && value <= 50) {
        this.state = {
          ...this.state,
          settings: { ...this.state.settings, problemCount: value },
        }
        this.updateQuestionCountPresets()
      }
    }
  }

  private readonly handleSubmit = (event: SubmitEvent): void => {
    const form = event.target
    if (!(form instanceof HTMLFormElement)) return

    if (form.id === 'setup-form') {
      event.preventDefault()
      if (validateConfig(this.state.settings).length > 0) return
      if (this.hasActiveSession()) {
        const trigger = event.submitter instanceof HTMLElement ? event.submitter : undefined
        this.openDialog('replace-dialog', trigger)
      } else {
        this.startNewSession()
      }
      return
    }

    if (form.id === 'answer-form') {
      event.preventDefault()
      this.submitCurrentAnswer()
    }
  }

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    const target = event.target
    if (!(target instanceof HTMLInputElement) || target.id !== 'answer-input') return

    if (event.key === 'Escape' || event.key === '*') {
      event.preventDefault()
      this.updateSession(clearCurrentDraft)
      this.syncAnswerControls()
      this.persist()
    } else if (event.key === '-') {
      event.preventDefault()
      this.updateSession(deleteCurrentDigit)
      this.syncAnswerControls()
      this.persist()
    }
  }

  private readonly handleVisibilityChange = (): void => {
    const session = this.state.session
    if (!session || this.state.view !== 'practice' || session.completedAt !== null) return

    if (document.visibilityState === 'hidden') {
      this.state = { ...this.state, session: pauseSession(session, this.now()) }
      this.persist(true)
    } else {
      this.state = { ...this.state, session: resumeSession(session, this.now()) }
      this.updateTimerText()
    }
  }

  private readonly handleBeforeUnload = (): void => {
    this.persist(true)
  }

  private readonly handleTimerTick = (): void => {
    if (this.state.view !== 'practice' || !this.state.session) return
    this.updateTimerText()
    const now = this.now()
    if (now - this.lastPersistedAt >= 2_000) this.persist()
  }

  private restore(result: StoreLoadResult): void {
    if (result.status === 'ok' && result.state) {
      this.state = result.state
      const session = this.state.session
      if (!session) {
        this.state = { ...this.state, view: 'setup' }
      } else if (session.completedAt !== null) {
        this.state = { ...this.state, view: 'complete' }
      } else if (this.state.view === 'practice') {
        this.state = { ...this.state, session: resumeSession(session, this.now()) }
      } else if (this.state.view === 'complete') {
        this.state = { ...this.state, view: 'setup' }
      }
      return
    }

    if (result.status === 'invalid') {
      this.store.clear()
      this.notice = {
        message: 'Your saved session could not be restored, so a fresh setup is ready.',
        tone: 'warning',
      }
    } else if (result.status === 'unavailable') {
      this.notice = {
        message: 'Progress cannot be saved on this device. Practice still works in this tab.',
        tone: 'warning',
      }
      this.storageWarningShown = true
    }
  }

  private render(): void {
    const content =
      this.state.view === 'practice' && this.state.session
        ? this.renderPractice(this.state.session)
        : this.state.view === 'complete' && this.state.session
          ? this.renderCompletion(this.state.session)
          : this.renderSetup()

    this.root.innerHTML = `
      <a class="skip-link" href="#main-content">Skip to practice</a>
      ${this.renderHeader()}
      <div id="global-status" class="global-status" role="status" aria-live="polite" aria-atomic="true">
        ${this.notice ? this.renderNotice(this.notice) : ''}
      </div>
      ${content}
      <footer class="site-footer">
        <p><span aria-hidden="true">🔒</span> Your practice stays in this browser. No account, cookies, or tracking.</p>
        <a href="https://github.com/dmoliveira/ai-math-training" target="_blank" rel="noreferrer">View source <span class="sr-only">(opens in a new tab)</span></a>
      </footer>
    `
  }

  private renderHeader(): string {
    const practiceActions =
      this.state.view === 'practice'
        ? `<div class="header-actions">
            <button class="button button--quiet button--compact" type="button" data-action="open-restart">
              <span aria-hidden="true">↻</span> Restart
            </button>
            <button class="button button--secondary button--compact" type="button" data-action="save-exit">
              Save &amp; exit
            </button>
          </div>`
        : ''

    return `
      <header class="site-header">
        <div class="site-header__inner">
          <button class="brand" type="button" data-action="home" aria-label="Math Training home">
            <span class="brand__mark" aria-hidden="true">
              <span>+</span><span>×</span>
            </span>
            <span class="brand__name">Math Training</span>
          </button>
          ${practiceActions}
        </div>
      </header>
    `
  }

  private renderSetup(): string {
    const config = this.state.settings
    const errors = validateConfig(config)
    const canMix = config.operations.length >= 2 && config.operatorCount >= 2
    const example = this.renderExample(config, errors)
    const resumeCard = this.hasActiveSession() && this.state.session ? this.renderResumeCard(this.state.session) : ''

    return `
      <main id="main-content" class="page-shell setup-page">
        <section class="setup-hero" aria-labelledby="setup-heading">
          <div class="eyebrow"><span aria-hidden="true">✦</span> Focused arithmetic practice</div>
          <h1 id="setup-heading" tabindex="-1">Sharpen your number sense.</h1>
          <p class="lede">Build a session that meets you where you are, then strengthen speed and confidence one answer at a time.</p>
          <img class="hero-art" src="${import.meta.env.BASE_URL}math-training-banner.svg" alt="" width="1600" height="560" />
          <ul class="benefit-list" aria-label="Practice benefits">
            <li><span aria-hidden="true">✓</span> Your level, your pace</li>
            <li><span aria-hidden="true">✓</span> Instant, calm feedback</li>
            <li><span aria-hidden="true">✓</span> Progress saved locally</li>
          </ul>
        </section>

        <div class="setup-column">
          ${resumeCard}
          <form id="setup-form" class="settings-card" novalidate>
            <div class="card-heading">
              <div>
                <p class="step-label">Session setup</p>
                <h2>Build your practice</h2>
              </div>
              <span class="privacy-pill"><span aria-hidden="true">●</span> Private</span>
            </div>

            <fieldset class="setting-group">
              <legend>Number size</legend>
              <p class="field-hint">Choose the smallest and largest operand.</p>
              <div class="range-controls">
                ${this.renderDigitSelect('minDigits', 'From', config.minDigits)}
                <span class="range-arrow" aria-hidden="true">→</span>
                ${this.renderDigitSelect('maxDigits', 'To', config.maxDigits)}
              </div>
              <p class="selection-note">${escapeHtml(digitRangeDescription(config))}</p>
            </fieldset>

            <fieldset class="setting-group">
              <legend>Operations</legend>
              <p class="field-hint">Pick one or more skills to practise.</p>
              <div class="operation-grid">
                ${OPERATIONS.map((operation) => this.renderOperationChoice(operation, config)).join('')}
              </div>
            </fieldset>

            <fieldset class="setting-group">
              <legend>Operators per question</legend>
              <p class="field-hint">${config.operatorCount} ${pluralize(config.operatorCount, 'operator')} means ${config.operatorCount + 1} numbers.</p>
              <div class="segmented-control segmented-control--four">
                ${[1, 2, 3, 4]
                  .map(
                    (count) => `
                      <label>
                        <input id="operator-count-${count}" type="radio" name="operatorCount" value="${count}" ${checked(config.operatorCount === count)} />
                        <span>${count}</span>
                      </label>`,
                  )
                  .join('')}
              </div>
            </fieldset>

            <fieldset class="setting-group">
              <legend>Operation pattern</legend>
              <div class="mode-options">
                <label class="mode-card">
                  <input id="mode-same" type="radio" name="operationMode" value="same" ${checked(config.operationMode === 'same')} />
                  <span class="mode-card__body">
                    <strong>Same operation</strong>
                    <small>One selected operation repeats in a question.</small>
                  </span>
                </label>
                <label class="mode-card ${canMix ? '' : 'mode-card--disabled'}">
                  <input id="mode-mixed" type="radio" name="operationMode" value="mixed" ${checked(config.operationMode === 'mixed')} ${disabled(!canMix)} />
                  <span class="mode-card__body">
                    <strong>Mixed operations</strong>
                    <small>Selected operations can differ. Standard order applies.</small>
                  </span>
                </label>
              </div>
              ${
                canMix
                  ? ''
                  : '<p class="selection-note">Choose at least two operations and two operators to unlock Mixed.</p>'
              }
            </fieldset>

            <fieldset class="setting-group">
              <legend>Questions this session</legend>
              <div class="question-count-row">
                <label class="number-field" for="problem-count">
                  <span class="number-field__label">Custom</span>
                  <input id="problem-count" name="problemCount" type="number" min="1" max="50" step="1" value="${config.problemCount}" inputmode="numeric" />
                </label>
                <div class="preset-row" aria-label="Quick question counts">
                  ${[5, 10, 20, 30]
                    .map(
                      (count) => `<button class="preset ${config.problemCount === count ? 'preset--active' : ''}" type="button" data-action="question-count" data-value="${count}" aria-pressed="${config.problemCount === count}">${count}</button>`,
                    )
                    .join('')}
                </div>
              </div>
              <p class="selection-note">Choose any amount from 1 to 50.</p>
            </fieldset>

            ${example}
            ${errors.length > 0 ? this.renderConfigErrors(errors) : ''}

            <button class="button button--primary button--large" type="submit" ${disabled(errors.length > 0)}>
              Start practice <span aria-hidden="true">→</span>
            </button>
            <p class="keyboard-note"><span aria-hidden="true">⌨</span> Built for keyboard and number-pad practice.</p>
          </form>
        </div>

        ${this.renderSetupDialogs()}
      </main>
    `
  }

  private renderResumeCard(session: TrainingSession): string {
    const summary = summarizeSession(session, this.now())
    return `
      <aside class="resume-card" aria-labelledby="resume-title">
        <div class="resume-card__icon" aria-hidden="true">▶</div>
        <div class="resume-card__copy">
          <p class="step-label">Saved on this device</p>
          <h2 id="resume-title">Continue your session</h2>
          <p>Question ${session.currentIndex + 1} of ${session.problems.length} · ${summary.mistakes} ${pluralize(summary.mistakes, 'mistake')} · ${formatDuration(summary.elapsedMs)}</p>
        </div>
        <div class="resume-card__actions">
          <button class="button button--primary button--compact" type="button" data-action="resume-session">Resume</button>
          <button class="button button--quiet button--compact" type="button" data-action="open-discard">Discard</button>
        </div>
      </aside>
    `
  }

  private renderDigitSelect(name: 'minDigits' | 'maxDigits', label: string, value: number): string {
    return `
      <label class="select-field" for="${name}">
        <span>${label}</span>
        <select id="${name}" name="${name}">
          ${[1, 2, 3, 4, 5]
            .map((digits) => `<option value="${digits}" ${selected(value === digits)}>${digits} ${pluralize(digits, 'digit')}</option>`)
            .join('')}
        </select>
      </label>
    `
  }

  private renderOperationChoice(operation: Operation, config: TrainingConfig): string {
    const detail = OPERATION_DETAILS[operation]
    return `
      <label class="operation-choice operation-choice--${operation}">
        <input id="operation-${operation}" type="checkbox" name="operation" value="${operation}" ${checked(config.operations.includes(operation))} />
        <span class="operation-choice__symbol" aria-hidden="true">${detail.symbol}</span>
        <span>${detail.label}</span>
        <span class="operation-choice__check" aria-hidden="true">✓</span>
      </label>
    `
  }

  private renderExample(config: TrainingConfig, errors: string[]): string {
    if (errors.length > 0) {
      return `
        <aside class="example-card example-card--unavailable" aria-live="polite">
          <span class="example-card__label">Live example</span>
          <strong>Adjust the highlighted setup to preview a question.</strong>
        </aside>
      `
    }

    const previewConfig = { ...cloneConfig(config), problemCount: 1 }
    const problem = generateProblems(previewConfig, settingsSeed(config))[0]
    if (!problem) return ''

    const operationNames = config.operations.map((operation) => OPERATION_DETAILS[operation].shortLabel).join(', ')
    const largeAnswer = config.operations.includes('multiply') && config.maxDigits >= 4 && config.operatorCount >= 3

    return `
      <aside class="example-card" aria-live="polite">
        <span class="example-card__label">Live example</span>
        <strong aria-label="${escapeHtml(speakExpression(problem))}">${escapeHtml(formatExpression(problem))}</strong>
        <p>${config.problemCount} ${pluralize(config.problemCount, 'question')} · ${digitRangeShort(config)} · ${operationNames}</p>
        ${largeAnswer ? '<p class="example-warning"><span aria-hidden="true">!</span> This setup can create very large answers.</p>' : ''}
      </aside>
    `
  }

  private renderConfigErrors(errors: string[]): string {
    return `
      <div class="config-errors" role="alert">
        <strong>One quick adjustment</strong>
        <ul>${errors.map((error) => `<li>${escapeHtml(error)}</li>`).join('')}</ul>
      </div>
    `
  }

  private renderSetupDialogs(): string {
    return `
      ${dialogMarkup(
        'discard-dialog',
        'Discard saved session?',
        'This progress cannot be recovered.',
        'Keep session',
        'Discard',
        'confirm-discard',
        true,
      )}
      ${dialogMarkup(
        'replace-dialog',
        'Start a new session?',
        'Your saved session will be replaced with this setup.',
        'Keep saved session',
        'Start new session',
        'confirm-replace',
        true,
      )}
    `
  }

  private renderPractice(session: TrainingSession): string {
    const problem = session.problems[session.currentIndex]
    const progress = session.progress[session.currentIndex]
    if (!problem || !progress) return this.renderSetup()

    const locked = progress.status !== 'pending'
    const isLast = session.currentIndex === session.problems.length - 1
    const progressValue = locked ? session.currentIndex + 1 : session.currentIndex

    return `
      <main id="main-content" class="page-shell practice-page">
        <section class="session-toolbar" aria-label="Session progress">
          <div class="progress-copy">
            <span>Question <strong>${session.currentIndex + 1}</strong> of ${session.problems.length}</span>
            <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="${session.problems.length}" aria-valuenow="${progressValue}" aria-label="${progressValue} of ${session.problems.length} questions completed">
              <span style="width: ${(progressValue / session.problems.length) * 100}%"></span>
            </div>
          </div>
          <dl class="session-metrics">
            <div><dt>Time</dt><dd id="elapsed-time">${formatDuration(getElapsedMs(session, this.now()))}</dd></div>
            <div><dt>Mistakes</dt><dd>${session.mistakes}</dd></div>
          </dl>
        </section>

        <ol class="question-trail" aria-label="Question status">
          ${session.progress
            .map((item, index) => {
              const stateLabel =
                item.status === 'correct'
                  ? 'correct'
                  : item.status === 'revealed'
                    ? 'revealed'
                    : index === session.currentIndex
                      ? 'current'
                      : 'not answered'
              return `<li class="question-dot question-dot--${item.status} ${index === session.currentIndex ? 'question-dot--current' : ''}" aria-label="Question ${index + 1}: ${stateLabel}"><span>${item.status === 'correct' ? '✓' : item.status === 'revealed' ? '•' : index + 1}</span></li>`
            })
            .join('')}
        </ol>

        <article class="practice-card" aria-labelledby="problem-heading">
          <div class="problem-panel">
            <p class="step-label">Question ${session.currentIndex + 1}</p>
            <h1 id="problem-heading" class="problem-heading" tabindex="-1">Solve the expression</h1>
            ${renderExpression(problem)}

            <form id="answer-form" class="answer-form" novalidate>
              <label for="answer-input">Your answer</label>
              <div class="answer-input-wrap ${progress.feedback === 'incorrect' ? 'answer-input-wrap--error' : ''} ${progress.status === 'correct' ? 'answer-input-wrap--success' : ''}">
                <input
                  id="answer-input"
                  name="answer"
                  type="text"
                  inputmode="numeric"
                  enterkeyhint="done"
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck="false"
                  pattern="[0-9]*"
                  maxlength="80"
                  value="${escapeHtml(progress.draft)}"
                  aria-describedby="answer-help answer-feedback"
                  ${readonly(locked)}
                />
                ${locked ? `<span class="answer-lock" aria-label="Answer locked">${progress.status === 'correct' ? '✓' : '●'}</span>` : ''}
              </div>
              <p id="answer-help" class="answer-help">Type, use the keypad, or press <kbd>Enter</kbd> to check. <kbd>−</kbd> deletes; <kbd>×</kbd> clears.</p>
              <div id="answer-feedback" class="answer-feedback answer-feedback--${progress.feedback}" role="status" aria-live="polite" aria-atomic="true">
                ${feedbackMarkup(progress.feedback, problem.answer)}
              </div>

              <div class="practice-actions">
                <button id="primary-action" class="button button--primary button--large" type="submit" ${disabled(!locked && progress.draft === '')}>
                  ${locked ? (isLast ? 'See results' : 'Next question') : 'Check answer'} <span aria-hidden="true">${locked ? '→' : '✓'}</span>
                </button>
                ${
                  locked
                    ? ''
                    : '<button class="button button--quiet" type="button" data-action="open-reveal">Reveal answer</button>'
                }
              </div>
            </form>
          </div>

          <div class="keypad-panel" aria-label="Number keypad">
            <p class="keypad-title"><span>Number pad</span><small>Optional</small></p>
            <div class="keypad-grid">
              ${['1', '2', '3', '4', '5', '6', '7', '8', '9']
                .map((digit) => keypadButton(digit, digit, locked))
                .join('')}
              ${keypadButton('Clear', 'clear', locked, 'keypad-key--utility')}
              ${keypadButton('0', '0', locked)}
              ${keypadButton('Delete last digit', 'delete', locked, 'keypad-key--utility', '⌫')}
            </div>
            <p class="keypad-tip"><span aria-hidden="true">↵</span> Press Enter to keep moving.</p>
          </div>
        </article>

        ${dialogMarkup(
          'reveal-dialog',
          'Reveal this answer?',
          'This question will count as one mistake and the answer will lock.',
          'Keep trying',
          'Reveal answer',
          'confirm-reveal',
          false,
        )}
        ${dialogMarkup(
          'restart-dialog',
          'Restart this session?',
          'Your current answers and time will be replaced with new questions using the same settings.',
          'Keep practising',
          'Restart session',
          'confirm-restart',
          true,
        )}
      </main>
    `
  }

  private renderCompletion(session: TrainingSession): string {
    const summary = summarizeSession(session, this.now())
    const perfect = summary.mistakes === 0 && summary.revealed === 0

    return `
      <main id="main-content" class="page-shell completion-page">
        <section class="completion-card" aria-labelledby="completion-heading">
          <div class="celebration" aria-hidden="true">
            <span class="celebration__ring"></span>
            <span class="celebration__mark">✓</span>
            ${Array.from({ length: 8 }, (_, index) => `<i style="--i: ${index}"></i>`).join('')}
          </div>
          <p class="eyebrow"><span aria-hidden="true">✦</span> Session finished</p>
          <h1 id="completion-heading" tabindex="-1">${perfect ? 'Perfect run!' : 'Session complete.'}</h1>
          <p class="completion-lede">${perfect ? 'Every answer landed on the first try. Excellent focus.' : 'You showed up and worked it through. That is how fluency grows.'}</p>

          <dl class="results-grid">
            <div class="result-card result-card--primary">
              <dt>First-try accuracy</dt>
              <dd>${summary.accuracy}<span>%</span><small>${summary.firstTryCorrect} of ${summary.total} questions</small></dd>
            </div>
            <div class="result-card">
              <dt>Mistakes</dt>
              <dd>${summary.mistakes}<small>${summary.revealed} ${pluralize(summary.revealed, 'answer')} revealed</small></dd>
            </div>
            <div class="result-card">
              <dt>Active time</dt>
              <dd>${formatDuration(summary.elapsedMs)}<small>Paused when you stepped away</small></dd>
            </div>
          </dl>

          <div class="completion-actions">
            <button class="button button--primary button--large" type="button" data-action="practice-again">Practice again <span aria-hidden="true">↻</span></button>
            <button class="button button--secondary button--large" type="button" data-action="change-settings">Change settings</button>
          </div>
          <p class="completion-note"><span aria-hidden="true">🌱</span> A little consistent practice makes big numbers feel smaller.</p>
        </section>
      </main>
    `
  }

  private renderNotice(notice: Notice): string {
    return `<div class="notice notice--${notice.tone}"><span aria-hidden="true">${notice.tone === 'warning' ? '!' : 'i'}</span><p>${escapeHtml(notice.message)}</p></div>`
  }

  private startNewSession(): void {
    const errors = validateConfig(this.state.settings)
    if (errors.length > 0) return

    const session = createTrainingSession(this.state.settings, this.createSeed(), this.now())
    this.state = {
      schemaVersion: APP_SCHEMA_VERSION,
      view: 'practice',
      settings: cloneConfig(this.state.settings),
      session,
    }
    this.notice = null
    this.persist(true)
    this.render()
    this.focusPracticeInput()
  }

  private restartSession(): void {
    const config = this.state.session?.config ?? this.state.settings
    this.state = {
      ...this.state,
      view: 'practice',
      settings: cloneConfig(config),
      session: createTrainingSession(config, this.createSeed(), this.now()),
    }
    this.notice = null
    this.persist(true)
    this.render()
    this.focusPracticeInput()
  }

  private resumeSavedSession(): void {
    if (!this.state.session || this.state.session.completedAt !== null) return
    this.state = {
      ...this.state,
      view: 'practice',
      session: resumeSession(this.state.session, this.now()),
    }
    this.notice = null
    this.persist(true)
    this.render()
    this.focusPracticeInput()
  }

  private saveAndExit(): void {
    if (!this.state.session) return
    this.state = {
      ...this.state,
      view: 'setup',
      session: pauseSession(this.state.session, this.now()),
    }
    this.notice = { message: 'Session saved on this device.', tone: 'info' }
    this.persist(true)
    this.render()
    this.focusCurrentView()
  }

  private discardSession(): void {
    this.state = { ...this.state, view: 'setup', session: null }
    this.notice = { message: 'Saved session discarded. Your settings are still here.', tone: 'info' }
    this.persist(true)
    this.render()
    this.focusCurrentView()
  }

  private changeSettings(): void {
    this.state = { ...this.state, view: 'setup', session: null }
    this.notice = null
    this.persist(true)
    this.render()
    this.focusCurrentView()
  }

  private goHome(): void {
    if (this.state.view === 'practice') {
      this.saveAndExit()
    } else if (this.state.view === 'complete') {
      this.changeSettings()
    } else {
      document.getElementById('setup-heading')?.focus()
    }
  }

  private submitCurrentAnswer(): void {
    const session = this.state.session
    if (!session) return
    const current = session.progress[session.currentIndex]
    if (!current) return

    if (current.status === 'pending') {
      const checkedSession = checkCurrentAnswer(session)
      if (checkedSession === session) return
      this.state = { ...this.state, session: checkedSession }
      this.persist(true)
      this.render()
      const checkedProgress = checkedSession.progress[checkedSession.currentIndex]
      if (checkedProgress?.status === 'pending') {
        this.focusAnswerInput(true)
      } else {
        document.getElementById('primary-action')?.focus()
      }
      return
    }

    const advanced = advanceSession(session, this.now())
    this.state = {
      ...this.state,
      view: advanced.completedAt === null ? 'practice' : 'complete',
      session: advanced,
    }
    this.persist(true)
    this.render()
    this.focusCurrentView()
  }

  private confirmReveal(): void {
    if (!this.state.session) return
    this.state = { ...this.state, session: revealCurrentAnswer(this.state.session) }
    this.persist(true)
    this.render()
    document.getElementById('primary-action')?.focus()
  }

  private useKeypad(key: string): void {
    if (!this.state.session) return
    if (/^\d$/.test(key)) {
      this.updateSession((session) => appendCurrentDigit(session, key))
    } else if (key === 'delete') {
      this.updateSession(deleteCurrentDigit)
    } else if (key === 'clear') {
      this.updateSession(clearCurrentDraft)
    }
    this.syncAnswerControls()
    this.persist()
    this.focusAnswerInput(false)
  }

  private setQuestionCount(value: string, trigger: HTMLElement): void {
    const count = Number(value)
    if (!Number.isInteger(count) || count < 1 || count > 50) return
    this.state = { ...this.state, settings: { ...this.state.settings, problemCount: count } }
    this.persist()
    this.render()
    window.requestAnimationFrame(() => {
      this.root.querySelector<HTMLElement>(`[data-action="question-count"][data-value="${count}"]`)?.focus()
    })
    void trigger
  }

  private updateSession(update: (session: TrainingSession) => TrainingSession): void {
    if (!this.state.session) return
    this.state = { ...this.state, session: update(this.state.session) }
  }

  private syncAnswerControls(): void {
    const session = this.state.session
    if (!session) return
    const progress = session.progress[session.currentIndex]
    const input = this.root.querySelector<HTMLInputElement>('#answer-input')
    const primary = this.root.querySelector<HTMLButtonElement>('#primary-action')
    const feedback = this.root.querySelector<HTMLElement>('#answer-feedback')
    const inputWrap = this.root.querySelector<HTMLElement>('.answer-input-wrap')
    if (!progress || !input || !primary || !feedback || !inputWrap) return

    input.value = progress.draft
    primary.disabled = progress.draft === ''
    feedback.className = `answer-feedback answer-feedback--${progress.feedback}`
    feedback.innerHTML = feedbackMarkup(progress.feedback, session.problems[session.currentIndex]?.answer ?? '')
    inputWrap.classList.toggle('answer-input-wrap--error', progress.feedback === 'incorrect')
  }

  private updateQuestionCountPresets(): void {
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-action="question-count"]')) {
      const active = Number(button.dataset.value) === this.state.settings.problemCount
      button.classList.toggle('preset--active', active)
      button.setAttribute('aria-pressed', String(active))
    }
  }

  private updateTimerText(): void {
    const timer = this.root.querySelector<HTMLElement>('#elapsed-time')
    if (timer && this.state.session) timer.textContent = formatDuration(getElapsedMs(this.state.session, this.now()))
  }

  private persist(force = false): void {
    const now = this.now()
    if (!force && now - this.lastPersistedAt < 250) return
    this.lastPersistedAt = now

    const saved = this.store.save(this.state, now)
    if (!saved && !this.storageWarningShown) {
      this.storageWarningShown = true
      this.notice = {
        message: 'Progress cannot be saved on this device. Practice still works in this tab.',
        tone: 'warning',
      }
      this.announce(this.notice.message)
    }
  }

  private hasActiveSession(): boolean {
    return Boolean(this.state.session && this.state.session.completedAt === null)
  }

  private focusCurrentView(): void {
    if (this.state.view === 'practice') {
      this.focusPracticeInput()
    } else if (this.state.view === 'complete') {
      window.requestAnimationFrame(() => document.getElementById('completion-heading')?.focus())
    } else {
      window.requestAnimationFrame(() => document.getElementById('setup-heading')?.focus())
    }
  }

  private focusPracticeInput(): void {
    const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false
    if (coarsePointer) {
      window.requestAnimationFrame(() => document.getElementById('problem-heading')?.focus())
    } else {
      this.focusAnswerInput(false)
    }
  }

  private focusAnswerInput(select: boolean): void {
    window.requestAnimationFrame(() => {
      const input = this.root.querySelector<HTMLInputElement>('#answer-input')
      if (!input || input.readOnly) return
      input.focus({ preventScroll: true })
      if (select) input.select()
    })
  }

  private openDialog(id: string, trigger?: HTMLElement): void {
    const dialog = document.getElementById(id)
    if (!(dialog instanceof HTMLDialogElement)) return
    if (trigger?.id) dialog.dataset.returnFocus = trigger.id
    try {
      dialog.showModal()
    } catch {
      dialog.setAttribute('open', '')
    }
  }

  private announce(message: string): void {
    const status = this.root.querySelector<HTMLElement>('#global-status')
    if (status) status.textContent = message
  }
}

function createDefaultAppState(): PersistedAppState {
  return {
    schemaVersion: APP_SCHEMA_VERSION,
    view: 'setup',
    settings: cloneConfig(DEFAULT_CONFIG),
    session: null,
  }
}

function cloneConfig(config: TrainingConfig): TrainingConfig {
  return { ...config, operations: [...config.operations] }
}

function renderExpression(problem: TrainingSession['problems'][number]): string {
  const pieces = problem.operands
    .map((operand, index) => {
      const operation = problem.operators[index]
      return `<span class="expression__operand">${escapeHtml(operand)}</span>${
        operation
          ? `<span class="expression__operator expression__operator--${operation}">${OPERATION_DETAILS[operation].symbol}</span>`
          : ''
      }`
    })
    .join('')

  return `
    <div class="expression" role="img" aria-label="${escapeHtml(speakExpression(problem))}">
      <span class="expression__pieces" aria-hidden="true">${pieces}</span>
      <span class="expression__equals" aria-hidden="true">= ?</span>
    </div>
  `
}

function feedbackMarkup(feedback: string, answer: string): string {
  if (feedback === 'incorrect') {
    return '<span class="feedback-icon" aria-hidden="true">×</span><span><strong>Not quite.</strong> Check the expression and try again.</span>'
  }
  if (feedback === 'correct') {
    return '<span class="feedback-icon" aria-hidden="true">✓</span><span><strong>Correct.</strong> Nice work — keep going.</span>'
  }
  if (feedback === 'revealed') {
    return `<span class="feedback-icon" aria-hidden="true">i</span><span><strong>Answer revealed:</strong> ${escapeHtml(answer)}</span>`
  }
  return ''
}

function keypadButton(
  accessibleLabel: string,
  key: string,
  locked: boolean,
  className = '',
  visibleLabel = accessibleLabel,
): string {
  return `<button class="keypad-key ${className}" type="button" data-action="keypad" data-key="${key}" aria-label="${accessibleLabel}" ${disabled(locked)}>${visibleLabel}</button>`
}

function dialogMarkup(
  id: string,
  title: string,
  description: string,
  cancelLabel: string,
  confirmLabel: string,
  action: string,
  danger: boolean,
): string {
  return `
    <dialog id="${id}" class="confirm-dialog" aria-labelledby="${id}-title" aria-describedby="${id}-description">
      <form method="dialog">
        <div class="dialog-icon ${danger ? 'dialog-icon--warning' : ''}" aria-hidden="true">${danger ? '!' : '?'}</div>
        <h2 id="${id}-title">${title}</h2>
        <p id="${id}-description">${description}</p>
        <div class="dialog-actions">
          <button class="button button--secondary" value="cancel">${cancelLabel}</button>
          <button class="button ${danger ? 'button--danger' : 'button--primary'}" type="button" data-action="${action}">${confirmLabel}</button>
        </div>
      </form>
    </dialog>
  `
}

function settingsSeed(config: TrainingConfig): number {
  const operationValue = config.operations.reduce(
    (value, operation) => value * 5 + OPERATIONS.indexOf(operation) + 1,
    17,
  )
  return (
    config.minDigits * 1_000_003 +
    config.maxDigits * 100_003 +
    config.operatorCount * 10_007 +
    config.problemCount * 101 +
    operationValue +
    (config.operationMode === 'mixed' ? 7_919 : 0)
  )
}

function digitRangeDescription(config: TrainingConfig): string {
  if (config.minDigits === config.maxDigits) {
    const min = 10 ** (config.minDigits - 1)
    const max = 10 ** config.maxDigits - 1
    return `${config.minDigits}-digit numbers: ${formatNumber(min)} to ${formatNumber(max)}.`
  }
  const min = 10 ** (config.minDigits - 1)
  const max = 10 ** config.maxDigits - 1
  return `${config.minDigits}–${config.maxDigits} digit numbers: ${formatNumber(min)} to ${formatNumber(max)}.`
}

function digitRangeShort(config: TrainingConfig): string {
  return config.minDigits === config.maxDigits
    ? `${config.minDigits}-digit`
    : `${config.minDigits}–${config.maxDigits} digits`
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}

function checked(value: boolean): string {
  return value ? 'checked' : ''
}

function selected(value: boolean): string {
  return value ? 'selected' : ''
}

function disabled(value: boolean): string {
  return value ? 'disabled' : ''
}

function readonly(value: boolean): string {
  return value ? 'readonly' : ''
}

function pluralize(count: number, word: string): string {
  return count === 1 ? word : `${word}s`
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;',
      })[character] ?? character,
  )
}
