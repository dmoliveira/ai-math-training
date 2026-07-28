import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG } from '../math/engine'
import { createTrainingSession } from '../state/session'
import {
  APP_SCHEMA_VERSION,
  ProgressStore,
  STORAGE_KEY,
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
    expect(store.load()).toEqual({ status: 'invalid', state: null })
    expect(store.save(createState(), 0)).toBe(false)
    expect(store.clear()).toBe(false)
  })

  it('clears saved progress', () => {
    const storage = new MemoryStorage()
    const store = new ProgressStore(storage)
    expect(store.save(createState(), 2_000)).toBe(true)
    expect(store.clear()).toBe(true)
    expect(store.load()).toEqual({ status: 'empty', state: null })
  })
})
