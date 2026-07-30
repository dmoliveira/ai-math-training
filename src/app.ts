import {
  DEFAULT_CONFIG,
  OPERATIONS,
  OPERATION_DETAILS,
  createRandomSeed,
  formatExpression,
  generateProblems,
  speakExpression,
  validateConfig,
  type ChallengeLevel,
  type Operation,
  type TrainingConfig,
} from './math/engine'
import {
  advanceSession,
  appendCurrentDigit,
  checkCurrentAnswer,
  clearCurrentDraft,
  createReviewSession,
  createProblemReviewSession,
  createTrainingSession,
  deleteCurrentDigit,
  formatDuration,
  getCurrentProblemElapsedMs,
  getElapsedMs,
  pauseSession,
  resumeSession,
  restartReviewSession,
  revealCurrentAnswer,
  setCurrentDraft,
  skipCurrentProblem,
  summarizeSession,
  type TrainingSession,
} from './state/session'
import { DEFAULT_PREFERENCES, configKey, effectiveOrientation, type AudioCue, type AudioPort, type SharePort } from './sprint/contracts'
import { SynthAudio } from './sprint/audio'
import { BrowserShare, createSocialShareLinks } from './sprint/share'
import { createSharePayload, createSprintResult, rankResults, type ResultStore, type SprintResult } from './sprint/results'
import { PRACTICE_PRESETS, deriveLearningMilestones, deriveNextMission, matchingPresetId, practicePreset } from './sprint/guidance'
import { createSprintDebrief, selectHistoricalFocus, type DebriefItem } from './sprint/debrief'
import { IndexedDbResultStore } from './storage/result-store'
import { icon } from './ui/icons'
import {
  APP_SCHEMA_VERSION,
  ProgressStore,
  type PersistedAppState,
  type StoreLoadResult,
} from './storage/progress-store'

const PUBLIC_APP_URL = 'https://dmoliveira.github.io/mental-math-sprint/'

type StorePort = Pick<ProgressStore, 'load' | 'save' | 'clear' | 'clearAll'>

export interface AppDependencies {
  store?: StorePort
  now?: () => number
  createSeed?: () => number
  audio?: AudioPort
  resultStore?: ResultStore
  share?: SharePort
}

interface Notice {
  message: string
  tone: 'info' | 'warning'
}

interface HistoryViewState {
  configKey: string
  status: 'loading' | 'ok' | 'error'
  results: SprintResult[]
  ranked: SprintResult[]
  recentResults: SprintResult[]
  nextCursor: string | null
}

type MotionEvent = 'setup-enter' | 'practice-enter' | 'question-enter' | 'incorrect' | 'correct' | 'skip' | 'reveal' | 'resume-enter' | 'completion-enter'

interface MotionIntent {
  event: MotionEvent
  progressFrom?: number
  progressTo?: number
}

type SetupDestination = 'practice' | 'progress'

export class MathTrainingApp {
  private readonly root: HTMLElement
  private readonly store: StorePort
  private readonly now: () => number
  private readonly createSeed: () => number
  private readonly audio: AudioPort
  private readonly resultStore: ResultStore
  private readonly share: SharePort
  private audioUnlocked = false
  private audioUnlockPromise: Promise<boolean> | null = null
  private pendingAudioCue: AudioCue | null = null
  private audioCycle = 0
  private historyGeneration = 0
  private history: HistoryViewState | null = null
  private currentResult: SprintResult | null = null
  private sharePending = false
  private readonly announcer: HTMLParagraphElement
  private state: PersistedAppState
  private notice: Notice | null = null
  private timerId: number | null = null
  private announcementTimerId: number | null = null
  private autoAdvanceTimerId: number | null = null
  private autoAdvanceGeneration = 0
  private lastPersistedAt = 0
  private storageWarningShown = false
  private started = false
  private setupDestination: SetupDestination = 'practice'
  private customizeSetupOpen = false
  private advancedSetupOpen = false
  private pendingResultSave: Promise<void> | null = null

  constructor(root: HTMLElement, dependencies: AppDependencies = {}) {
    this.root = root
    this.store = dependencies.store ?? new ProgressStore()
    this.now = dependencies.now ?? Date.now
    this.createSeed = dependencies.createSeed ?? createRandomSeed
    this.audio = dependencies.audio ?? new SynthAudio()
    this.resultStore = dependencies.resultStore ?? new IndexedDbResultStore()
    this.share = dependencies.share ?? new BrowserShare()
    this.announcer = document.createElement('p')
    this.announcer.id = 'app-announcer'
    this.announcer.className = 'sr-only app-announcer'
    this.announcer.setAttribute('role', 'status')
    this.announcer.setAttribute('aria-atomic', 'true')
    this.state = createDefaultAppState()
  }

  start(): void {
    if (this.started) return
    this.started = true

    this.restore(this.store.load())
    if (this.state.session?.completedAt !== null && this.state.session?.mode === 'sprint') this.currentResult = createSprintResult(this.state.session)
    this.applyAppearance()
    if (!this.announcer.isConnected) this.root.insertAdjacentElement('afterend', this.announcer)
    this.root.addEventListener('click', this.handleClick)
    this.root.addEventListener('change', this.handleChange)
    this.root.addEventListener('input', this.handleInput)
    this.root.addEventListener('submit', this.handleSubmit)
    this.root.addEventListener('keydown', this.handleKeydown)
    this.root.addEventListener('toggle', this.handleToggle, true)
    document.addEventListener('keydown', this.handleAppearanceEscape, true)
    document.addEventListener('pointerdown', this.handleAppearancePointerDown)
    document.addEventListener('visibilitychange', this.handleVisibilityChange)
    window.addEventListener('beforeunload', this.handleBeforeUnload)
    this.timerId = window.setInterval(this.handleTimerTick, 250)

    this.render(this.state.view === 'setup' ? { event: 'setup-enter' } : this.state.view === 'practice' ? { event: 'practice-enter' } : undefined)
    if (this.currentResult) this.queueCompletedResultSave(this.currentResult)
    else if (!(this.state.view !== 'setup' && this.state.session?.mode === 'review')) void this.refreshHistory()
    if (this.state.view !== 'setup') this.orientCurrentView()
  }

