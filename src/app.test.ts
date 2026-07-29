import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MathTrainingApp } from './app'
import { DEFAULT_CONFIG, speakExpression } from './math/engine'
import { DEFAULT_PREFERENCES, type SharePayload } from './sprint/contracts'
import { createSprintResult, type ResultPage, type ResultStore, type ResultStoreWriteResult } from './sprint/results'
import { advanceSession, checkCurrentAnswer, createReviewSession, createTrainingSession, pauseSession, setCurrentDraft, skipCurrentProblem } from './state/session'
import {
  APP_SCHEMA_VERSION,
  type PersistedAppState,
  type StoreLoadResult,
} from './storage/progress-store'

const createPracticeState = (problemCount = 1): PersistedAppState => {
  const config = { ...DEFAULT_CONFIG, operations: [...DEFAULT_CONFIG.operations], problemCount }
  const session = pauseSession(createTrainingSession(config, 42, 1_000), 1_000)
  return {
    schemaVersion: APP_SCHEMA_VERSION,
    view: 'practice',
    settings: config,
    preferences: { ...DEFAULT_PREFERENCES },
    session,
  }
}

const createStore = (result: StoreLoadResult) => ({
  load: vi.fn(() => result),
  save: vi.fn((state: PersistedAppState) => Boolean(state)),
  clear: vi.fn(() => true),
  clearAll: vi.fn(() => true),
})

const emptyResultPage = (): ResultPage => ({
  status: 'ok',
  results: [],
  nextCursor: null,
  corruptRecords: 0,
  truncated: false,
})

const createResultStore = (): ResultStore => ({
  saveCompleted: vi.fn(async () => ({ status: 'saved' as const })),
  getById: vi.fn(async () => null),
  listCompleted: vi.fn(async () => emptyResultPage()),
  listRanked: vi.fn(async () => emptyResultPage()),
  listCompletedSince: vi.fn(async () => emptyResultPage()),
  clearConfig: vi.fn(async () => ({ status: 'cleared' as const })),
})

function submitAnswer(root: HTMLElement, answer: string): void {
  const input = root.querySelector<HTMLInputElement>('#answer-input')!
  input.value = answer
  input.dispatchEvent(new Event('input', { bubbles: true }))
  root.querySelector<HTMLFormElement>('#answer-form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
}

function setVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value })
}

