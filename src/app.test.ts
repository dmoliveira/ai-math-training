import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MathTrainingApp } from './app'
import { DEFAULT_CONFIG } from './math/engine'
import { DEFAULT_PREFERENCES } from './sprint/contracts'
import type { ResultPage, ResultStore } from './sprint/results'
import { createTrainingSession, pauseSession } from './state/session'
import {
  APP_SCHEMA_VERSION,
  type PersistedAppState,
  type StoreLoadResult,
} from './storage/progress-store'

const createPracticeState = (): PersistedAppState => {
  const config = { ...DEFAULT_CONFIG, operations: [...DEFAULT_CONFIG.operations], problemCount: 1 }
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
  save: vi.fn(() => true),
  clear: vi.fn(() => true),
  clearAll: vi.fn(() => true),
})

const emptyResultPage = (): ResultPage => ({
  status: 'ok',
  results: [],
  nextCursor: null,
  corruptRecords: 0,
})

const createResultStore = (): ResultStore => ({
  saveCompleted: vi.fn(async () => ({ status: 'saved' as const })),
  getById: vi.fn(async () => null),
  listCompleted: vi.fn(async () => emptyResultPage()),
  listRanked: vi.fn(async () => emptyResultPage()),
  listCompletedSince: vi.fn(async () => emptyResultPage()),
  clearConfig: vi.fn(async () => ({ status: 'cleared' as const })),
})

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
    submitWrongAnswer()
    expect(document.querySelector('#app-announcer')).toBe(announcer)
    expect(announcer.textContent).toBe('Incorrect. Try again.')

    app.destroy()
    expect(announcer.isConnected).toBe(false)
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
    expect(root.textContent).toContain('20 seconds added to your scored time')
    expect(root.textContent).toContain('100% complete')
    expect(root.querySelector('#question-time')?.textContent).toBe('00:03')
    expect(audio.play).toHaveBeenCalledWith('skip')

    root.querySelector<HTMLFormElement>('#answer-form')!.dispatchEvent(
      new SubmitEvent('submit', { bubbles: true, cancelable: true }),
    )
    expect(root.textContent).toContain('Session complete.')
    expect(root.textContent).not.toContain('Perfect run!')
    expect(root.textContent).toContain('Scored time')
    expect(root.textContent).toContain('00:23')
    expect(root.textContent).toContain('Skipped (+20s)')
    expect(audio.play).toHaveBeenCalledWith('complete')
    await vi.waitFor(() => expect(resultStore.saveCompleted).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(root.textContent).toContain('Personal top five'))
    expect(root.textContent).toContain('New best')

    app.destroy()
    expect(audio.suspend).toHaveBeenCalled()
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

  it('surfaces corrupt records discovered while loading another history page', async () => {
    const resultStore = createResultStore()
    const listCompleted = vi.fn()
      .mockResolvedValueOnce({ ...emptyResultPage(), nextCursor: 'next-page' })
      .mockResolvedValueOnce({ ...emptyResultPage(), corruptRecords: 1 })
    resultStore.listCompleted = listCompleted
    const root = document.querySelector<HTMLElement>('#app')!
    const app = new MathTrainingApp(root, { store: createStore({ status: 'empty', state: null }), resultStore, now: () => 2_000 })
    app.start()
    await vi.waitFor(() => expect(root.querySelector('[data-action="load-history"]')).not.toBeNull())
    root.querySelector<HTMLButtonElement>('[data-action="load-history"]')!.click()
    await vi.waitFor(() => expect(root.textContent).toContain('History is unavailable'))
    expect(root.querySelector('[data-action="show-reset"]')).not.toBeNull()
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