  destroy(): void {
    if (!this.started) return
    this.persist(true)
    this.root.removeEventListener('click', this.handleClick)
    this.root.removeEventListener('change', this.handleChange)
    this.root.removeEventListener('input', this.handleInput)
    this.root.removeEventListener('submit', this.handleSubmit)
    this.root.removeEventListener('keydown', this.handleKeydown)
    this.root.removeEventListener('toggle', this.handleToggle, true)
    document.removeEventListener('keydown', this.handleAppearanceEscape, true)
    document.removeEventListener('pointerdown', this.handleAppearancePointerDown)
    document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    window.removeEventListener('beforeunload', this.handleBeforeUnload)
    if (this.timerId !== null) window.clearInterval(this.timerId)
    if (this.announcementTimerId !== null) window.clearTimeout(this.announcementTimerId)
    this.cancelAutoAdvance()
    this.timerId = null
    this.announcementTimerId = null
    this.announcer.textContent = ''
    this.announcer.remove()
    this.suspendAudio()
    this.historyGeneration += 1
    delete document.documentElement.dataset.theme
    delete document.documentElement.dataset.density
    delete this.root.dataset.view
    delete this.root.dataset.motion
    this.root.style.removeProperty('--progress-from')
    this.root.style.removeProperty('--progress-to')
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
      case 'show-practice':
        this.openSetupDestination('practice')
        break
      case 'show-progress':
      case 'view-progress':
        this.openSetupDestination('progress')
        break
      case 'show-customize':
        this.customizeSetupOpen = true
        this.openSetupDestination('practice')
        break
      case 'toggle-setup-disclosure': {
        const details = actionElement.closest<HTMLDetailsElement>('details')
        if (details?.id === 'customize-setup') this.customizeSetupOpen = !details.open
        if (details?.id === 'advanced-setup') this.advancedSetupOpen = !details.open
        break
      }
      case 'resume-session':
        this.resumeSavedSession()
        break
      case 'open-discard':
        this.openDialog('discard-dialog')
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
        this.cancelAutoAdvance()
        this.openDialog('restart-dialog')
        break
      case 'confirm-restart':
        this.restartSession()
        break
      case 'skip':
        this.skipQuestion()
        break
      case 'open-reveal':
        this.openDialog('reveal-dialog')
        break
      case 'confirm-reveal':
        this.confirmReveal()
        break
      case 'keypad':
        this.useKeypad(actionElement.dataset.key ?? '', actionElement)
        break
      case 'question-count':
        this.setQuestionCount(actionElement.dataset.value ?? '', actionElement)
        break
      case 'start-preset': {
        const preset = practicePreset(actionElement.dataset.preset ?? '')
        if (preset) this.requestSprintStart(preset.config)
        break
      }
      case 'start-current-setup':
        this.requestSprintStart(this.state.settings)
        break
      case 'start-next-mission': {
        const session = this.state.session
        const mission = session ? deriveNextMission(session) : null
        if (mission?.kind === 'stretch') this.requestSprintStart(mission.config)
        break
      }
      case 'practice-again':
        this.restartSession()
        break
      case 'start-review':
        this.startReviewSession()
        break
      case 'start-history-review':
        this.startHistoricalReviewSession()
        break
      case 'change-settings':
        this.changeSettings()
        break
      case 'cycle-theme':
        this.setAppearance({ theme: this.state.preferences.theme === 'forest' ? 'midnight' : 'forest' })
        break
      case 'toggle-density':
        this.setAppearance({ density: this.state.preferences.density === 'compact' ? 'comfortable' : 'compact' })
        break
      case 'toggle-auto-advance':
        this.toggleAutoAdvance()
        break
      case 'toggle-timers':
        this.toggleTimerVisibility()
        break
      case 'share-result':
        void this.shareCurrentResult(false)
        break
      case 'copy-result':
        void this.shareCurrentResult(true)
        break
      case 'load-history':
        void this.loadMoreHistory()
        break
      case 'show-reset':
        this.openDialog('reset-history-dialog')
        break
      case 'confirm-reset-history':
        void this.resetHistory()
        break
      default:
        break
    }
  }

  private readonly handleToggle = (event: Event): void => {
    const details = event.target
    if (!(details instanceof HTMLDetailsElement)) return
    if (details.id === 'customize-setup') this.customizeSetupOpen = details.open
    if (details.id === 'advanced-setup') this.advancedSetupOpen = details.open
  }

  private readonly handleAppearanceEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    const menu = this.root.querySelector<HTMLDetailsElement>('.appearance-menu[open]')
    if (!menu) return
    event.preventDefault()
    event.stopPropagation()
    menu.open = false
    menu.querySelector<HTMLElement>('summary')?.focus()
  }

  private readonly handleAppearancePointerDown = (event: PointerEvent): void => {
    const menu = this.root.querySelector<HTMLDetailsElement>('.appearance-menu[open]')
    if (!menu || (event.target instanceof Node && menu.contains(event.target))) return
    menu.open = false
  }

  private readonly handleChange = (event: Event): void => {
    const target = event.target
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return
    if (!target.closest('#setup-form')) return

    if (['orientation', 'audioEnabled', 'theme', 'density', 'autoAdvance', 'hideTimers'].includes(target.name)) {
      const preferences = { ...this.state.preferences }
      if (target.name === 'orientation') {
        preferences.orientation = target.value === 'vertical' ? 'vertical' : 'horizontal'
        this.announce(`${preferences.orientation === 'vertical' ? 'Vertical' : 'Horizontal'} layout selected.`)
      } else if (target.name === 'theme') {
        preferences.theme = target.value === 'midnight' ? 'midnight' : 'forest'
        this.announce(`${preferences.theme === 'midnight' ? 'Midnight' : 'Forest'} theme selected.`)
      } else if (target.name === 'density') {
        preferences.density = target instanceof HTMLInputElement && target.checked ? 'compact' : 'comfortable'
        this.announce(`${preferences.density === 'compact' ? 'Compact' : 'Comfortable'} layout selected.`)
      } else if (target.name === 'autoAdvance' && target instanceof HTMLInputElement) {
        preferences.autoAdvance = target.checked
        this.announce(`Automatic next question ${target.checked ? 'on' : 'off'}.`)
      } else if (target.name === 'hideTimers' && target instanceof HTMLInputElement) {
        preferences.hideTimers = target.checked
        this.announce(`Live timers ${target.checked ? 'hidden' : 'shown'}.`)
      } else if (target instanceof HTMLInputElement) {
        preferences.audioEnabled = target.checked
        if (target.checked) void this.enableAudio()
        else {
          this.suspendAudio()
          this.announce('Sound cues off.')
        }
      }
      this.state = { ...this.state, preferences }
      this.applyAppearance()
      this.persist(true)
      this.render()
      window.requestAnimationFrame(() => document.getElementById(target.id)?.focus())
      return
    }

    if (target.name === 'problemCount') {
      const value = Number(target.value)
      if (!Number.isInteger(value) || value < 1 || value > 50) return
      this.state = { ...this.state, settings: { ...this.state.settings, problemCount: value } }
      this.persist()
      this.updateQuestionCountPresets()
      this.updatePracticePresetSelection()
      this.updateSetupExample()
      void this.refreshHistory(this.state.settings)
      return
    }

    const next = cloneConfig(this.state.settings)
    const focusId = target.id
    let announcement: string | null = null

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
    } else if (target.name === 'challenge') {
      next.challenge = parseChallengeLevel(target.value)
    } else {
      return
    }

    if (next.operationMode === 'mixed' && (next.operations.length < 2 || next.operatorCount < 2)) {
      next.operationMode = 'same'
      this.notice = {
        message: 'Mixed mode needs at least two operations and two operator positions, so Same mode is active.',
        tone: 'info',
      }
      announcement = this.notice.message
    }

    this.state = { ...this.state, settings: next }
    this.persist()
    this.render()
    void this.refreshHistory()
    if (announcement) this.announce(announcement)
    window.requestAnimationFrame(() => document.getElementById(focusId)?.focus())
  }

  private readonly handleInput = (event: Event): void => {
    const target = event.target
    if (!(target instanceof HTMLInputElement)) return

    if (target.id === 'answer-input') {
      const session = this.state.session
      if (!session) return
      const updated = setCurrentDraft(session, target.value)
      if (updated !== session) {
        this.playCue(updated.progress[updated.currentIndex]!.draft.length < session.progress[session.currentIndex]!.draft.length ? 'erase' : 'type')
      }
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
        this.persist()
        this.updateQuestionCountPresets()
        this.updatePracticePresetSelection()
        this.updateSetupExample()
        void this.refreshHistory(this.state.settings)
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
        this.openDialog('replace-dialog')
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
      if (this.updateSession(clearCurrentDraft)) this.playCue('erase')
      this.syncAnswerControls()
      this.persist()
    } else if (event.key === '-') {
      event.preventDefault()
      if (this.updateSession(deleteCurrentDigit)) this.playCue('erase')
      this.syncAnswerControls()
      this.persist()
    }
  }

  private readonly handleVisibilityChange = (): void => {
    const session = this.state.session
    if (!session || this.state.view !== 'practice' || session.completedAt !== null) return

    if (document.visibilityState === 'hidden') {
      this.cancelAutoAdvance()
      this.suspendAudio()
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
      } else if (this.state.view === 'practice' && document.visibilityState === 'visible') {
        this.state = { ...this.state, session: resumeSession(session, this.now()) }
      } else if (this.state.view === 'complete') {
        this.state = { ...this.state, view: 'setup' }
      }
      return
    }

    if (result.status === 'invalid') {
      this.store.clearAll()
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

  private render(intent?: MotionIntent): void {
    this.root.dataset.view = this.state.view
    this.root.dataset.section = this.state.view === 'setup' ? this.setupDestination : this.state.view
    this.root.dataset.motion = intent?.event ?? 'settled'
    if (intent?.progressFrom !== undefined && intent.progressTo !== undefined) {
      this.root.style.setProperty('--progress-from', `${intent.progressFrom}%`)
      this.root.style.setProperty('--progress-to', `${intent.progressTo}%`)
    } else {
      this.root.style.removeProperty('--progress-from')
      this.root.style.removeProperty('--progress-to')
    }
    const content =
      this.state.view === 'practice' && this.state.session
        ? this.renderPractice(this.state.session)
        : this.state.view === 'complete' && this.state.session
          ? this.renderCompletion(this.state.session)
          : this.renderSetup()

    this.root.innerHTML = `
      <a class="skip-link" href="#main-content">Skip to main content</a>
      ${this.renderHeader()}
      <div id="global-status" class="global-status">
        ${this.notice ? this.renderNotice(this.notice) : ''}
      </div>
      ${content}
      <aside class="support-card" aria-labelledby="support-heading">
        <div><p class="step-label">Keep practice accessible</p><h2 id="support-heading">Support this free project</h2><p>Every practice feature stays free. Optional contributions help maintain and improve the app.</p></div>
        <a class="button button--secondary" href="https://buy.stripe.com/8x200i8bSgVe3Vl3g8bfO00" target="_blank" rel="noopener noreferrer">${icon('heart')} Support via Stripe <span class="sr-only">(opens in a new tab)</span></a>
        <small>Stripe handles payment details under its own privacy terms. No practice data is sent.</small>
      </aside>
      <footer class="site-footer">
        <p><span aria-hidden="true">🔒</span> Settings and completed history stay in this browser. No account or tracking.</p>
        <nav class="footer-links" aria-label="Project and creator links">
          <a href="https://dmoliveira.github.io/my-cv-public/cv/human/" target="_blank" rel="noopener noreferrer">Bio<span class="sr-only"> (opens in a new tab)</span></a>
          <a href="https://github.com/dmoliveira" target="_blank" rel="noopener noreferrer">GitHub<span class="sr-only"> (opens in a new tab)</span></a>
          <a href="https://www.linkedin.com/in/dmztheone/" target="_blank" rel="noopener noreferrer">LinkedIn<span class="sr-only"> (opens in a new tab)</span></a>
          <a href="https://github.com/dmoliveira/mental-math-sprint" target="_blank" rel="noopener noreferrer">View source<span class="sr-only"> (opens in a new tab)</span></a>
        </nav>
      </footer>
    `
  }

  private applyAppearance(): void {
    document.documentElement.dataset.theme = this.state.preferences.theme
    document.documentElement.dataset.density = this.state.preferences.density
  }

  private setAppearance(update: Partial<Pick<typeof this.state.preferences, 'theme' | 'density'>>): void {
    this.state = { ...this.state, preferences: { ...this.state.preferences, ...update } }
    this.applyAppearance()
    this.persist(true)
    this.render()
    window.requestAnimationFrame(() => this.root.querySelector<HTMLElement>('.appearance-menu > summary')?.focus())
    if (update.theme) this.announce(`${update.theme === 'midnight' ? 'Midnight' : 'Forest'} theme selected.`)
    if (update.density) this.announce(`${update.density === 'compact' ? 'Compact' : 'Comfortable'} layout selected.`)
  }

  private renderHeader(): string {
    const reviewing = this.state.session?.mode === 'review'
    const activeDestination = this.state.view === 'practice' ? 'practice' : this.state.view === 'setup' ? this.setupDestination : null
    const practiceActions =
      this.state.view === 'practice'
        ? `<div class="header-actions">
            <button class="button button--quiet button--compact restart-action" type="button" data-action="open-restart" aria-label="Restart ${reviewing ? 'review' : 'session'}">
              <span class="restart-action__icon" aria-hidden="true">↻</span><span class="restart-action__label">Restart</span>
            </button>
            <button class="button button--secondary button--compact" type="button" data-action="save-exit">
              Save &amp; exit
            </button>
          </div>`
        : ''

    return `
      <header class="site-header">
        <div class="site-header__inner">
          <button class="brand" type="button" data-action="home" aria-label="Mental Math Sprint home">
            <span class="brand__mark" aria-hidden="true">
              <span>+</span><span>×</span>
            </span>
            <span class="brand__name">Mental Math Sprint</span>
          </button>
          <nav class="app-nav" aria-label="Primary navigation">
            <button type="button" data-action="show-practice" ${activeDestination === 'practice' ? 'aria-current="page"' : ''}>Practice</button>
            <button type="button" data-action="show-progress" ${activeDestination === 'progress' ? 'aria-current="page"' : ''}>Progress</button>
          </nav>
          <details class="appearance-menu">
            <summary aria-label="Appearance settings">${icon(this.state.preferences.theme === 'forest' ? 'sun' : 'moon')}<span>Appearance</span></summary>
            <div class="appearance-menu__panel">
              <button type="button" role="switch" data-action="cycle-theme" aria-checked="${this.state.preferences.theme === 'midnight'}">${icon(this.state.preferences.theme === 'forest' ? 'moon' : 'sun')}<span><strong>Dark theme</strong><small>Lower-light colours</small></span><b class="preference-switch" aria-hidden="true"><i></i></b></button>
              <button type="button" role="switch" data-action="toggle-density" aria-checked="${this.state.preferences.density === 'compact'}">${icon(this.state.preferences.density === 'compact' ? 'comfortable' : 'compact')}<span><strong>Compact layout</strong><small>Tighter spacing</small></span><b class="preference-switch" aria-hidden="true"><i></i></b></button>
            </div>
          </details>
          ${practiceActions}
        </div>
      </header>
    `
  }

  private renderSetup(): string {
    if (this.setupDestination === 'progress') return this.renderProgress()
    const config = this.state.settings
    const errors = validateConfig(config)
    const canMix = config.operations.length >= 2 && config.operatorCount >= 2
    const example = this.renderExample(config, errors)
    const resumeCard = this.hasActiveSession() && this.state.session ? this.renderResumeCard(this.state.session) : ''
    const customizeOpen = this.customizeSetupOpen || errors.length > 0
    const advancedOpen = this.advancedSetupOpen || errors.length > 0

    return `
      <main id="main-content" class="page-shell setup-page">
        <section class="setup-hero" aria-labelledby="setup-heading">
          <div><p class="eyebrow"><span aria-hidden="true">✦</span> Focused arithmetic practice</p><h1 id="setup-heading" tabindex="-1">Start a sprint in seconds.</h1><p class="lede">Use your setup or pick a guided challenge. Everything stays private in this browser.</p></div>
          <img class="numi numi--setup numi--pose-ready" src="${numiSrc('ready')}" alt="" width="512" height="512" aria-hidden="true" />
        </section>

        <div class="setup-column">
          ${resumeCard}
          <div id="welcome-back-host">${this.renderWelcomeBack()}</div>
          <form id="setup-form" class="settings-card setup-launch-card" novalidate>
            <div class="card-heading">
              <div>
                <p class="step-label">Your current setup</p>
                <h2>Ready when you are</h2>
              </div>
              <span class="privacy-pill"><span aria-hidden="true">●</span> Private</span>
            </div>

            <div class="setup-summary"><p>${escapeHtml(formatConfigSummary(config))}</p><span>${escapeHtml(challengeDescription(config.challenge))}</span></div>
            <button class="button button--primary button--large setup-start" type="submit" ${disabled(errors.length > 0)}>Start sprint <span aria-hidden="true">→</span></button>

            <details id="customize-setup" class="setup-disclosure" ${customizeOpen ? 'open' : ''}>
              <summary data-action="toggle-setup-disclosure"><span>Customize setup</span><small>Operations, number size, questions, challenge, and sprint behaviour.</small></summary>
              <div class="setup-disclosure__body">

            <fieldset class="setting-group">
              <legend>Operations</legend>
              <p class="field-hint">Pick one or more skills to practise.</p>
              <div class="operation-grid">
                ${OPERATIONS.map((operation) => this.renderOperationChoice(operation, config)).join('')}
              </div>
            </fieldset>

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
              <legend>Questions this session</legend>
              <div class="question-count-row">
                <label class="number-field" for="problem-count"><span class="number-field__label">Custom</span><input id="problem-count" name="problemCount" type="number" min="1" max="50" step="1" value="${config.problemCount}" inputmode="numeric" /></label>
                <div class="preset-row" aria-label="Quick question counts">${[5, 10, 20, 30].map((count) => `<button class="preset ${config.problemCount === count ? 'preset--active' : ''}" type="button" data-action="question-count" data-value="${count}" aria-pressed="${config.problemCount === count}">${count}</button>`).join('')}</div>
              </div>
              <p class="selection-note">Choose any amount from 1 to 50.</p>
            </fieldset>

            <details id="advanced-setup" class="setup-disclosure setup-disclosure--nested" ${advancedOpen ? 'open' : ''}>
              <summary data-action="toggle-setup-disclosure"><span>More sprint options</span><small>Challenge, expression pattern, layout, sound, and timers.</small></summary>
              <div class="setup-disclosure__body">

            <section class="setup-option-section" aria-labelledby="question-design-heading">
              <div class="setup-option-section__heading"><h3 id="question-design-heading">Question design</h3><p>Shape the difficulty and structure of each expression.</p></div>

            <fieldset class="setting-group challenge-setting">
              <legend>Challenge path</legend>
              <p class="field-hint">Levels choose progressively tougher questions within your number and operation settings.</p>
              <div class="challenge-grid">
                ${CHALLENGE_OPTIONS.map((option) => `<label class="challenge-card"><input type="radio" name="challenge" value="${option.value}" ${checked(config.challenge === option.value)} /><span><b>${escapeHtml(option.title)}</b><small>${escapeHtml(option.detail)}</small></span></label>`).join('')}
              </div>
              <p class="selection-note">${escapeHtml(challengeDescription(config.challenge))}</p>
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

            </section>

            <section class="setup-option-section" aria-labelledby="practice-experience-heading">
              <div class="setup-option-section__heading"><h3 id="practice-experience-heading">Practice experience</h3><p>Choose how a sprint looks, moves, and feels.</p></div>

            <fieldset class="setting-group">
              <legend>Experience</legend>
              <p class="field-hint">Choose how your sprint looks, fits, and sounds.</p>
              <div class="practice-options">
                <div>
                  <span class="number-field__label">Problem layout</span>
                  <div class="segmented-control">
                    <label><input id="layout-horizontal" type="radio" name="orientation" value="horizontal" ${checked(this.state.preferences.orientation === 'horizontal')} /><span>Horizontal</span></label>
                    <label><input id="layout-vertical" type="radio" name="orientation" value="vertical" ${checked(this.state.preferences.orientation === 'vertical')} /><span>Vertical</span></label>
                  </div>
                  <p class="selection-note">Vertical stacks one-operation questions. Chained questions stay horizontal.</p>
                </div>
                <label class="sound-option" for="audio-enabled">
                  <input id="audio-enabled" type="checkbox" name="audioEnabled" ${checked(this.state.preferences.audioEnabled)} />
                  <span><strong>Play sound cues</strong><small>Optional feedback sounds; every result also appears on screen.</small></span>
                </label>
                <label class="sound-option" for="auto-advance">
                  <input id="auto-advance" type="checkbox" name="autoAdvance" ${checked(this.state.preferences.autoAdvance)} />
                  <span><strong>Move on after correct answers</strong><small>Shows success briefly, then opens the next question automatically. You can turn this off during a sprint.</small></span>
                </label>
                <label class="sound-option" for="hide-timers">
                  <input id="hide-timers" type="checkbox" name="hideTimers" ${checked(this.state.preferences.hideTimers)} />
                  <span><strong>Hide timers while solving</strong><small>Timing still records privately and appears in your debrief. This does not make the sprint untimed.</small></span>
                </label>
              </div>
            </fieldset>

            </section>

              </div>
            </details>

            <div id="setup-example-host">${example}</div>
            ${errors.length > 0 ? this.renderConfigErrors(errors) : ''}
            <div class="setup-customize-action"><div><strong>Ready to practise?</strong><small>Use every setting above.</small></div><button class="button button--primary" type="submit" ${disabled(errors.length > 0)}>Start with these settings <span aria-hidden="true">→</span></button></div>
              </div>
            </details>
            <p class="keyboard-note"><span aria-hidden="true">⌨</span> Built for keyboard and number-pad practice.</p>
          </form>
          ${this.renderPracticePresets()}
        </div>

        ${this.renderSetupDialogs()}
      </main>
    `
  }

  private renderProgress(): string {
    return `
      <main id="main-content" class="page-shell progress-page">
        <section class="progress-intro" aria-labelledby="progress-heading">
          <div><p class="eyebrow"><span aria-hidden="true">↗</span> Private progress</p><h1 id="progress-heading" tabindex="-1">See what your practice is building.</h1><p class="lede">Results are grouped by your exact setup and stay on this device.</p></div>
        </section>
        <div id="progress-context-host">${this.renderProgressContext()}</div>
        <div id="history-card-host">${this.renderHistoryCard()}</div>
        ${this.renderSetupDialogs()}
      </main>`
  }

  private renderPracticePresets(): string {
    const selectedPreset = matchingPresetId(this.state.settings)
    return `
      <section class="practice-presets" aria-labelledby="practice-presets-heading">
        <div class="practice-presets__intro"><p class="step-label">Guided challenges</p><h2 id="practice-presets-heading">Pick a ready-made sprint</h2><p>Each choice sets every option and starts immediately.</p></div>
        <div class="practice-preset-grid">
          ${PRACTICE_PRESETS.map((preset) => {
            const active = selectedPreset === preset.id
            return `<button class="practice-preset ${active ? 'practice-preset--active' : ''}" type="button" data-action="start-preset" data-preset="${preset.id}" aria-pressed="${active}"><span>${escapeHtml(preset.eyebrow)}</span><strong>${escapeHtml(preset.title)}</strong><small>${escapeHtml(preset.description)}</small><b>${active ? 'Matches your setup · Start' : 'Start'} <span aria-hidden="true">→</span></b></button>`
          }).join('')}
        </div>
      </section>`
  }

  private renderProgressContext(): string {
    const key = configKey(this.state.settings)
    const snapshot = this.history?.configKey === key ? this.history : null
    if (snapshot?.status === 'ok' && snapshot.results.length === 0) return ''
    return `<section class="progress-context" aria-label="Progress filter"><div><span>Showing exact setup</span><strong>${escapeHtml(formatConfigSummary(this.state.settings))}</strong></div><button class="button button--quiet" type="button" data-action="show-customize">Change setup</button></section>`
  }

  private renderWelcomeBack(): string {
    if (this.hasActiveSession()) return ''
    const key = configKey(this.state.settings)
    const snapshot = this.history?.configKey === key ? this.history : null
    if (!snapshot || snapshot.status === 'loading') return '<aside class="welcome-back"><p>Looking up this exact setup on your device…</p></aside>'
    if (snapshot.status !== 'ok' || snapshot.results.length === 0) return ''
    const recent = snapshot.results[0]!
    const best = snapshot.ranked[0]
    return `<aside class="welcome-back" aria-labelledby="welcome-back-heading"><div><p class="step-label">Welcome back</p><h2 id="welcome-back-heading">Continue this exact setup</h2><p>Most recent: ${recent.totals.accuracyPercent}% first-try accuracy in ${formatDuration(recent.totals.scoredElapsedMs)} on ${escapeHtml(formatResultDate(recent.completedAt))}.${best ? ` Personal best: ${formatDuration(best.totals.scoredElapsedMs)}.` : ' No ranked result is available yet.'}</p><small>${escapeHtml(formatConfigSummary(this.state.settings))}</small></div><button class="button button--primary" type="button" data-action="start-current-setup">Start this setup <span aria-hidden="true">→</span></button></aside>`
  }

  private renderResumeCard(session: TrainingSession): string {
    const summary = summarizeSession(session, this.now())
    const reviewing = session.mode === 'review'
    return `
      <aside class="resume-card" aria-labelledby="resume-title">
        <div class="resume-card__icon" aria-hidden="true">▶</div>
        <div class="resume-card__copy">
          <p class="step-label">${reviewing ? 'Unscored review saved' : 'Saved on this device'}</p>
          <h2 id="resume-title">Continue your ${reviewing ? 'review' : 'session'}</h2>
          <p>Question ${session.currentIndex + 1} of ${session.problems.length} · ${summary.mistakes} ${pluralize(summary.mistakes, reviewing ? 'extra attempt' : 'mistake')} · ${formatDuration(summary.elapsedMs)}</p>
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
        <aside class="example-card example-card--unavailable">
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
        'reset-history-dialog',
        'Reset performance history?',
        'Completed results for the current arithmetic settings will be permanently deleted. Your settings and active session stay intact.',
        'Keep history',
        'Reset history',
        'confirm-reset-history',
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
    const progressValue = session.progress.filter((item) => item.status !== 'pending').length
    const percent = Math.round((progressValue / session.problems.length) * 100)
    const questionElapsed = getCurrentProblemElapsedMs(session, this.now())
    const reviewing = session.mode === 'review'
    const pose = mascotPose(progress)

    return `
      <main id="main-content" class="page-shell practice-page">
        <section class="session-toolbar" aria-label="Session progress">
          ${reviewing ? '<p class="review-mode-badge"><span aria-hidden="true">↺</span> Mistake-to-mastery review · Unscored</p>' : ''}
          <div class="progress-copy">
            <span>Question <strong>${session.currentIndex + 1}</strong> of ${session.problems.length} · ${percent}% complete</span>
            <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="${session.problems.length}" aria-valuenow="${progressValue}" aria-label="Session completion" aria-valuetext="${progressValue} of ${session.problems.length} questions complete, ${percent} percent">
              <span style="width: ${(progressValue / session.problems.length) * 100}%"></span>
            </div>
          </div>
          <div class="session-quick-controls">
            <button class="auto-next-toggle" type="button" data-action="toggle-auto-advance" aria-label="Auto-next ${this.state.preferences.autoAdvance ? 'On' : 'Off'}" aria-pressed="${this.state.preferences.autoAdvance}"><span aria-hidden="true">${this.state.preferences.autoAdvance ? '⚡' : 'Ⅱ'}</span><span>Auto-next <strong>${this.state.preferences.autoAdvance ? 'On' : 'Off'}</strong></span></button>
            <button class="timer-visibility-toggle" type="button" data-action="toggle-timers" aria-label="Timers ${this.state.preferences.hideTimers ? 'Hidden' : 'Shown'}" aria-pressed="${this.state.preferences.hideTimers}"><span aria-hidden="true">${this.state.preferences.hideTimers ? '◌' : '◷'}</span><span>Timers <strong>${this.state.preferences.hideTimers ? 'Hidden' : 'Shown'}</strong></span></button>
          </div>
          <dl class="session-metrics">
            <div><dt>Session time</dt><dd id="elapsed-time">${this.state.preferences.hideTimers ? 'Hidden' : formatDuration(getElapsedMs(session, this.now()))}</dd></div>
            <div><dt>This question</dt><dd id="question-time">${this.state.preferences.hideTimers ? 'Hidden' : questionElapsed === null ? '—' : formatDuration(questionElapsed)}</dd></div>
            <div><dt>${reviewing ? 'Extra attempts' : 'Mistakes'}</dt><dd>${session.mistakes}</dd></div>
          </dl>
        </section>

        <ol class="question-trail" aria-label="Question status">
          ${session.progress
            .map((item, index) => {
              const stateLabel =
                item.status === 'correct'
                  ? 'correct'
                  : item.status === 'skipped'
                    ? reviewing ? 'skipped' : 'skipped, 20-second penalty'
                    : item.status === 'revealed'
                    ? 'revealed'
                    : index === session.currentIndex
                      ? 'current'
                      : 'not answered'
              return `<li class="question-dot question-dot--${item.status} ${index === session.currentIndex ? 'question-dot--current' : ''}" aria-label="Question ${index + 1}: ${stateLabel}"><span>${item.status === 'correct' ? '✓' : item.status === 'skipped' ? '—' : item.status === 'revealed' ? '•' : index + 1}</span></li>`
            })
            .join('')}
        </ol>

        <article class="practice-card" aria-labelledby="problem-heading">
          <div class="problem-panel">
            <p class="step-label">${reviewing ? 'Review question' : 'Question'} ${session.currentIndex + 1}</p>
            <h1 id="problem-heading" class="problem-heading" tabindex="-1">Solve the expression</h1>
            ${renderExpression(problem, this.state.preferences.orientation)}

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
                  ${progress.feedback === 'incorrect' ? 'aria-invalid="true"' : ''}
                  ${readonly(locked)}
                />
                ${locked ? `<span class="answer-lock" aria-label="Answer locked">${progress.status === 'correct' ? '✓' : '●'}</span>` : ''}
              </div>
              <p id="answer-help" class="answer-help">Type, use the keypad, or press <kbd>Enter</kbd> to check. <kbd>−</kbd> deletes; <kbd>×</kbd> clears.</p>
              <div id="answer-feedback" class="answer-feedback answer-feedback--${progress.feedback}">
                ${feedbackMarkup(progress.feedback, problem.answer, reviewing)}
              </div>

              <div class="practice-actions">
                <button id="primary-action" class="button button--primary button--large" type="submit" ${disabled(!locked && progress.draft === '')}>
                  ${locked ? (isLast ? (reviewing ? 'Finish review' : 'See results') : 'Next question') : 'Check answer'} <span aria-hidden="true">${locked ? '→' : '✓'}</span>
                </button>
                ${
                  locked
                    ? ''
                    : `<div class="secondary-actions"><button class="button button--quiet" type="button" data-action="open-reveal">Reveal answer</button><button class="button button--quiet" type="button" data-action="skip">Skip question${reviewing ? '' : ' (+20s)'}</button></div>`
                }
              </div>
            </form>
          </div>

          <div class="keypad-panel" aria-label="Number keypad">
            <div class="mascot-coach mascot-coach--${mascotMood(progress)}">
              <img class="numi numi--coach numi--pose-${pose}" src="${numiSrc(pose)}" alt="" width="512" height="512" aria-hidden="true" />
              <p><strong>Numi</strong><span>${escapeHtml(mascotMessage(progress, reviewing))}</span></p>
            </div>
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
          `Restart this ${reviewing ? 'review' : 'session'}?`,
          reviewing ? 'Your answers and time will reset, but these exact review questions will stay.' : 'Your current answers and time will be replaced with new questions using the same settings.',
          'Keep practising',
          reviewing ? 'Restart review' : 'Restart session',
          'confirm-restart',
          true,
        )}
      </main>
    `
  }

  private renderCompletion(session: TrainingSession): string {
    if (session.mode === 'review') return this.renderReviewCompletion(session)
    const summary = summarizeSession(session, this.now())
    const perfect = summary.mistakes === 0 && summary.revealed === 0 && summary.skipped === 0
    const completionPose: NumiPose = perfect ? 'celebration' : 'encouraging'

    return `
      <main id="main-content" class="page-shell completion-page">
        <section class="completion-card" aria-labelledby="completion-heading">
          <div class="celebration" aria-hidden="true">
            <span class="celebration__ring"></span>
            <span class="celebration__mark">✓</span>
            ${Array.from({ length: 8 }, (_, index) => `<i style="--i: ${index}"></i>`).join('')}
          </div>
          <img class="numi numi--completion numi--pose-${completionPose}" src="${numiSrc(completionPose)}" alt="" width="512" height="512" aria-hidden="true" />
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
              <dt>Scored time</dt>
              <dd>${formatDuration(summary.scoredElapsedMs)}<small>${formatDuration(summary.elapsedMs)} active + ${formatDuration(summary.penaltyMs)} penalties</small></dd>
            </div>
          </dl>
          ${this.renderSprintNextStep(session)}
          <details class="completion-more">
            <summary><span>More from this sprint</span><small>Question evidence, milestones, rankings, and sharing</small></summary>
            <div class="completion-more__body">
              ${this.renderSprintDebrief(session)}
              ${this.renderLearningMilestones(session)}
              <div id="completion-ranking-host">${this.renderCompletionRanking(session)}</div>
              ${this.renderShareCard(session)}
            </div>
          </details>
          <p class="completion-note"><span aria-hidden="true">🌱</span> A little consistent practice makes big numbers feel smaller.</p>
        </section>
      </main>
    `
  }

  private renderReviewCompletion(session: TrainingSession): string {
    const summary = summarizeSession(session, this.now())
    const firstTry = session.progress.filter((item) => item.status === 'correct' && item.attempts === 1).length
    const corrected = session.progress.filter((item) => item.status === 'correct' && item.attempts > 1).length
    const unresolved = session.progress.filter((item) => item.status === 'skipped' || item.status === 'revealed').length
    const reviewPose: NumiPose = firstTry === summary.total ? 'celebration' : 'encouraging'
    const coaching = unresolved > 0
      ? `${unresolved} ${pluralize(unresolved, 'question')} still need attention. Review the answers, then try this same set once more.`
      : corrected > 0
        ? `You recovered every question. Repeat the set once more and aim for ${session.problems.length} first-try answers.`
        : 'Every review question landed on the first try. Return to a sprint and carry that confidence forward.'
    return `
      <main id="main-content" class="page-shell completion-page review-completion-page">
        <section class="completion-card" aria-labelledby="completion-heading">
          <img class="numi numi--completion numi--pose-${reviewPose}" src="${numiSrc(reviewPose)}" alt="" width="512" height="512" aria-hidden="true" />
          <p class="eyebrow"><span aria-hidden="true">↺</span> Unscored mastery round</p>
          <h1 id="completion-heading" tabindex="-1">Review complete.</h1>
          <p class="completion-lede">You revisited the exact questions that slowed you down. That focused repetition is where fluency grows.</p>
          <dl class="results-grid results-grid--review">
            <div class="result-card result-card--primary"><dt>First-try mastered</dt><dd>${firstTry}<small>of ${summary.total} review questions</small></dd></div>
            <div class="result-card"><dt>Corrected after retry</dt><dd>${corrected}<small>worked through successfully</small></dd></div>
            <div class="result-card"><dt>Still unresolved</dt><dd>${unresolved}<small>skipped or revealed</small></dd></div>
            <div class="result-card"><dt>Active review time</dt><dd>${formatDuration(summary.elapsedMs)}<small>unscored practice</small></dd></div>
          </dl>
          ${this.renderReviewNextStep(session)}
          <details class="completion-more">
            <summary><span>More from this review</span><small>Coaching notes and milestones</small></summary>
            <div class="completion-more__body">
              <section class="training-insight training-insight--review" aria-labelledby="review-coaching-heading"><p class="step-label">Review insight</p><h2 id="review-coaching-heading">Keep the learning loop going</h2><p>${escapeHtml(coaching)}</p></section>
              ${this.renderLearningMilestones(session)}
            </div>
          </details>
          <p class="completion-note"><span aria-hidden="true">🔒</span> Review rounds stay resumable on this device but never affect rankings or history.</p>
        </section>
      </main>`
  }

  private renderLearningMilestones(session: TrainingSession): string {
    const milestones = deriveLearningMilestones(session)
    if (milestones.length === 0) return ''
    return `<section class="learning-milestones" aria-labelledby="milestones-heading"><p class="step-label">Milestones from this round</p><h2 id="milestones-heading">Progress worth noticing</h2><ul>${milestones.map((milestone) => `<li><span aria-hidden="true">✦</span><div><strong>${escapeHtml(milestone.title)}</strong><p>${escapeHtml(milestone.detail)}</p></div></li>`).join('')}</ul><p class="field-hint">Milestones describe this completed round; they are not streaks or points.</p></section>`
  }

  private renderSprintNextStep(session: TrainingSession): string {
    const debrief = createSprintDebrief(session)
    if (!debrief) return ''
    const focusCount = debrief.focusItems.length
    const mission = deriveNextMission(session)
    const primary = focusCount > 0
      ? `<button class="button button--primary button--large" type="button" data-action="start-review">Review ${focusCount === 1 ? 'this question' : `these ${focusCount} questions`} <span aria-hidden="true">→</span></button>`
      : mission?.kind === 'stretch'
        ? '<button class="button button--primary button--large" type="button" data-action="start-next-mission">Try a one-step stretch <span aria-hidden="true">→</span></button>'
        : '<button class="button button--primary button--large" type="button" data-action="practice-again">Sprint again <span aria-hidden="true">↻</span></button>'
    const explanation = focusCount > 0
      ? `${focusCount} ${pluralize(focusCount, 'question')} may benefit from a short, private review.`
      : mission?.kind === 'stretch'
        ? mission.detail
        : 'Repeat this setup while the rhythm is fresh.'
    const repeat = focusCount > 0 || mission?.kind === 'stretch' ? '<button class="button button--secondary" type="button" data-action="practice-again">Sprint again</button>' : ''
    return `<section class="completion-next" aria-labelledby="next-step-heading"><div><p class="step-label">Recommended next</p><h2 id="next-step-heading">${focusCount > 0 ? 'Turn friction into fluency' : mission?.kind === 'stretch' ? 'Build on this run' : 'Keep the rhythm'}</h2><p>${escapeHtml(explanation)}</p></div><div class="completion-next__primary">${primary}</div><div class="completion-next__secondary">${repeat}<button class="button button--quiet" type="button" data-action="change-settings">Change settings</button><button class="button button--quiet" type="button" data-action="view-progress">View progress</button></div></section>`
  }

  private renderReviewNextStep(session: TrainingSession): string {
    return `<section class="completion-next" aria-labelledby="next-step-heading"><div><p class="step-label">Recommended next</p><h2 id="next-step-heading">Repeat the exact review</h2><p>One more pass helps make these ${session.problems.length} ${pluralize(session.problems.length, 'question')} feel automatic.</p></div><div class="completion-next__primary"><button class="button button--primary button--large" type="button" data-action="practice-again">Review again <span aria-hidden="true">↻</span></button></div><div class="completion-next__secondary"><button class="button button--secondary" type="button" data-action="change-settings">Start another sprint</button><button class="button button--quiet" type="button" data-action="view-progress">View progress</button></div></section>`
  }

  private renderSprintDebrief(session: TrainingSession): string {
    const debrief = createSprintDebrief(session)
    if (!debrief) return ''
    const hasFocus = debrief.focusItems.length > 0
    const focus = debrief.focusItems[0]
    const summary = hasFocus
      ? `${debrief.firstTry} of ${debrief.total} answers were correct on the first try. ${debrief.focusItems.length} ${pluralize(debrief.focusItems.length, 'question')} may be useful to revisit.`
      : `All ${debrief.total} answers were correct on the first try.`
    const evidence = focus
      ? this.renderDebriefFocus(focus)
      : debrief.longest
        ? `<div class="debrief-focus"><p class="step-label">Longest solve</p><strong aria-label="${escapeHtml(`${speakExpression(debrief.longest.problem)} equals ${debrief.longest.problem.answer}`)}">${escapeHtml(formatExpression(debrief.longest.problem))} = ${escapeHtml(debrief.longest.problem.answer)}</strong><span>Active time ${formatOptionalDuration(debrief.longest.activeElapsedMs)}</span></div>`
        : ''
    return `<section class="sprint-debrief" aria-labelledby="debrief-heading"><div class="debrief-summary"><div><p class="step-label">Sprint evidence</p><h2 id="debrief-heading">${hasFocus ? `Focus on ${debrief.focusItems.length} ${pluralize(debrief.focusItems.length, 'question')}` : 'A clean set'}</h2><p>${escapeHtml(summary)}</p></div>${evidence}</div>${this.renderQuestionBreakdown(debrief.items)}</section>`
  }

  private renderDebriefFocus(item: DebriefItem): string {
    return `<div class="debrief-focus debrief-focus--attention"><p class="step-label">Question ${item.index + 1} · Review focus</p><strong aria-label="${escapeHtml(`${speakExpression(item.problem)} equals ${item.problem.answer}`)}">${escapeHtml(formatExpression(item.problem))} = ${escapeHtml(item.problem.answer)}</strong><span>${escapeHtml(item.outcomeLabel)}</span><span>Active time ${formatOptionalDuration(item.activeElapsedMs)}</span></div>`
  }

  private renderQuestionBreakdown(items: readonly DebriefItem[]): string {
    return `<details class="question-breakdown"><summary>Question breakdown (${items.length})</summary><ol>${items.map((item) => `<li><div><span class="step-label">Question ${item.index + 1}${item.reviewFocus ? ' · Review focus' : ''}</span><strong aria-label="${escapeHtml(`${speakExpression(item.problem)} equals ${item.problem.answer}`)}">${escapeHtml(formatExpression(item.problem))} = ${escapeHtml(item.problem.answer)}</strong></div><div class="breakdown-evidence"><span>${escapeHtml(item.outcomeLabel)}</span><span>Active time ${formatOptionalDuration(item.activeElapsedMs)}</span></div></li>`).join('')}</ol></details>`
  }

  private renderHistoryCard(): string {
    const key = configKey(this.state.settings)
    const snapshot = this.history?.configKey === key ? this.history : null
    if (!snapshot || snapshot.status === 'loading') return this.historyMessage('Loading results…')
    if (snapshot.status === 'error') return this.historyMessage('History is unavailable. Practice still works normally.', true)
    if (snapshot.results.length === 0) return `<section class="history-card history-empty" aria-labelledby="history-heading"><p class="step-label">Private on this device</p><h2 id="history-heading" tabindex="-1">No results for this setup yet</h2><p>Complete one sprint to begin a private comparison for this exact setup.</p><div class="history-empty__setup"><span>Current setup</span><strong>${escapeHtml(formatConfigSummary(this.state.settings))}</strong></div><div class="history-empty__actions"><button class="button button--primary" type="button" data-action="start-current-setup">Start this setup</button><button class="button button--quiet" type="button" data-action="show-customize">Change setup</button></div></section>`
    const latest = snapshot.results[0]!
    const best = snapshot.ranked[0]
    const dashboard = `<section class="progress-snapshot" aria-labelledby="snapshot-heading"><p class="step-label">${snapshot.results.length === 1 ? 'First result' : 'Recent snapshot'}</p><h3 id="snapshot-heading">${snapshot.results.length === 1 ? 'Your baseline is ready' : 'At a glance'}</h3><dl><div><dt>Sprints · last 7 days</dt><dd>${snapshot.recentResults.length}</dd></div><div><dt>Fastest scored time</dt><dd>${best ? progressDuration(best.totals.scoredElapsedMs) : 'Not ranked yet'}</dd></div><div><dt>Latest first-try accuracy</dt><dd>${latest.totals.accuracyPercent}%</dd></div></dl></section>`
    const rows = `<ol class="history-list">${snapshot.results.map((result) => { const absolute = formatResultDate(result.completedAt); return `<li><time datetime="${new Date(result.completedAt).toISOString()}" title="${escapeHtml(absolute)}" aria-label="${escapeHtml(absolute)}">${escapeHtml(formatProgressDate(result.completedAt, this.now()))}</time><strong>${progressDuration(result.totals.scoredElapsedMs)}</strong><span>${result.totals.accuracyPercent}% · ${result.totals.skipped} skipped</span></li>` }).join('')}</ol>`
    const historicalFocus = this.hasActiveSession() ? [] : selectHistoricalFocus(snapshot.results, this.state.settings)
    const focusPractice = historicalFocus.length === 0 ? '' : `<aside class="history-focus"><div><p class="step-label">Private focus practice</p><h3>Revisit past questions</h3><p>${historicalFocus.length} ${pluralize(historicalFocus.length, 'question')} from this exact setup were previously retried, skipped, or revealed.</p></div><button class="button button--primary" type="button" data-action="start-history-review">Practice past focus questions</button></aside>`
    return `<section class="history-card" aria-labelledby="history-heading"><p class="step-label">Private on this device</p><h2 id="history-heading" tabindex="-1">Performance history</h2>${dashboard}${focusPractice}<h3>Full history</h3>${rows}<div class="history-actions">${snapshot.nextCursor ? '<button class="button button--secondary" type="button" data-action="load-history">Load more</button>' : ''}<button class="button button--quiet" type="button" data-action="show-reset">Reset this history</button></div></section>`
  }

  private historyMessage(message: string, canReset = false): string {
    return `<section class="history-card"><p class="step-label">Private on this device</p><h2>Performance history</h2><p>${escapeHtml(message)}</p>${canReset ? '<button class="button button--quiet" type="button" data-action="show-reset">Reset this history</button>' : ''}</section>`
  }
  private renderCompletionRanking(session: TrainingSession): string {
    const result = this.currentResult ?? createSprintResult(session)
    if (!result) return ''
    const snapshot = this.history?.configKey === result.configKey ? this.history : null
    if (!snapshot || snapshot.status === 'loading') return '<section class="ranking-card"><p>Saving your private result…</p></section>'
    if (snapshot.status === 'error') return '<section class="ranking-card"><p>Your result is complete, but private rankings are unavailable.</p></section>'
    const ranked = rankResults([...snapshot.ranked.filter((item) => item.id !== result.id), result], 5)
    const isBest = result.rankEligible && ranked[0]?.id === result.id
    return `<section class="ranking-card" aria-labelledby="ranking-heading"><div class="history-heading"><h2 id="ranking-heading">Personal top five</h2>${isBest ? '<span class="best-badge">New best</span>' : ''}</div>${result.rankEligible ? '' : '<p>Revealed-answer sessions are not ranked.</p>'}<ol>${ranked.map((item) => `<li class="${item.id === result.id ? 'ranking-current' : ''}"><span>${item.id === result.id ? 'This run' : escapeHtml(formatResultDate(item.completedAt))}</span><strong>${formatDuration(item.totals.scoredElapsedMs)}</strong><small>${item.totals.mistakes} mistakes · ${item.totals.skipped} skipped</small></li>`).join('')}</ol></section>`
  }
  private async persistCompletedResult(result: SprintResult): Promise<void> {
    const generation = ++this.historyGeneration
    const write = await this.resultStore.saveCompleted(result)
    if (!this.started) return
    if (write.status !== 'saved' && write.status !== 'duplicate') {
      if (generation === this.historyGeneration) {
        this.history = { configKey: result.configKey, status: 'error', results: [], ranked: [], recentResults: [], nextCursor: null }
        this.syncHistorySurfaces()
      }
      this.announce('This result could not be saved to private history. Your completed session is still available now.')
      return
    }
    if (generation !== this.historyGeneration) return
    await this.refreshHistory(result.config)
  }

  private queueCompletedResultSave(result: SprintResult): void {
    const pending = this.persistCompletedResult(result)
    this.pendingResultSave = pending
    void pending.finally(() => {
      if (this.pendingResultSave === pending) this.pendingResultSave = null
    })
  }

  private async refreshHistory(config: TrainingConfig = this.state.view === 'complete' && this.state.session ? this.state.session.config : this.state.settings): Promise<void> {
    const key = configKey(config)
    const generation = ++this.historyGeneration
    this.history = { configKey: key, status: 'loading', results: [], ranked: [], recentResults: [], nextCursor: null }
    this.syncHistorySurfaces()
    const since = Math.max(0, this.now() - 7 * 24 * 60 * 60 * 1_000)
    const [page, ranked, recent] = await Promise.all([this.resultStore.listCompleted(key, undefined, 25), this.resultStore.listRanked(key, 5), this.resultStore.listCompletedSince(key, since)])
    if (!this.started || generation !== this.historyGeneration) return
    const corruptRecords = page.corruptRecords + ranked.corruptRecords + recent.corruptRecords
    if (page.status !== 'ok' || ranked.status !== 'ok' || recent.status !== 'ok' || page.truncated || ranked.truncated || recent.truncated || corruptRecords > 0) {
      this.history = { configKey: key, status: 'error', results: [], ranked: [], recentResults: [], nextCursor: null }
      if (corruptRecords > 0) this.announce('Some private history data could not be read. Reset this history to remove damaged records.')
    } else this.history = { configKey: key, status: 'ok', results: page.results, ranked: ranked.results, recentResults: recent.results, nextCursor: page.nextCursor }
    this.syncHistorySurfaces()
  }

  private async loadMoreHistory(): Promise<void> {
    const snapshot = this.history
    if (!snapshot?.nextCursor || snapshot.status !== 'ok') return
    const generation = ++this.historyGeneration
    const page = await this.resultStore.listCompleted(snapshot.configKey, snapshot.nextCursor, 25)
    if (!this.started || generation !== this.historyGeneration || page.status !== 'ok') return
    if (page.corruptRecords > 0 || page.truncated) {
      this.history = { configKey: snapshot.configKey, status: 'error', results: [], ranked: [], recentResults: [], nextCursor: null }
      this.announce('Some private history data could not be read. Reset this history to remove damaged records.')
      this.syncHistorySurfaces()
      return
    }
    this.history = { ...snapshot, results: [...snapshot.results, ...page.results.filter((item) => !snapshot.results.some((seen) => seen.id === item.id))], nextCursor: page.nextCursor }
    this.syncHistorySurfaces()
  }

  private async resetHistory(): Promise<void> {
    const config = cloneConfig(this.state.settings)
    const generation = ++this.historyGeneration
    const result = await this.resultStore.clearConfig(configKey(config))
    if (!this.started || generation !== this.historyGeneration) return
    if (result.status !== 'cleared') { this.announce('Performance history could not be reset.'); return }
    const dialog = document.getElementById('reset-history-dialog')
    if (dialog instanceof HTMLDialogElement && dialog.open) dialog.close()
    this.announce('Performance history reset for these settings.')
    await this.refreshHistory(config)
    this.root.querySelector<HTMLElement>('#history-card-host #history-heading')?.focus({ preventScroll: true })
  }

  private syncHistorySurfaces(): void {
    const welcome = this.root.querySelector<HTMLElement>('#welcome-back-host')
    if (welcome) welcome.innerHTML = this.renderWelcomeBack()
    const setup = this.root.querySelector<HTMLElement>('#history-card-host')
    if (setup) setup.innerHTML = this.renderHistoryCard()
    const progressContext = this.root.querySelector<HTMLElement>('#progress-context-host')
    if (progressContext) progressContext.innerHTML = this.renderProgressContext()
    const ranking = this.root.querySelector<HTMLElement>('#completion-ranking-host')
    if (ranking && this.state.session) ranking.innerHTML = this.renderCompletionRanking(this.state.session)
  }
  private renderShareCard(session: TrainingSession): string {
    const result = this.currentResult ?? createSprintResult(session)
    if (!result) return ''
    const payload = createSharePayload(result, canonicalAppUrl())
    const links = createSocialShareLinks(payload)
    return `<section class="share-card" aria-labelledby="share-heading"><p class="step-label">Celebrate your progress</p><h2 id="share-heading">Share this result</h2><p>Only your aggregate score, accuracy, skips, operations, and app link are shared.</p><div class="share-actions"><button class="button button--primary" type="button" data-action="share-result">${icon('share')} Share</button><button class="button button--secondary" type="button" data-action="copy-result">${icon('copy')} Copy result</button></div><nav class="social-links" aria-label="Share on social networks"><a href="${escapeHtml(links.x)}" target="_blank" rel="noopener noreferrer">X<span class="sr-only"> (opens in a new tab)</span></a><a href="${escapeHtml(links.facebook)}" target="_blank" rel="noopener noreferrer">Facebook<span class="sr-only"> (opens in a new tab)</span></a><a href="${escapeHtml(links.linkedIn)}" target="_blank" rel="noopener noreferrer">LinkedIn<span class="sr-only"> (opens in a new tab)</span></a></nav><p class="field-hint">For Instagram, choose it from your device Share menu, or copy the result and paste it into a post.</p></section>`
  }

  private async shareCurrentResult(copyOnly: boolean): Promise<void> {
    const session = this.state.session
    const result = this.currentResult ?? (session ? createSprintResult(session) : null)
    if (!result || this.sharePending) return
    this.sharePending = true
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-action="share-result"], [data-action="copy-result"]')) button.disabled = true
    const payload = createSharePayload(result, canonicalAppUrl())
    let outcome: 'shared' | 'copied' | 'cancelled' | 'unavailable'
    try {
      outcome = copyOnly ? await this.share.copy(payload) : await this.share.share(payload)
    } catch {
      outcome = 'unavailable'
    } finally {
      this.sharePending = false
      for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-action="share-result"], [data-action="copy-result"]')) button.disabled = false
    }
    const message = outcome === 'shared' ? 'Result shared.' : outcome === 'copied' ? 'Result copied.' : outcome === 'cancelled' ? 'Sharing cancelled.' : 'Sharing is unavailable on this device.'
    this.announce(message)
  }
  private renderNotice(notice: Notice): string {
    return `<div class="notice notice--${notice.tone}"><span aria-hidden="true">${notice.tone === 'warning' ? '!' : 'i'}</span><p>${escapeHtml(notice.message)}</p></div>`
  }

  private startNewSession(): void {
    this.cancelAutoAdvance()
    const errors = validateConfig(this.state.settings)
    if (errors.length > 0) return

    const session = createTrainingSession(this.state.settings, this.createSeed(), this.now())
    this.currentResult = null
    this.state = {
      schemaVersion: APP_SCHEMA_VERSION,
      view: 'practice',
      settings: cloneConfig(this.state.settings),
      preferences: { ...this.state.preferences },
      session,
    }
    this.notice = null
    this.persist(true)
    this.render({ event: 'practice-enter' })
    this.orientCurrentView()
  }

  private requestSprintStart(config: TrainingConfig): void {
    if (validateConfig(config).length > 0) return
    this.state = { ...this.state, settings: cloneConfig(config) }
    this.persist(true)
    if (this.hasActiveSession()) {
      this.openDialog('replace-dialog')
      return
    }
    this.startNewSession()
  }

  private restartSession(): void {
    this.cancelAutoAdvance()
    const current = this.state.session
    const config = current?.config ?? this.state.settings
    const session = current?.mode === 'review'
      ? restartReviewSession(current, this.now())
      : createTrainingSession(config, this.createSeed(), this.now())
    this.currentResult = null
    this.state = {
      ...this.state,
      view: 'practice',
      settings: current?.mode === 'review' ? this.state.settings : cloneConfig(config),
      session,
    }
    this.notice = null
    this.persist(true)
    this.render({ event: 'practice-enter' })
    this.orientCurrentView()
  }

  private startReviewSession(): void {
    this.cancelAutoAdvance()
    const source = this.state.session
    if (!source || source.mode !== 'sprint' || source.completedAt === null) return
    const review = createReviewSession(source, this.now())
    if (!review) return
    this.historyGeneration += 1
    this.currentResult = null
    this.history = null
    this.state = { ...this.state, view: 'practice', session: review }
    this.notice = null
    this.persist(true)
    this.render({ event: 'practice-enter' })
    this.announce(`Focused review started with ${review.problems.length} ${pluralize(review.problems.length, 'question')}. This round is unscored.`)
    this.orientCurrentView()
  }

  private startHistoricalReviewSession(): void {
    const key = configKey(this.state.settings)
    const snapshot = this.history?.configKey === key ? this.history : null
    if (this.state.view !== 'setup' || this.hasActiveSession() || !snapshot || snapshot.status !== 'ok') return
    const focus = selectHistoricalFocus(snapshot.results, this.state.settings)
    if (focus.length === 0) return
    const review = createProblemReviewSession(this.state.settings, this.createSeed(), focus.map((item) => item.problem), this.now())
    if (!review) return
    this.cancelAutoAdvance()
    this.historyGeneration += 1
    this.currentResult = null
    this.history = null
    this.state = { ...this.state, view: 'practice', session: review }
    this.notice = null
    this.persist(true)
    this.render({ event: 'practice-enter' })
    this.announce(`Private focus review started with ${review.problems.length} ${pluralize(review.problems.length, 'question')}. This round is unscored.`)
    this.orientCurrentView()
  }

  private resumeSavedSession(): void {
    this.cancelAutoAdvance()
    if (!this.state.session || this.state.session.completedAt !== null) return
    this.state = {
      ...this.state,
      view: 'practice',
      session: resumeSession(this.state.session, this.now()),
    }
    this.notice = null
    this.persist(true)
    this.render({ event: 'resume-enter' })
    this.orientCurrentView()
  }

  private saveAndExit(): void {
    this.cancelAutoAdvance()
    this.suspendAudio()
    if (!this.state.session) return
    this.state = {
      ...this.state,
      view: 'setup',
      session: pauseSession(this.state.session, this.now()),
    }
    this.setupDestination = 'practice'
    const saved = this.persist(true)
    this.notice = saved
      ? { message: 'Session saved on this device.', tone: 'info' }
      : {
          message: 'Progress cannot be saved on this device. Practice still works in this tab.',
          tone: 'warning',
        }
    this.render({ event: 'resume-enter' })
    void this.refreshHistory()
    this.announce(this.notice.message)
    this.orientCurrentView()
  }

  private discardSession(): void {
    this.cancelAutoAdvance()
    this.suspendAudio()
    this.currentResult = null
    this.setupDestination = 'practice'
    this.state = { ...this.state, view: 'setup', session: null }
    this.notice = { message: 'Saved session discarded. Your settings are still here.', tone: 'info' }
    this.persist(true)
    this.render({ event: 'setup-enter' })
    void this.refreshHistory()
    this.orientCurrentView()
  }

  private changeSettings(): void {
    this.cancelAutoAdvance()
    this.suspendAudio()
    this.currentResult = null
    this.setupDestination = 'practice'
    this.customizeSetupOpen = true
    this.state = { ...this.state, view: 'setup', session: null }
    this.notice = null
    this.persist(true)
    this.render({ event: 'setup-enter' })
    void this.refreshHistory()
    this.orientCurrentView()
  }

  private goHome(): void {
    this.openSetupDestination('practice')
  }

  private openSetupDestination(destination: SetupDestination): void {
    if (this.state.view === 'setup' && this.setupDestination === destination) {
      this.orientCurrentView()
      return
    }
    this.cancelAutoAdvance()
    this.suspendAudio()
    const session = this.state.session
    const settings = this.state.view === 'complete' && session?.mode === 'sprint' ? cloneConfig(session.config) : this.state.settings
    const resumable = session?.completedAt === null
      ? this.state.view === 'practice' ? pauseSession(session, this.now()) : session
      : null
    this.state = { ...this.state, view: 'setup', settings, session: resumable }
    this.setupDestination = destination
    this.notice = null
    if (destination === 'practice' && !resumable) this.currentResult = null
    this.persist(true)
    this.render({ event: 'setup-enter' })
    const pending = this.pendingResultSave
    if (destination === 'progress') {
      if (pending) {
        void pending.then(() => {
          if (!this.started || this.state.view !== 'setup' || this.setupDestination !== 'progress') return
          if (this.history?.configKey !== configKey(settings)) void this.refreshHistory(settings)
        })
      } else if (this.history?.configKey !== configKey(settings)) void this.refreshHistory(settings)
    }
    this.orientCurrentView()
  }

  private submitCurrentAnswer(): void {
    const session = this.state.session
    if (!session) return
    const current = session.progress[session.currentIndex]
    if (!current) return

    if (current.status === 'pending') {
      const checkedSession = checkCurrentAnswer(session, this.now())
      if (checkedSession === session) return
      this.playCue('submit')
      this.state = { ...this.state, session: checkedSession }
      this.playCue(checkedSession.progress[checkedSession.currentIndex]?.status === 'pending' ? 'incorrect' : 'correct')
      this.persist(true)
      const progressFrom = completionPercent(session)
      const progressTo = completionPercent(checkedSession)
      this.render({ event: checkedSession.progress[checkedSession.currentIndex]?.status === 'pending' ? 'incorrect' : 'correct', progressFrom, progressTo })
      const checkedProgress = checkedSession.progress[checkedSession.currentIndex]
      if (checkedProgress?.status === 'pending') {
        this.announce('Incorrect. Try again.')
        this.focusAnswerInput(true)
      } else {
        const isLast = checkedSession.currentIndex === checkedSession.problems.length - 1
        this.announce(this.state.preferences.autoAdvance ? 'Correct. Moving to the next question.' : `Correct. ${isLast ? 'See your results.' : 'Next question.'}`)
        document.getElementById('primary-action')?.focus()
        if (this.state.preferences.autoAdvance) this.scheduleAutoAdvance(checkedSession)
      }
      return
    }

    this.advanceCurrentQuestion()
  }

  private advanceCurrentQuestion(): void {
    this.cancelAutoAdvance()
    const session = this.state.session
    if (!session || this.state.view !== 'practice' || session.completedAt !== null) return
    const progress = session.progress[session.currentIndex]
    if (!progress || progress.status === 'pending') return
    const advanced = advanceSession(session, this.now())
    if (advanced.completedAt !== null && session.completedAt === null) this.playCue('complete')
    this.state = {
      ...this.state,
      view: advanced.completedAt === null ? 'practice' : 'complete',
      session: advanced,
    }
    if (advanced.completedAt !== null && session.completedAt === null) {
      this.currentResult = advanced.mode === 'sprint' ? createSprintResult(advanced) : null
      if (this.currentResult) {
        this.historyGeneration += 1
        this.history = { configKey: this.currentResult.configKey, status: 'loading', results: [], ranked: [], recentResults: [], nextCursor: null }
      }
    }
    this.persist(true)
    this.render(advanced.completedAt === null ? { event: 'question-enter' } : { event: 'completion-enter' })
    if (this.currentResult && advanced.mode === 'sprint' && advanced.completedAt !== null && session.completedAt === null) this.queueCompletedResultSave(this.currentResult)
    if (advanced.completedAt === null) this.focusCurrentView()
    else this.orientCurrentView()
  }

  private scheduleAutoAdvance(session: TrainingSession): void {
    this.cancelAutoAdvance()
    const generation = this.autoAdvanceGeneration
    const sessionId = session.id
    const index = session.currentIndex
    this.autoAdvanceTimerId = window.setTimeout(() => {
      this.autoAdvanceTimerId = null
      if (generation !== this.autoAdvanceGeneration || !this.started || document.visibilityState !== 'visible') return
      const current = this.state.session
      if (this.state.view !== 'practice' || !current || current.id !== sessionId || current.currentIndex !== index || current.completedAt !== null) return
      if (current.progress[index]?.status !== 'correct') return
      this.advanceCurrentQuestion()
    }, 900)
  }

  private cancelAutoAdvance(): void {
    this.autoAdvanceGeneration += 1
    if (this.autoAdvanceTimerId !== null) window.clearTimeout(this.autoAdvanceTimerId)
    this.autoAdvanceTimerId = null
  }

  private toggleAutoAdvance(): void {
    const autoAdvance = !this.state.preferences.autoAdvance
    if (!autoAdvance) this.cancelAutoAdvance()
    this.state = { ...this.state, preferences: { ...this.state.preferences, autoAdvance } }
    this.persist(true)
    this.render()
    this.announce(`Automatic next question ${autoAdvance ? 'on' : 'off'}.`)
    window.requestAnimationFrame(() => this.root.querySelector<HTMLElement>('[data-action="toggle-auto-advance"]')?.focus())
    const session = this.state.session
    if (autoAdvance && session?.progress[session.currentIndex]?.status === 'correct') this.scheduleAutoAdvance(session)
  }

  private toggleTimerVisibility(): void {
    const hideTimers = !this.state.preferences.hideTimers
    this.state = { ...this.state, preferences: { ...this.state.preferences, hideTimers } }
    this.persist(true)
    this.render()
    this.announce(`Live timers ${hideTimers ? 'hidden' : 'shown'}. Timing continues privately.`)
    window.requestAnimationFrame(() => this.root.querySelector<HTMLElement>('[data-action="toggle-timers"]')?.focus())
  }

  private confirmReveal(): void {
    const session = this.state.session
    if (!session) return
    const revealedSession = revealCurrentAnswer(session, this.now())
    if (revealedSession === session) return
    this.playCue('reveal')
    this.state = { ...this.state, session: revealedSession }
    this.persist(true)
    this.render({ event: 'reveal', progressFrom: completionPercent(session), progressTo: completionPercent(revealedSession) })
    const answer = revealedSession.problems[revealedSession.currentIndex]?.answer ?? ''
    this.announce(`Answer revealed: ${answer}.`)
    document.getElementById('primary-action')?.focus()
  }

  private skipQuestion(): void {
    const session = this.state.session
    if (!session) return
    const skipped = skipCurrentProblem(session, this.now())
    if (skipped === session) return
    this.state = { ...this.state, session: skipped }
    this.playCue('skip')
    this.persist(true)
    this.render({ event: 'skip', progressFrom: completionPercent(session), progressTo: completionPercent(skipped) })
    const isLast = skipped.currentIndex === skipped.problems.length - 1
    const reviewMessage = session.mode === 'review' ? ' It stays in this unscored review.' : ' 20 seconds added.'
    this.announce(`Question skipped.${reviewMessage} ${isLast ? (session.mode === 'review' ? 'Finish your review.' : 'See your results.') : 'Next question.'}`)
    document.getElementById('primary-action')?.focus()
  }

  private async enableAudio(): Promise<void> {
    const cycle = this.audioCycle
    const unlocked = await this.startAudioUnlock()
    if (cycle !== this.audioCycle || !this.state.preferences.audioEnabled) return
    if (unlocked) {
      this.announce('Sound cues on.')
      return
    }
    this.state = { ...this.state, preferences: { ...this.state.preferences, audioEnabled: false } }
    this.notice = { message: 'Sound cues could not be enabled on this device.', tone: 'warning' }
    this.persist(true)
    this.render()
    this.announce(this.notice.message)
  }

  private startAudioUnlock(): Promise<boolean> {
    if (this.audioUnlocked) return Promise.resolve(true)
    if (this.audioUnlockPromise) return this.audioUnlockPromise

    const cycle = this.audioCycle
    const pending = this.audio.unlockFromUserGesture().catch(() => false)
    this.audioUnlockPromise = pending
    void pending.then((unlocked) => {
      if (cycle !== this.audioCycle || this.audioUnlockPromise !== pending) return
      this.audioUnlockPromise = null
      this.audioUnlocked = unlocked
      const cue = this.pendingAudioCue
      this.pendingAudioCue = null
      if (unlocked && cue && this.state.preferences.audioEnabled) this.audio.play(cue)
    })
    return pending
  }

  private playCue(cue: AudioCue): void {
    if (!this.state.preferences.audioEnabled) return
    if (this.audioUnlocked) {
      this.audio.play(cue)
      return
    }
    this.pendingAudioCue = cue
    void this.startAudioUnlock()
  }

  private suspendAudio(): void {
    this.audioCycle += 1
    this.audioUnlocked = false
    this.audioUnlockPromise = null
    this.pendingAudioCue = null
    this.audio.suspend()
  }

  private useKeypad(key: string, trigger: HTMLElement): void {
    if (!this.state.session) return
    if (/^\d$/.test(key)) {
      if (this.updateSession((session) => appendCurrentDigit(session, key))) this.playCue('type')
    } else if (key === 'delete') {
      if (this.updateSession(deleteCurrentDigit)) this.playCue('erase')
    } else if (key === 'clear') {
      if (this.updateSession(clearCurrentDraft)) this.playCue('erase')
    }
    this.syncAnswerControls()
    this.persist()
    if (this.hasCoarsePointer()) {
      trigger.focus({ preventScroll: true })
    } else {
      this.focusAnswerInput(false)
    }
  }

  private setQuestionCount(value: string, trigger: HTMLElement): void {
    const count = Number(value)
    if (!Number.isInteger(count) || count < 1 || count > 50) return
    this.state = { ...this.state, settings: { ...this.state.settings, problemCount: count } }
    this.persist()
    this.render()
    void this.refreshHistory()
    window.requestAnimationFrame(() => {
      this.root.querySelector<HTMLElement>(`[data-action="question-count"][data-value="${count}"]`)?.focus()
    })
    void trigger
  }

  private updateSession(update: (session: TrainingSession) => TrainingSession): boolean {
    if (!this.state.session) return false
    const updated = update(this.state.session)
    if (updated === this.state.session) return false
    this.state = { ...this.state, session: updated }
    return true
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
    if (progress.feedback === 'incorrect') {
      input.setAttribute('aria-invalid', 'true')
    } else {
      input.removeAttribute('aria-invalid')
    }
  }

  private updateQuestionCountPresets(): void {
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-action="question-count"]')) {
      const active = Number(button.dataset.value) === this.state.settings.problemCount
      button.classList.toggle('preset--active', active)
      button.setAttribute('aria-pressed', String(active))
    }
  }

  private updatePracticePresetSelection(): void {
    const selectedPreset = matchingPresetId(this.state.settings)
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-action="start-preset"]')) {
      const active = button.dataset.preset === selectedPreset
      button.classList.toggle('practice-preset--active', active)
      button.setAttribute('aria-pressed', String(active))
      const action = button.querySelector<HTMLElement>('b')
      if (action) action.textContent = active ? 'Selected · Start →' : 'Start challenge →'
    }
    const state = this.root.querySelector<HTMLElement>('.preset-state')
    if (state) state.textContent = selectedPreset === 'custom' ? 'Custom setup' : 'Preset selected'
  }

  private updateSetupExample(): void {
    const host = this.root.querySelector<HTMLElement>('#setup-example-host')
    if (host) host.innerHTML = this.renderExample(this.state.settings, validateConfig(this.state.settings))
  }

  private updateTimerText(): void {
    const timer = this.root.querySelector<HTMLElement>('#elapsed-time')
    if (timer && this.state.session) timer.textContent = this.state.preferences.hideTimers ? 'Hidden' : formatDuration(getElapsedMs(this.state.session, this.now()))
    const questionTimer = this.root.querySelector<HTMLElement>('#question-time')
    if (questionTimer && this.state.session) {
      const elapsed = getCurrentProblemElapsedMs(this.state.session, this.now())
      questionTimer.textContent = this.state.preferences.hideTimers ? 'Hidden' : elapsed === null ? '—' : formatDuration(elapsed)
    }
  }

  private persist(force = false): boolean {
    const now = this.now()
    if (!force && now - this.lastPersistedAt < 250) return true
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
    return saved
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
      const heading = this.setupDestination === 'progress' ? 'progress-heading' : 'setup-heading'
      window.requestAnimationFrame(() => document.getElementById(heading)?.focus())
    }
  }

  private orientCurrentView(): void {
    const previousScrollBehavior = document.documentElement.style.scrollBehavior
    document.documentElement.style.scrollBehavior = 'auto'
    this.resetPageScroll()
    window.requestAnimationFrame(() => {
      const target = this.state.view === 'practice'
        ? this.hasCoarsePointer()
          ? document.getElementById('problem-heading')
          : this.root.querySelector<HTMLElement>('#answer-input:not([readonly])')
        : this.state.view === 'complete'
          ? document.getElementById('completion-heading')
          : document.getElementById(this.setupDestination === 'progress' ? 'progress-heading' : 'setup-heading')
      target?.focus({ preventScroll: true })
      this.resetPageScroll()
      window.requestAnimationFrame(() => {
        this.resetPageScroll()
        document.documentElement.style.scrollBehavior = previousScrollBehavior
      })
    })
  }

  private resetPageScroll(): void {
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0
    document.documentElement.scrollTop = 0
    document.body.scrollTop = 0
  }

  private focusPracticeInput(): void {
    if (this.hasCoarsePointer()) {
      window.requestAnimationFrame(() => document.getElementById('problem-heading')?.focus())
    } else {
      this.focusAnswerInput(false)
    }
  }

  private hasCoarsePointer(): boolean {
    return window.matchMedia?.('(pointer: coarse)').matches ?? false
  }

  private focusAnswerInput(select: boolean): void {
    window.requestAnimationFrame(() => {
      const input = this.root.querySelector<HTMLInputElement>('#answer-input')
      if (!input || input.readOnly) return
      input.focus({ preventScroll: true })
      if (select) input.select()
    })
  }

  private openDialog(id: string): void {
    const dialog = document.getElementById(id)
    if (!(dialog instanceof HTMLDialogElement) || dialog.open) return
    dialog.showModal()
  }

  private announce(message: string): void {
    if (this.announcementTimerId !== null) window.clearTimeout(this.announcementTimerId)
    this.announcer.textContent = ''
    this.announcementTimerId = window.setTimeout(() => {
      this.announcer.textContent = message
      this.announcementTimerId = null
    }, 0)
  }
}

function createDefaultAppState(): PersistedAppState {
  return {
    schemaVersion: APP_SCHEMA_VERSION,
    view: 'setup',
    settings: cloneConfig(DEFAULT_CONFIG),
    preferences: { ...DEFAULT_PREFERENCES },
    session: null,
  }
}

function cloneConfig(config: TrainingConfig): TrainingConfig {
  return { ...config, operations: [...config.operations] }
}

function renderExpression(
  problem: TrainingSession['problems'][number],
  preference: 'horizontal' | 'vertical',
): string {
  if (effectiveOrientation(preference, problem) === 'vertical') {
    const operation = problem.operators[0]!
    return `
      <div class="expression expression--vertical" role="img" aria-label="${escapeHtml(speakExpression(problem))}">
        <span class="vertical-expression" aria-hidden="true">
          <span>${escapeHtml(problem.operands[0] ?? '')}</span>
          <span><b>${OPERATION_DETAILS[operation].symbol}</b>${escapeHtml(problem.operands[1] ?? '')}</span>
          <i></i>
        </span>
        <span class="expression__equals" aria-hidden="true">?</span>
      </div>
    `
  }
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

function feedbackMarkup(feedback: string, answer: string, reviewing = false): string {
  if (feedback === 'incorrect') {
    return '<span class="feedback-icon" aria-hidden="true">×</span><span><strong>Not quite.</strong> Check the expression and try again.</span>'
  }
  if (feedback === 'correct') {
    return '<span class="feedback-icon" aria-hidden="true">✓</span><span><strong>Correct.</strong> Nice work — keep going.</span>'
  }
  if (feedback === 'skipped') {
    return `<span class="feedback-icon" aria-hidden="true">—</span><span><strong>Skipped.</strong> ${reviewing ? 'Keep it in your next review round.' : '20 seconds added to your scored time.'}</span>`
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

function formatConfigSummary(config: TrainingConfig): string {
  const operations = config.operations.map((operation) => OPERATION_DETAILS[operation].shortLabel).join(', ')
  return `${config.problemCount} ${pluralize(config.problemCount, 'question')} · ${config.challenge === 'random' ? 'Random' : `Level ${config.challenge}`} · ${digitRangeShort(config)} · ${config.operatorCount} ${pluralize(config.operatorCount, 'operator')} · ${config.operationMode === 'mixed' ? 'Mixed' : 'Same'} · ${operations}`
}

const CHALLENGE_OPTIONS: ReadonlyArray<{ value: ChallengeLevel; title: string; detail: string }> = [
  { value: 'random', title: 'Random', detail: 'The original surprise mix.' },
  { value: 1, title: 'Level 1', detail: 'A gentle confidence-building ramp.' },
  { value: 2, title: 'Level 2', detail: 'Approachable with a little stretch.' },
  { value: 3, title: 'Level 3', detail: 'A balanced everyday challenge.' },
  { value: 4, title: 'Level 4', detail: 'Demanding questions, steadily ordered.' },
  { value: 5, title: 'Level 5', detail: 'The toughest range your setup offers.' },
]

function parseChallengeLevel(value: string): ChallengeLevel {
  if (value === 'random') return 'random'
  const numeric = Number(value)
  return numeric >= 1 && numeric <= 5 && Number.isInteger(numeric) ? numeric as 1 | 2 | 3 | 4 | 5 : 'random'
}

function challengeDescription(challenge: ChallengeLevel): string {
  return challenge === 'random'
    ? 'Random keeps the original seeded mix and its existing personal history.'
    : `Level ${challenge} starts at the approachable side of this level and builds upward. Difficulty is relative to your chosen settings.`
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}

function completionPercent(session: TrainingSession | null): number {
  if (!session || session.problems.length === 0) return 0
  const complete = session.progress.filter((item) => item.status !== 'pending').length
  return Math.round((complete / session.problems.length) * 10_000) / 100
}

function formatOptionalDuration(value: number | null): string {
  return value === null ? 'unavailable' : formatDuration(value)
}

function mascotMood(progress: TrainingSession['progress'][number]): string {
  if (progress.status === 'correct') return 'correct'
  if (progress.status === 'skipped') return 'skipped'
  if (progress.status === 'revealed') return 'revealed'
  return progress.feedback === 'incorrect' ? 'incorrect' : 'ready'
}

type NumiPose = 'ready' | 'thinking' | 'encouraging' | 'celebration'

function mascotPose(progress: TrainingSession['progress'][number]): NumiPose {
  const mood = mascotMood(progress)
  if (mood === 'ready' || mood === 'revealed') return 'thinking'
  if (mood === 'correct') return 'celebration'
  return 'encouraging'
}

function mascotMessage(progress: TrainingSession['progress'][number], reviewing = false): string {
  const mood = mascotMood(progress)
  if (mood === 'correct') return reviewing ? 'Yes! That tricky pattern is becoming yours.' : 'Yes! That pattern is yours now.'
  if (mood === 'incorrect') return 'Let’s take another look. Try one slower pass with me.'
  if (mood === 'skipped') return 'Good reset. We’ll come back stronger.'
  if (mood === 'revealed') return 'Notice the pattern—next time it’ll feel familiar.'
  return reviewing ? 'We’ve seen this one before. You’ve got it.' : 'I’m right here—one step at a time.'
}

function numiSrc(pose: NumiPose): string {
  return `${import.meta.env.BASE_URL}numi/${pose}.webp`
}

function canonicalAppUrl(): string {
  return PUBLIC_APP_URL
}

function formatResultDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp)
}

function formatProgressDate(timestamp: number, now: number): string {
  const start = (value: number): number => {
    const date = new Date(value)
    date.setHours(0, 0, 0, 0)
    return date.getTime()
  }
  const days = Math.round((start(now) - start(timestamp)) / 86_400_000)
  const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(timestamp)
  if (days === 0) return `Today, ${time}`
  if (days === 1) return `Yesterday, ${time}`
  return formatResultDate(timestamp)
}

function progressDuration(milliseconds: number): string {
  return milliseconds < 1_000 ? '<1 sec' : formatDuration(milliseconds)
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
