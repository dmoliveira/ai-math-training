import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MathTrainingApp } from './app'
import { DEFAULT_CONFIG } from './math/engine'
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
    session,
  }
}

const createStore = (result: StoreLoadResult) => ({
  load: vi.fn(() => result),
  save: vi.fn(() => true),
  clear: vi.fn(() => true),
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
    expect(invalidStore.clear).toHaveBeenCalledOnce()
    invalidApp.destroy()
  })
})
