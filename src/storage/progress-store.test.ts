import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG } from '../math/engine'
import { DEFAULT_PREFERENCES } from '../sprint/contracts'
import { advanceSession, createTrainingSession, pauseSession, revealCurrentAnswer } from '../state/session'
import {
  APP_SCHEMA_VERSION,
  ProgressStore,
  STORAGE_KEY,
  V1_STORAGE_KEY,
  V2_STORAGE_KEY,
  type PersistedAppState,
  type StorageLike,
} from './progress-store'

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

const createState = (): PersistedAppState => ({
  schemaVersion: APP_SCHEMA_VERSION,
  view: 'practice',
  settings: { ...DEFAULT_CONFIG, operations: [...DEFAULT_CONFIG.operations], problemCount: 1 },
  preferences: { ...DEFAULT_PREFERENCES },
  session: createTrainingSession({ ...DEFAULT_CONFIG, problemCount: 1 }, 42, 1_000),
})

describe('progress store', () => {
  it('round-trips a valid state and stores a paused timer snapshot', () => {
    const storage = new MemoryStorage()
    const store = new ProgressStore(storage)
    const state = createState()

    expect(store.save(state, 4_000)).toBe(true)
    expect(state.session?.timerStartedAt).toBe(1_000)

    const loaded = store.load()
    expect(loaded.status).toBe('ok')
    expect(loaded.state?.session).toMatchObject({
      seed: 42,
      elapsedMs: 3_000,
      timerStartedAt: null,
    })
    expect(loaded.state?.settings).toEqual(state.settings)
  })

  it('rejects malformed JSON, stale versions, and tampered answers', () => {
    const storage = new MemoryStorage()
    const store = new ProgressStore(storage)

    storage.values.set(STORAGE_KEY, '{')
    expect(store.load()).toEqual({ status: 'invalid', state: null })

    storage.values.set(STORAGE_KEY, JSON.stringify({ schemaVersion: 99 }))
    expect(store.load()).toEqual({ status: 'invalid', state: null })

    const state = createState()
    if (!state.session) return
    state.session.problems[0] = { ...state.session.problems[0]!, answer: '999999' }
    storage.values.set(STORAGE_KEY, JSON.stringify(state))
    expect(store.load()).toEqual({ status: 'invalid', state: null })
  })

  it('rejects internally inconsistent progress and completion state', () => {
    const storage = new MemoryStorage()
    const store = new ProgressStore(storage)

    const expectRejected = (mutate: (state: PersistedAppState) => void): void => {
      const state = structuredClone(createState())
      mutate(state)
      storage.values.set(STORAGE_KEY, JSON.stringify(state))
      expect(store.load()).toEqual({ status: 'invalid', state: null })
    }

    expectRejected((state) => {
      const progress = state.session?.progress[0]
      if (!progress) return
      progress.status = 'correct'
      progress.feedback = 'correct'
      progress.attempts = 1
      progress.draft = '999999'
    })

    expectRejected((state) => {
      const progress = state.session?.progress[0]
      if (!progress) return
      progress.feedback = 'correct'
    })

    expectRejected((state) => {
      if (!state.session) return
      state.session.completedAt = 2_000
      state.session.timerStartedAt = null
    })

    expectRejected((state) => {
      if (!state.session) return
      state.session.mistakes = 3
    })

    expectRejected((state) => {
      if (!state.session) return
      state.session.createdAt = -1
    })

    expectRejected((state) => {
      if (!state.session) return
      state.session.timerStartedAt = state.session.createdAt - 1
    })

    expectRejected((state) => {
      if (!state.session) return
      state.session.elapsedMs = Number.MAX_SAFE_INTEGER + 1
    })

    const completedState = createState()
    if (completedState.session) {
      completedState.session = advanceSession(revealCurrentAnswer(completedState.session, 1_500), 2_000)
      completedState.view = 'complete'
      completedState.session.completedAt = completedState.session.createdAt - 1
      storage.values.set(STORAGE_KEY, JSON.stringify(completedState))
      expect(store.load()).toEqual({ status: 'invalid', state: null })
    }
  })

  it('rejects exact sessions whose aggregate and per-problem elapsed times disagree', () => {
    const storage = new MemoryStorage()
    const state = createState()
    if (!state.session) return
    state.session.elapsedMs = 10
    state.session.progress[0]!.activeElapsedMs = 20
    storage.values.set(V2_STORAGE_KEY, JSON.stringify(state))
    expect(new ProgressStore(storage).load()).toEqual({ status: 'invalid', state: null })
  })

  it('reports unavailable or throwing storage without breaking practice', () => {
    const unavailable = new ProgressStore(null)
    expect(unavailable.load()).toEqual({ status: 'unavailable', state: null })
    expect(unavailable.save(createState(), 0)).toBe(false)
    expect(unavailable.clear()).toBe(false)

    const throwing: StorageLike = {
      getItem: () => {
        throw new DOMException('blocked')
      },
      setItem: () => {
        throw new DOMException('quota')
      },
      removeItem: () => {
        throw new DOMException('blocked')
      },
    }
    const store = new ProgressStore(throwing)
    expect(store.load()).toEqual({ status: 'unavailable', state: null })
    expect(store.save(createState(), 0)).toBe(false)
    expect(store.clear()).toBe(false)
  })

  it('migrates a real v1 shape without fabricating per-problem timing or deleting rollback data', () => {
    const storage = new MemoryStorage()
    const session = pauseSession(createTrainingSession({ ...DEFAULT_CONFIG, problemCount: 1 }, 42, 1_000), 4_000)
    const legacySession = {
      schemaVersion: 1,
      config: session.config,
      seed: session.seed,
      problems: session.problems,
      progress: session.progress.map((item) => ({
        draft: item.draft,
        attempts: item.attempts,
        status: item.status,
        feedback: item.feedback,
      })),
      currentIndex: session.currentIndex,
      mistakes: session.mistakes,
      elapsedMs: session.elapsedMs,
      timerStartedAt: null,
      createdAt: session.createdAt,
      completedAt: session.completedAt,
    }
    const legacyRaw = JSON.stringify({
      schemaVersion: 1,
      view: 'practice',
      settings: session.config,
      session: legacySession,
    })
    storage.values.set(V1_STORAGE_KEY, legacyRaw)

    const loaded = new ProgressStore(storage).load()
    expect(loaded.status).toBe('ok')
    expect(loaded.state?.preferences).toEqual(DEFAULT_PREFERENCES)
    expect(loaded.state?.session).toMatchObject({
      timingQuality: 'legacy-partial',
      elapsedMs: 3_000,
      timerStartedAt: null,
      currentProblemStartedAt: null,
    })
    expect(loaded.state?.session?.progress[0]?.activeElapsedMs).toBeNull()
    expect(storage.values.get(V1_STORAGE_KEY)).toBe(legacyRaw)
    expect(storage.values.has(V2_STORAGE_KEY)).toBe(true)
  })

  it('keeps valid v1 data when v2 is invalid or migration persistence fails', () => {
    const source = new MemoryStorage()
    const session = createTrainingSession({ ...DEFAULT_CONFIG, problemCount: 1 }, 42, 1_000)
    const legacyRaw = JSON.stringify({
      schemaVersion: 1,
      view: 'practice',
      settings: session.config,
      session: {
        schemaVersion: 1,
        config: session.config,
        seed: session.seed,
        problems: session.problems,
        progress: session.progress.map((item) => ({
        draft: item.draft,
        attempts: item.attempts,
        status: item.status,
        feedback: item.feedback,
      })),
        currentIndex: 0,
        mistakes: 0,
        elapsedMs: 0,
        timerStartedAt: null,
        createdAt: 1_000,
        completedAt: null,
      },
    })
    source.values.set(V1_STORAGE_KEY, legacyRaw)
    source.values.set(V2_STORAGE_KEY, '{')
    const recovered = new ProgressStore(source).load()
    expect(recovered.status).toBe('ok')
    expect(recovered.state?.session?.timingQuality).toBe('legacy-partial')
    expect(source.values.get(V1_STORAGE_KEY)).toBe(legacyRaw)

    source.values.delete(V2_STORAGE_KEY)
    const migrationWriteFails: StorageLike = {
      getItem: (key) => source.getItem(key),
      setItem: () => {
        throw new DOMException('quota')
      },
      removeItem: (key) => source.removeItem(key),
    }
    expect(new ProgressStore(migrationWriteFails).load().status).toBe('ok')
    expect(source.values.get(V1_STORAGE_KEY)).toBe(legacyRaw)
  })

  it('clears v2 separately from the destructive all-data reset', () => {
    const storage = new MemoryStorage()
    storage.values.set(V1_STORAGE_KEY, 'legacy')
    storage.values.set(V2_STORAGE_KEY, 'current')
    const store = new ProgressStore(storage)

    expect(store.clear()).toBe(true)
    expect(storage.values.has(V2_STORAGE_KEY)).toBe(false)
    expect(storage.values.get(V1_STORAGE_KEY)).toBe('legacy')
    expect(store.clearAll()).toBe(true)
    expect(storage.values.has(V1_STORAGE_KEY)).toBe(false)
  })

  it('clears saved progress', () => {
    const storage = new MemoryStorage()
    const store = new ProgressStore(storage)
    expect(store.save(createState(), 2_000)).toBe(true)
    expect(store.clear()).toBe(true)
    expect(store.load()).toEqual({ status: 'empty', state: null })
  })
})