describe('MathTrainingApp lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = '<div id="app"></div>'
    setVisibility('visible')
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    })
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        callback(0)
        return 1
      },
    })
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value(this: HTMLDialogElement) { this.setAttribute('open', '') },
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    document.body.innerHTML = ''
    setVisibility('visible')
  })

  it('preserves browser focus on an initial setup load', () => {
    document.body.innerHTML = '<button id="before-app">Before app</button><div id="app"></div>'
    const sentinel = document.querySelector<HTMLButtonElement>('#before-app')!
    sentinel.focus()
    const store = createStore({ status: 'empty', state: null })
    const app = new MathTrainingApp(document.querySelector<HTMLElement>('#app')!, {
      store,
      now: () => 1_000,
    })

    app.start()
    expect(document.activeElement).toBe(sentinel)
    expect(document.querySelector<HTMLImageElement>('.numi--pose-ready')?.src).toContain('/numi/ready.webp')
    app.destroy()
  })

  it('navigates between Practice and Progress without persisting UI-only state', () => {
    const store = createStore({ status: 'empty', state: null })
    const root = document.querySelector<HTMLElement>('#app')!
    const app = new MathTrainingApp(root, { store, now: () => 1_000 })
    app.start()

    expect(root.querySelector('[data-action="show-practice"]')?.getAttribute('aria-current')).toBe('page')
    root.querySelector<HTMLButtonElement>('[data-action="show-progress"]')!.click()
    expect(root.dataset.section).toBe('progress')
    expect(document.activeElement?.id).toBe('progress-heading')
    expect(root.querySelector('[data-action="show-progress"]')?.getAttribute('aria-current')).toBe('page')
    const saved = store.save.mock.calls.at(-1)![0] as PersistedAppState
    expect(Object.keys(saved).sort()).toEqual(['preferences', 'schemaVersion', 'session', 'settings', 'view'])

    root.querySelector<HTMLButtonElement>('[data-action="show-practice"]')!.click()
    expect(root.dataset.section).toBe('practice')
    expect(document.activeElement?.id).toBe('setup-heading')
    app.destroy()
  })

  it('preserves disclosure state and focused controls across setup rerenders', () => {
    const root = document.querySelector<HTMLElement>('#app')!
    const app = new MathTrainingApp(root, { store: createStore({ status: 'empty', state: null }), now: () => 1_000 })
    app.start()
    for (const id of ['customize-setup', 'advanced-setup']) {
      const details = root.querySelector<HTMLDetailsElement>(`#${id}`)!
      details.open = true
      details.dispatchEvent(new Event('toggle'))
    }
    const maxDigits = root.querySelector<HTMLSelectElement>('#maxDigits')!
    maxDigits.focus()
    maxDigits.value = '4'
    maxDigits.dispatchEvent(new Event('change', { bubbles: true }))

    expect(root.querySelector<HTMLDetailsElement>('#customize-setup')?.open).toBe(true)
    expect(root.querySelector<HTMLDetailsElement>('#advanced-setup')?.open).toBe(true)
    expect(document.activeElement?.id).toBe('maxDigits')
    app.destroy()
  })

  it('starts a complete guided preset with one click', () => {
    const store = createStore({ status: 'empty', state: null })
    const root = document.querySelector<HTMLElement>('#app')!
    const app = new MathTrainingApp(root, { store, now: () => 1_000, createSeed: () => 7 })
    app.start()

    expect(root.querySelectorAll('[data-action="start-preset"]')).toHaveLength(3)
    expect(root.textContent).toContain('Custom setup')
    root.querySelector<HTMLButtonElement>('[data-preset="quick-win"]')!.click()

    const saved = store.save.mock.calls.at(-1)![0] as PersistedAppState
    expect(saved.view).toBe('practice')
    expect(saved.settings).toEqual({ minDigits: 1, maxDigits: 1, operatorCount: 1, operationMode: 'same', operations: ['add', 'subtract'], problemCount: 5, challenge: 1 })
    expect(saved.session?.config).toEqual(saved.settings)
    expect(root.querySelector('#answer-form')).not.toBeNull()
    app.destroy()
  })

  it.each(['sprint', 'review'] as const)('protects an incomplete saved %s before a guided preset replaces it', (mode) => {
    const state = createPracticeState()
    state.view = 'setup'
    if (mode === 'review') {
      let source = createTrainingSession({ ...DEFAULT_CONFIG, problemCount: 1 }, 12, 0)
      source = advanceSession(skipCurrentProblem(source, 100), 200)
      state.session = pauseSession(createReviewSession(source, 300)!, 300)
    }
    const store = createStore({ status: 'ok', state })
    const root = document.querySelector<HTMLElement>('#app')!
    const app = new MathTrainingApp(root, { store, now: () => 1_000, createSeed: () => 8 })
    app.start()

    root.querySelector<HTMLButtonElement>('[data-preset="build-fluency"]')!.click()
    expect(root.querySelector<HTMLDialogElement>('#replace-dialog')?.open).toBe(true)
    expect(root.querySelector('#answer-form')).toBeNull()
    root.querySelector<HTMLButtonElement>('[data-action="confirm-replace"]')!.click()

    const saved = store.save.mock.calls.at(-1)![0] as PersistedAppState
    expect(saved.view).toBe('practice')
    expect(saved.session?.mode).toBe('sprint')
    expect(saved.session?.config.operations).toEqual(['multiply', 'divide'])
    expect(saved.session?.config.problemCount).toBe(10)
    app.destroy()
  })

  it('uses guarded exact-setup history for a returning-user quick start', async () => {
    let session = createTrainingSession({ ...DEFAULT_CONFIG, operations: [...DEFAULT_CONFIG.operations], problemCount: 1 }, 9, 0)
    session = setCurrentDraft(session, session.problems[0]!.answer)
    session = advanceSession(checkCurrentAnswer(session, 100), 200)
    const result = createSprintResult(session)!
    const page = { ...emptyResultPage(), results: [result] }
    const resultStore = createResultStore()
    resultStore.listCompleted = vi.fn(async () => page)
    resultStore.listRanked = vi.fn(async () => page)
    resultStore.listCompletedSince = vi.fn(async () => page)
    const root = document.querySelector<HTMLElement>('#app')!
    const app = new MathTrainingApp(root, { store: createStore({ status: 'empty', state: null }), resultStore, now: () => 1_000, createSeed: () => 10 })
    app.start()

    await vi.waitFor(() => expect(root.textContent).toContain('Continue this exact setup'))
    expect(root.textContent).toContain('100% first-try accuracy')
    expect(root.textContent).toContain('Personal best')
    root.querySelector<HTMLButtonElement>('[data-action="start-current-setup"]')!.click()
    expect(root.querySelector('#answer-form')).not.toBeNull()
    app.destroy()
  })

  it('does not render a stale welcome-back result after the setup changes', async () => {
    let oldSession = createTrainingSession({ ...DEFAULT_CONFIG, operations: [...DEFAULT_CONFIG.operations], problemCount: 1 }, 11, 0)
    oldSession = setCurrentDraft(oldSession, oldSession.problems[0]!.answer)
    oldSession = advanceSession(checkCurrentAnswer(oldSession, 100), 200)
    const oldResult = createSprintResult(oldSession)!
    let resolveOld: (page: ResultPage) => void = () => undefined
    const oldPage = new Promise<ResultPage>((resolve) => { resolveOld = resolve })
    const resultStore = createResultStore()
    resultStore.listCompleted = vi.fn().mockReturnValueOnce(oldPage).mockResolvedValue(emptyResultPage())
    const root = document.querySelector<HTMLElement>('#app')!
    const app = new MathTrainingApp(root, { store: createStore({ status: 'empty', state: null }), resultStore, now: () => 1_000 })
    app.start()

    const maxDigits = root.querySelector<HTMLSelectElement>('#maxDigits')!
    maxDigits.value = '3'
    maxDigits.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(resultStore.listCompleted).toHaveBeenCalledTimes(2))
    root.querySelector<HTMLButtonElement>('[data-action="show-progress"]')!.click()
    await vi.waitFor(() => expect(root.textContent).toContain('No completed results yet.'))
    resolveOld({ ...emptyResultPage(), results: [oldResult] })
    await Promise.resolve()
    await Promise.resolve()

    expect(root.textContent).not.toContain('Continue this exact setup')
    expect(root.textContent).not.toContain('100% first-try accuracy')
    app.destroy()
  })

  it('invalidates exact-setup guidance while a valid custom question count is typed', async () => {
    const resultStore = createResultStore()
    const root = document.querySelector<HTMLElement>('#app')!
    const app = new MathTrainingApp(root, { store: createStore({ status: 'empty', state: null }), resultStore, now: () => 1_000 })
    app.start()

    const input = root.querySelector<HTMLInputElement>('#problem-count')!
    input.value = '7'
    input.dispatchEvent(new Event('input', { bubbles: true }))

    await vi.waitFor(() => expect(resultStore.listCompleted).toHaveBeenCalledTimes(2))
    root.querySelector<HTMLButtonElement>('[data-action="show-progress"]')!.click()
    await vi.waitFor(() => expect(root.textContent).toContain('No completed results yet.'))
    root.querySelector<HTMLButtonElement>('[data-action="show-practice"]')!.click()
    expect(root.textContent).toContain('Custom setup')
    expect(root.querySelector('#setup-example-host')?.textContent).toContain('7 questions')
    expect(root.querySelector('[data-action="start-preset"][aria-pressed="true"]')).toBeNull()
    app.destroy()
  })

  it('keeps one announcer across rerenders and repeats grading messages', () => {
    const store = createStore({ status: 'ok', state: createPracticeState() })
    const root = document.querySelector<HTMLElement>('#app')!
    const app = new MathTrainingApp(root, { store, now: () => 1_000 })
    app.start()

    const announcer = document.querySelector<HTMLElement>('#app-announcer')!
    expect(announcer.textContent).toBe('')

    const submitWrongAnswer = (): void => {
      const input = document.querySelector<HTMLInputElement>('#answer-input')!
      input.value = '0'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      document
        .querySelector<HTMLFormElement>('#answer-form')!
        .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
      vi.advanceTimersByTime(0)
    }

    submitWrongAnswer()
    expect(document.querySelector('#app-announcer')).toBe(announcer)
    expect(announcer.textContent).toBe('Incorrect. Try again.')
    expect(root.querySelector<HTMLImageElement>('.numi--pose-encouraging')?.src).toContain('/numi/encouraging.webp')
    submitWrongAnswer()
    expect(document.querySelector('#app-announcer')).toBe(announcer)
    expect(announcer.textContent).toBe('Incorrect. Try again.')

    app.destroy()
    expect(announcer.isConnected).toBe(false)
  })

  it('shows correct feedback, then advances exactly once after 900ms', () => {
    const state = createPracticeState(2)
    const answer = state.session!.problems[0]!.answer
    const store = createStore({ status: 'ok', state })
    const root = document.querySelector<HTMLElement>('#app')!
    const app = new MathTrainingApp(root, { store, now: () => 2_000 })
    app.start()

    submitAnswer(root, answer)
    vi.advanceTimersByTime(0)
    expect(root.dataset.motion).toBe('correct')
    expect(root.style.getPropertyValue('--progress-from')).toBe('0%')
    expect(root.style.getPropertyValue('--progress-to')).toBe('50%')
    expect(root.textContent).toContain('Correct.')
    expect(root.textContent).toContain('Question 1 of 2')
    expect(document.querySelector('#app-announcer')?.textContent).toBe('Correct. Moving to the next question.')
    expect(root.querySelector('#answer-input')?.hasAttribute('readonly')).toBe(true)
    const saved = store.save.mock.calls.at(-1)![0] as PersistedAppState
    expect(saved.session?.progress[0]?.status).toBe('correct')

    vi.advanceTimersByTime(899)
    expect(root.textContent).toContain('Question 1 of 2')
    vi.advanceTimersByTime(1)
    expect(root.textContent).toContain('Question 2 of 2')
    expect(root.dataset.motion).toBe('question-enter')
    expect(root.style.getPropertyValue('--progress-from')).toBe('')
    expect(root.querySelector('#answer-input')).toBe(document.activeElement)
    vi.advanceTimersByTime(900)
    expect(root.textContent).toContain('Question 2 of 2')
    app.destroy()
  })

  it('lets manual advance or the live toggle safely cancel automatic movement', () => {
    const state = createPracticeState(3)
    const root = document.querySelector<HTMLElement>('#app')!
    const app = new MathTrainingApp(root, { store: createStore({ status: 'ok', state }), now: () => 2_000 })
    app.start()

    submitAnswer(root, state.session!.problems[0]!.answer)
    vi.advanceTimersByTime(899)
    root.querySelector<HTMLFormElement>('#answer-form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    expect(root.textContent).toContain('Question 2 of 3')
    vi.advanceTimersByTime(1)
    expect(root.textContent).toContain('Question 2 of 3')

    submitAnswer(root, state.session!.problems[1]!.answer)
    root.querySelector<HTMLButtonElement>('[data-action="toggle-auto-advance"]')!.click()
    expect(root.querySelector('[data-action="toggle-auto-advance"]')?.getAttribute('aria-pressed')).toBe('false')
    vi.advanceTimersByTime(1_000)
    expect(root.textContent).toContain('Question 2 of 3')
    expect(root.textContent).toContain('Next question')
    app.destroy()
  })

  it('cancels a pending automatic advance when hidden or destroyed', () => {
    const state = createPracticeState(2)
    const root = document.querySelector<HTMLElement>('#app')!
    const app = new MathTrainingApp(root, { store: createStore({ status: 'ok', state }), now: () => 2_000 })
    app.start()
    submitAnswer(root, state.session!.problems[0]!.answer)
    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(1_000)
    expect(root.textContent).toContain('Question 1 of 2')
    app.destroy()
    vi.advanceTimersByTime(1_000)
    expect(root.textContent).toContain('Question 1 of 2')
  })

  it('hides live timers without changing recorded completion time', () => {
    let now = 1_000
    const state = createPracticeState()
    const store = createStore({ status: 'ok', state })
    const root = document.querySelector<HTMLElement>('#app')!
    const app = new MathTrainingApp(root, { store, now: () => now, resultStore: createResultStore() })
    app.start()
    root.querySelector<HTMLButtonElement>('[data-action="toggle-timers"]')!.click()
    expect(root.querySelector('#elapsed-time')?.textContent).toBe('Hidden')
    expect(root.querySelector('#question-time')?.textContent).toBe('Hidden')
    expect(root.querySelector('[data-action="toggle-timers"]')).toBe(document.activeElement)
    expect((store.save.mock.calls.at(-1)![0] as PersistedAppState).preferences.hideTimers).toBe(true)

    now = 4_000
    vi.advanceTimersByTime(250)
    expect(root.querySelector('#elapsed-time')?.textContent).toBe('Hidden')
    root.querySelector<HTMLButtonElement>('[data-action="skip"]')!.click()
    root.querySelector<HTMLFormElement>('#answer-form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    expect(root.textContent).toContain('00:03 active')
    expect(root.textContent).toContain('00:20 penalties')
    app.destroy()
  })

  it('starts a private exact review from sanitized history only when no session is active', async () => {
    const config = { ...DEFAULT_CONFIG, problemCount: 1 }
    let source = createTrainingSession(config, 55, 0)
    source = advanceSession(skipCurrentProblem(source, 100), 200)
    const difficultResult = createSprintResult(source)!
    const page = { ...emptyResultPage(), results: [difficultResult] }
    const resultStore = createResultStore()
    resultStore.listCompleted = vi.fn(async () => page)
    resultStore.listRanked = vi.fn(async () => page)
    resultStore.listCompletedSince = vi.fn(async () => page)
    const root = document.querySelector<HTMLElement>('#app')!
    const app = new MathTrainingApp(root, { store: createStore({ status: 'empty', state: null }), resultStore, now: () => 1_000, createSeed: () => 77 })
    app.start()
    const problemCount = root.querySelector<HTMLInputElement>('#problem-count')!
    problemCount.value = '1'
    problemCount.dispatchEvent(new Event('input', { bubbles: true }))
    root.querySelector<HTMLButtonElement>('[data-action="show-progress"]')!.click()
    await vi.waitFor(() => expect(root.querySelector('[data-action="start-history-review"]')).not.toBeNull())
    root.querySelector<HTMLButtonElement>('[data-action="start-history-review"]')!.click()
    expect(root.querySelector('.review-mode-badge')?.textContent).toContain('Unscored')
    expect(root.querySelector('.expression')?.getAttribute('aria-label')).toBe(`${speakExpression(source.problems[0]!)}`)
    expect(resultStore.saveCompleted).not.toHaveBeenCalled()
    app.destroy()

    document.body.innerHTML = '<div id="app"></div>'
    const activeState = createPracticeState()
    activeState.view = 'setup'
    const activeRoot = document.querySelector<HTMLElement>('#app')!
    const activeApp = new MathTrainingApp(activeRoot, { store: createStore({ status: 'ok', state: activeState }), resultStore, now: () => 1_000 })
    activeApp.start()
    await Promise.resolve()
    expect(activeRoot.querySelector('[data-action="start-history-review"]')).toBeNull()
    activeApp.destroy()
  })

  it('announces a failed save without claiming progress is stored', () => {
    const store = createStore({ status: 'empty', state: null })
    store.save.mockReturnValue(false)
    const root = document.querySelector<HTMLElement>('#app')!
    const app = new MathTrainingApp(root, { store, now: () => 1_000, createSeed: () => 7 })
    app.start()

    root
      .querySelector<HTMLFormElement>('#setup-form')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    vi.advanceTimersByTime(0)

    expect(root.textContent).toContain('Progress cannot be saved on this device')
    expect(document.querySelector('#app-announcer')?.textContent).toBe(
      'Progress cannot be saved on this device. Practice still works in this tab.',
    )
    app.destroy()
  })

  it('does not claim save and exit succeeded when storage fails', () => {
    const store = createStore({ status: 'ok', state: createPracticeState() })
    store.save.mockReturnValue(false)
    const root = document.querySelector<HTMLElement>('#app')!
    const app = new MathTrainingApp(root, { store, now: () => 1_000 })
    app.start()

    root.querySelector<HTMLButtonElement>('[data-action="save-exit"]')!.click()
    vi.advanceTimersByTime(0)

    expect(root.textContent).toContain('Progress cannot be saved on this device')
    expect(root.textContent).not.toContain('Session saved on this device')
    expect(document.querySelector('#app-announcer')?.textContent).toBe(
      'Progress cannot be saved on this device. Practice still works in this tab.',
    )
    app.destroy()
  })

  it('keeps a restored hidden session paused until the document becomes visible', () => {
    let now = 1_000
    const store = createStore({ status: 'ok', state: createPracticeState() })
    const root = document.querySelector<HTMLElement>('#app')!
    setVisibility('hidden')
    const app = new MathTrainingApp(root, { store, now: () => now })

    app.start()
    now = 6_000
    vi.advanceTimersByTime(250)
    expect(document.querySelector('#elapsed-time')?.textContent).toBe('00:00')

    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    now = 7_000
    vi.advanceTimersByTime(250)
    expect(document.querySelector('#elapsed-time')?.textContent).toBe('00:01')

    app.destroy()
  })

  it('resumes a restored visible session immediately', () => {
    let now = 1_000
    const store = createStore({ status: 'ok', state: createPracticeState() })
    const root = document.querySelector<HTMLElement>('#app')!
    const app = new MathTrainingApp(root, { store, now: () => now })

    app.start()
    now = 3_000
    vi.advanceTimersByTime(250)
    expect(document.querySelector('#elapsed-time')?.textContent).toBe('00:02')

    app.destroy()
  })

  it('starts once and removes timers and listeners on destroy', () => {
    const store = createStore({ status: 'empty', state: null })
    const root = document.querySelector<HTMLElement>('#app')!
    const app = new MathTrainingApp(root, { store, now: () => 1_000 })

    const intervalSpy = vi.spyOn(window, 'setInterval')
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval')
    app.start()
    app.start()
    expect(store.load).toHaveBeenCalledTimes(1)
    expect(intervalSpy).toHaveBeenCalledOnce()

    app.destroy()
    expect(clearIntervalSpy).toHaveBeenCalledOnce()
    const saveCount = store.save.mock.calls.length
    window.dispatchEvent(new Event('beforeunload'))
    expect(store.save).toHaveBeenCalledTimes(saveCount)
  })

  it('renders vertical practice, skips with a scored penalty, and plays unlocked cues', async () => {
    let now = 1_000
    const audio = {
      unlockFromUserGesture: vi.fn(async () => true),
      play: vi.fn(),
      suspend: vi.fn(),
    }
    const root = document.querySelector<HTMLElement>('#app')!
    const resultStore = createResultStore()
    const app = new MathTrainingApp(root, {
      store: createStore({ status: 'empty', state: null }),
      resultStore,
      now: () => now,
      createSeed: () => 7,
      audio,
    })
    app.start()

    root.querySelector<HTMLInputElement>('#layout-vertical')!.click()
    root.querySelector<HTMLInputElement>('#audio-enabled')!.click()
    const problemCount = root.querySelector<HTMLInputElement>('#problem-count')!
    problemCount.value = '1'
    problemCount.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
    expect(audio.unlockFromUserGesture).toHaveBeenCalledOnce()

    root.querySelector<HTMLFormElement>('#setup-form')!.dispatchEvent(
      new SubmitEvent('submit', { bubbles: true, cancelable: true }),
    )
    expect(root.querySelector('.expression--vertical')).not.toBeNull()
    expect(root.textContent).toContain('0% complete')

    now = 4_000
    root.querySelector<HTMLButtonElement>('[data-action="skip"]')!.click()
    expect(root.dataset.motion).toBe('skip')
    expect(root.style.getPropertyValue('--progress-to')).toBe('100%')
    expect(root.textContent).toContain('20 seconds added to your scored time')
    expect(root.querySelector<HTMLImageElement>('.numi--pose-encouraging')?.src).toContain('/numi/encouraging.webp')
    expect(root.textContent).toContain('100% complete')
    expect(root.querySelector('#question-time')?.textContent).toBe('00:03')
    expect(audio.play).toHaveBeenCalledWith('skip')

    root.querySelector<HTMLFormElement>('#answer-form')!.dispatchEvent(
      new SubmitEvent('submit', { bubbles: true, cancelable: true }),
    )
    expect(root.textContent).toContain('Session complete.')
    expect(root.dataset.motion).toBe('completion-enter')
    expect(root.querySelector<HTMLImageElement>('.numi--completion.numi--pose-encouraging')?.src).toContain('/numi/encouraging.webp')
    expect(root.textContent).not.toContain('Perfect run!')
    expect(root.textContent).toContain('Scored time')
    expect(root.textContent).toContain('00:23')
    expect(root.textContent).toContain('Skipped · +20s')
    expect(audio.play).toHaveBeenCalledWith('complete')
    await vi.waitFor(() => expect(resultStore.saveCompleted).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(root.textContent).toContain('Personal top five'))
    expect(root.textContent).toContain('New best')

    app.destroy()
    expect(audio.suspend).toHaveBeenCalled()
  })

  it('turns difficult sprint questions into an exact unscored review without history leakage', async () => {
    const state = createPracticeState()
    const answer = state.session!.problems[0]!.answer
    const root = document.querySelector<HTMLElement>('#app')!
    const resultStore = createResultStore()
    const app = new MathTrainingApp(root, {
      store: createStore({ status: 'ok', state }), resultStore, now: () => 2_000,
    })
    app.start()

    const input = root.querySelector<HTMLInputElement>('#answer-input')!
    input.value = String(BigInt(answer) + 1n)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    root.querySelector<HTMLFormElement>('#answer-form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    root.querySelector<HTMLInputElement>('#answer-input')!.value = answer
    root.querySelector<HTMLInputElement>('#answer-input')!.dispatchEvent(new Event('input', { bubbles: true }))
    root.querySelector<HTMLFormElement>('#answer-form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    root.querySelector<HTMLFormElement>('#answer-form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(resultStore.saveCompleted).toHaveBeenCalledOnce())
    expect(root.textContent).toContain('Review this question')
    expect(root.textContent).toContain('Your debrief')
    expect(root.textContent).toContain('Sprint again')
    expect(root.textContent).toContain('Change settings')
    const rankingCalls = vi.mocked(resultStore.listRanked).mock.calls.length
    const originalExpression = root.querySelector('.debrief-focus strong')?.getAttribute('aria-label')?.split(' equals ')[0]
    root.querySelector<HTMLButtonElement>('[data-action="start-review"]')!.click()
    expect(root.querySelector('.review-mode-badge')?.textContent).toContain('Unscored')
    expect(root.querySelector('.expression')?.getAttribute('aria-label')).toBe(originalExpression)
    expect(root.querySelector('.share-card')).toBeNull()

    root.querySelector<HTMLButtonElement>('[data-action="skip"]')!.click()
    expect(root.textContent).toContain('Keep it in your next review round')
    expect(root.textContent).not.toContain('20 seconds added to your scored time')
    root.querySelector<HTMLFormElement>('#answer-form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    expect(root.textContent).toContain('Review complete.')
    expect(root.textContent).toContain('Review rounds stay resumable')
    expect(root.querySelector('.ranking-card')).toBeNull()
    expect(root.querySelector('.share-card')).toBeNull()
    expect(resultStore.saveCompleted).toHaveBeenCalledOnce()
    expect(vi.mocked(resultStore.listRanked).mock.calls.length).toBe(rankingCalls)

    root.querySelector<HTMLButtonElement>('[data-action="practice-again"]')!.click()
    expect(root.querySelector('.expression')?.getAttribute('aria-label')).toBe(originalExpression)
    expect(root.querySelector('.review-mode-badge')).not.toBeNull()
    app.destroy()
  })

  it('restores incomplete and completed reviews without projecting scored results', () => {
    const makeReviewState = (complete: boolean): PersistedAppState => {
      let source = createTrainingSession({ ...DEFAULT_CONFIG, problemCount: 1 }, 42, 1_000)
      source = skipCurrentProblem(source, 1_100)
      let review = createReviewSession(source, 2_000)!
      if (complete) review = advanceSession(skipCurrentProblem(review, 2_100), 2_200)
      else review = pauseSession(review, 2_100)
      return { ...createPracticeState(), view: complete ? 'complete' : 'practice', session: review }
    }

    for (const complete of [false, true]) {
      document.body.innerHTML = '<div id="app"></div>'
      const resultStore = createResultStore()
      const root = document.querySelector<HTMLElement>('#app')!
      const app = new MathTrainingApp(root, { store: createStore({ status: 'ok', state: makeReviewState(complete) }), resultStore, now: () => 3_000 })
      app.start()
      expect(root.textContent).toContain(complete ? 'Review complete.' : 'Mistake-to-mastery review')
      if (complete) expect(root.querySelector<HTMLImageElement>('.numi--completion.numi--pose-encouraging')?.src).toContain('/numi/encouraging.webp')
      if (complete) expect(root.dataset.motion).toBe('settled')
      expect(resultStore.saveCompleted).not.toHaveBeenCalled()
      expect(resultStore.listRanked).not.toHaveBeenCalled()
      expect(resultStore.listCompleted).not.toHaveBeenCalled()
      app.destroy()
    }
  })

  it('celebrates a fully resolved mastery review', () => {
    let source = createTrainingSession({ ...DEFAULT_CONFIG, problemCount: 1 }, 42, 1_000)
    source = skipCurrentProblem(source, 1_100)
    let review = createReviewSession(source, 2_000)!
    review = setCurrentDraft(review, review.problems[0]!.answer)
    review = checkCurrentAnswer(review, 2_100)
    review = advanceSession(review, 2_200)
    const state: PersistedAppState = { ...createPracticeState(), view: 'complete', session: review }
    const root = document.querySelector<HTMLElement>('#app')!
    const app = new MathTrainingApp(root, { store: createStore({ status: 'ok', state }), resultStore: createResultStore(), now: () => 3_000 })
    app.start()
    expect(root.textContent).toContain('Review complete.')
    expect(root.querySelector<HTMLImageElement>('.numi--completion.numi--pose-celebration')?.src).toContain('/numi/celebration.webp')
    expect(root.textContent).toContain('Every review question landed on the first try')
    app.destroy()
  })

  it('encourages a resolved mastery review that still needed a retry', () => {
    let source = createTrainingSession({ ...DEFAULT_CONFIG, problemCount: 1 }, 42, 1_000)
    source = skipCurrentProblem(source, 1_100)
    let review = createReviewSession(source, 2_000)!
    const answer = review.problems[0]!.answer
    review = setCurrentDraft(review, String(BigInt(answer) + 1n))
    review = checkCurrentAnswer(review, 2_050)
    review = setCurrentDraft(review, answer)
    review = checkCurrentAnswer(review, 2_100)
    review = advanceSession(review, 2_200)
    const state: PersistedAppState = { ...createPracticeState(), view: 'complete', session: review }
    const root = document.querySelector<HTMLElement>('#app')!
    const app = new MathTrainingApp(root, { store: createStore({ status: 'ok', state }), resultStore: createResultStore(), now: () => 3_000 })
    app.start()
    expect(root.querySelector<HTMLImageElement>('.numi--completion.numi--pose-encouraging')?.src).toContain('/numi/encouraging.webp')
    expect(root.textContent).toContain('You recovered every question')
    app.destroy()
  })

  it('announces a delayed sprint-history failure after focused review has started', async () => {
    const state = createPracticeState()
    const answer = state.session!.problems[0]!.answer
    let resolveSave: (value: ResultStoreWriteResult) => void = () => undefined
    const resultStore = createResultStore()
    resultStore.saveCompleted = vi.fn(() => new Promise<ResultStoreWriteResult>((resolve) => { resolveSave = resolve }))
    const root = document.querySelector<HTMLElement>('#app')!
    const app = new MathTrainingApp(root, { store: createStore({ status: 'ok', state }), resultStore, now: () => 2_000 })
    app.start()

    const input = root.querySelector<HTMLInputElement>('#answer-input')!
    input.value = String(BigInt(answer) + 1n)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    root.querySelector<HTMLFormElement>('#answer-form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    root.querySelector<HTMLInputElement>('#answer-input')!.value = answer
    root.querySelector<HTMLInputElement>('#answer-input')!.dispatchEvent(new Event('input', { bubbles: true }))
    root.querySelector<HTMLFormElement>('#answer-form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    root.querySelector<HTMLFormElement>('#answer-form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    root.querySelector<HTMLButtonElement>('[data-action="start-review"]')!.click()

    resolveSave({ status: 'quota-exceeded' })
    await vi.waitFor(() => expect(document.querySelector('#app-announcer')?.textContent).toContain('could not be saved'))
    expect(root.querySelector('.review-mode-badge')).not.toBeNull()
    app.destroy()
  })

  it('unlocks a restored sound preference before playing its first action cue', async () => {
    const state = createPracticeState()
    state.preferences.audioEnabled = true
    const audio = {
      unlockFromUserGesture: vi.fn(async () => true),
      play: vi.fn(),
      suspend: vi.fn(),
    }
    const root = document.querySelector<HTMLElement>('#app')!
    const app = new MathTrainingApp(root, {
      store: createStore({ status: 'ok', state }),
      now: () => 2_000,
      audio,
    })
    app.start()
    root.querySelector<HTMLButtonElement>('[data-action="skip"]')!.click()
    await Promise.resolve()
    await Promise.resolve()
    expect(audio.unlockFromUserGesture).toHaveBeenCalled()
    expect(audio.play).toHaveBeenCalledWith('skip')
    app.destroy()
  })

  it('invalidates a pending audio cue when practice is suspended', async () => {
    const state = createPracticeState()
    state.preferences.audioEnabled = true
    let resolveUnlock: (value: boolean) => void = () => undefined
    const pendingUnlock = new Promise<boolean>((resolve) => { resolveUnlock = resolve })
    const audio = {
      unlockFromUserGesture: vi.fn(() => pendingUnlock),
      play: vi.fn(),
      suspend: vi.fn(),
    }
    const root = document.querySelector<HTMLElement>('#app')!
    const app = new MathTrainingApp(root, {
      store: createStore({ status: 'ok', state }),
      now: () => 2_000,
      audio,
    })
    app.start()
    root.querySelector<HTMLButtonElement>('[data-action="skip"]')!.click()
    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    resolveUnlock(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(audio.play).not.toHaveBeenCalled()
    expect(audio.suspend).toHaveBeenCalled()
    app.destroy()
  })

  it('keeps completion usable while warning when private history cannot save', async () => {
    const resultStore = createResultStore()
    resultStore.saveCompleted = vi.fn(async () => ({ status: 'quota-exceeded' as const }))
    const root = document.querySelector<HTMLElement>('#app')!
    const app = new MathTrainingApp(root, {
      store: createStore({ status: 'ok', state: createPracticeState() }),
      resultStore,
      now: () => 2_000,
    })
    app.start()
    root.querySelector<HTMLButtonElement>('[data-action="skip"]')!.click()
    root.querySelector<HTMLFormElement>('#answer-form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(root.textContent).toContain('private rankings are unavailable'))
    await vi.waitFor(() => expect(document.querySelector('#app-announcer')?.textContent).toContain('could not be saved'))
    expect(root.textContent).toContain('Session complete.')
    app.destroy()
  })

  it('waits for a delayed completion save before showing refreshed Progress history', async () => {
    let resolveSave: (result: ResultStoreWriteResult) => void = () => undefined
    let savedResult: ReturnType<typeof createSprintResult> = null
    const save = new Promise<ResultStoreWriteResult>((resolve) => { resolveSave = resolve })
    const resultStore = createResultStore()
    resultStore.saveCompleted = vi.fn(async (result) => { savedResult = result; return await save })
    resultStore.listCompleted = vi.fn(async () => ({ ...emptyResultPage(), results: savedResult ? [savedResult] : [] }))
    const root = document.querySelector<HTMLElement>('#app')!
    const app = new MathTrainingApp(root, { store: createStore({ status: 'ok', state: createPracticeState() }), resultStore, now: () => 2_000 })
    app.start()
    await Promise.resolve()
    vi.mocked(resultStore.listCompleted).mockClear()
    root.querySelector<HTMLButtonElement>('[data-action="skip"]')!.click()
    root.querySelector<HTMLFormElement>('#answer-form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    root.querySelector<HTMLButtonElement>('[data-action="view-progress"]')!.click()

    expect(document.activeElement?.id).toBe('progress-heading')
    expect(resultStore.listCompleted).not.toHaveBeenCalled()
    resolveSave({ status: 'saved' })
    await vi.waitFor(() => expect(root.querySelectorAll('.history-list li')).toHaveLength(1))
    expect(resultStore.listCompleted).toHaveBeenCalledOnce()
    app.destroy()
  })

  it('surfaces corrupt records discovered while loading another history page', async () => {
    const resultStore = createResultStore()
    const listCompleted = vi.fn()
      .mockResolvedValueOnce({ ...emptyResultPage(), nextCursor: 'next-page' })
      .mockResolvedValueOnce({ ...emptyResultPage(), corruptRecords: 1 })
    resultStore.listCompleted = listCompleted
    const root = document.querySelector<HTMLElement>('#app')!
    const app = new MathTrainingApp(root, { store: createStore({ status: 'empty', state: null }), resultStore, now: () => 2_000 })
    app.start()
    root.querySelector<HTMLButtonElement>('[data-action="show-progress"]')!.click()
    await vi.waitFor(() => expect(root.querySelector('[data-action="load-history"]')).not.toBeNull())
    root.querySelector<HTMLButtonElement>('[data-action="load-history"]')!.click()
    await vi.waitFor(() => expect(root.textContent).toContain('History is unavailable'))
    expect(root.querySelector('[data-action="show-reset"]')).not.toBeNull()
    app.destroy()
  })

  it('shares only aggregate completion data and announces share outcomes', async () => {
    const share = { share: vi.fn(async (payload: SharePayload) => { void payload; return 'shared' as const }), copy: vi.fn(async (payload: SharePayload) => { void payload; return 'copied' as const }) }
    const root = document.querySelector<HTMLElement>('#app')!
    const app = new MathTrainingApp(root, {
      store: createStore({ status: 'ok', state: createPracticeState() }),
      resultStore: createResultStore(),
      share,
      now: () => 2_000,
    })
    app.start()
    root.querySelector<HTMLButtonElement>('[data-action="skip"]')!.click()
    root.querySelector<HTMLFormElement>('#answer-form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    root.querySelector<HTMLButtonElement>('[data-action="share-result"]')!.click()
    await vi.waitFor(() => expect(share.share).toHaveBeenCalledOnce())
    const payload = share.share.mock.calls[0]![0]
    expect(payload.text).toContain('Mental Math Sprint')
    expect(payload.text).not.toContain('session-')
    expect(payload.url).toBe('https://dmoliveira.github.io/mental-math-sprint/')
    await vi.waitFor(() => expect(document.querySelector('#app-announcer')?.textContent).toBe('Result shared.'))

    root.querySelector<HTMLButtonElement>('[data-action="copy-result"]')!.click()
    await vi.waitFor(() => expect(share.copy).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(document.querySelector('#app-announcer')?.textContent).toBe('Result copied.'))
    for (const link of root.querySelectorAll<HTMLAnchorElement>('.social-links a')) {
      expect(link.rel).toContain('noopener')
      expect(link.rel).toContain('noreferrer')
    }
    app.destroy()
  })

  it('falls back to horizontal rendering for chained questions', () => {
    const root = document.querySelector<HTMLElement>('#app')!
    const app = new MathTrainingApp(root, {
      store: createStore({ status: 'empty', state: null }),
      now: () => 1_000,
      createSeed: () => 7,
    })
    app.start()
    root.querySelector<HTMLInputElement>('#layout-vertical')!.click()
    root.querySelector<HTMLInputElement>('#operator-count-2')!.click()
    root.querySelector<HTMLFormElement>('#setup-form')!.dispatchEvent(
      new SubmitEvent('submit', { bubbles: true, cancelable: true }),
    )
    expect(root.querySelector('.expression--vertical')).toBeNull()
    expect(root.querySelector('.expression__pieces')).not.toBeNull()
    app.destroy()
  })

  it('persists theme and compact display controls from the header', () => {
    const store = createStore({ status: 'empty', state: null })
    const root = document.querySelector<HTMLElement>('#app')!
    const app = new MathTrainingApp(root, { store, now: () => 1_000 })
    app.start()
    expect(document.documentElement.dataset.theme).toBe('forest')
    expect(document.documentElement.dataset.density).toBe('comfortable')
    expect(root.querySelector('.footer-links')?.textContent).toContain('Bio')

    root.querySelector<HTMLButtonElement>('[data-action="cycle-theme"]')!.click()
    expect(document.documentElement.dataset.theme).toBe('midnight')
    expect(root.querySelector('.appearance-menu > summary')).toBe(document.activeElement)
    expect(root.dataset.motion).toBe('settled')
    root.querySelector<HTMLButtonElement>('[data-action="toggle-density"]')!.click()
    expect(document.documentElement.dataset.density).toBe('compact')
    expect(root.querySelector('.appearance-menu > summary')).toBe(document.activeElement)
    expect(store.save).toHaveBeenCalled()

    app.destroy()
    expect(document.documentElement.dataset.theme).toBeUndefined()
    expect(document.documentElement.dataset.density).toBeUndefined()
  })

  it('distinguishes unavailable storage from invalid saved progress', () => {
    const root = document.querySelector<HTMLElement>('#app')!
    const unavailableStore = createStore({ status: 'unavailable', state: null })
    const unavailableApp = new MathTrainingApp(root, { store: unavailableStore, now: () => 1_000 })
    unavailableApp.start()
    expect(root.textContent).toContain('Progress cannot be saved on this device')
    expect(unavailableStore.clear).not.toHaveBeenCalled()
    unavailableApp.destroy()

    document.body.innerHTML = '<div id="app"></div>'
    const invalidRoot = document.querySelector<HTMLElement>('#app')!
    const invalidStore = createStore({ status: 'invalid', state: null })
    const invalidApp = new MathTrainingApp(invalidRoot, { store: invalidStore, now: () => 1_000 })
    invalidApp.start()
    expect(invalidRoot.textContent).toContain('saved session could not be restored')
    expect(invalidStore.clearAll).toHaveBeenCalledOnce()
    expect(invalidStore.clear).not.toHaveBeenCalled()
    invalidApp.destroy()
  })
})
