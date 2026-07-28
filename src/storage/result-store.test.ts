import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG } from '../math/engine'
import {
  advanceSession,
  createTrainingSession,
  skipCurrentProblem,
} from '../state/session'
import { createSprintResult, type SprintResult } from '../sprint/results'
import { IndexedDbResultStore } from './result-store'

let databaseSequence = 0

function resultAt(completedAt: number, seed: number, config = DEFAULT_CONFIG): SprintResult {
  const sessionConfig = { ...config, operations: [...config.operations], problemCount: 1 }
  let session = createTrainingSession(sessionConfig, seed, completedAt - 100)
  session = skipCurrentProblem(session, completedAt - 50)
  session = advanceSession(session, completedAt)
  const result = createSprintResult(session)
  if (!result) throw new Error('Expected result')
  return result
}

function createStore(cap = 500_000): IndexedDbResultStore {
  databaseSequence += 1
  return new IndexedDbResultStore(indexedDB, IDBKeyRange, cap, `result-store-test-${databaseSequence}`)
}

describe('IndexedDbResultStore', () => {
  it('degrades safely when IndexedDB is unavailable', async () => {
    const store = new IndexedDbResultStore(null, null)
    expect(await store.saveCompleted(resultAt(1_000, 1))).toEqual({ status: 'unavailable' })
    expect(await store.listCompleted('missing')).toMatchObject({ status: 'unavailable', results: [] })
    expect(await store.clearConfig('missing')).toEqual({ status: 'unavailable' })
  })

  it('saves idempotently and queries chronological and ranked results', async () => {
    const store = createStore()
    const first = resultAt(1_000, 1)
    const second = resultAt(2_000, 2)
    second.totals.scoredElapsedMs = first.totals.scoredElapsedMs - 1
    second.totals.activeElapsedMs -= 1
    second.problems[0]!.activeElapsedMs! -= 1
    second.problems[0]!.scoredElapsedMs! -= 1

    expect(await store.saveCompleted(first)).toEqual({ status: 'saved' })
    expect(await store.saveCompleted(first)).toEqual({ status: 'duplicate' })
    expect(await store.saveCompleted(second)).toEqual({ status: 'saved' })
    expect((await store.listCompleted(first.configKey)).results.map((item) => item.id)).toEqual([
      second.id,
      first.id,
    ])
    expect((await store.listRanked(first.configKey)).results.map((item) => item.id)).toEqual([
      second.id,
      first.id,
    ])
    expect(await store.getById(first.id)).toEqual(first)
  })

  it('paginates exclusively without gaps or duplicates', async () => {
    const store = createStore()
    const results = [resultAt(1_000, 1), resultAt(2_000, 2), resultAt(3_000, 3)]
    for (const result of results) expect((await store.saveCompleted(result)).status).toBe('saved')

    const firstPage = await store.listCompleted(results[0]!.configKey, undefined, 2)
    expect(firstPage.results.map((item) => item.completedAt)).toEqual([3_000, 2_000])
    expect(firstPage.nextCursor).not.toBeNull()
    const secondPage = await store.listCompleted(results[0]!.configKey, firstPage.nextCursor!, 2)
    expect(secondPage.results.map((item) => item.completedAt)).toEqual([1_000])
    expect(secondPage.nextCursor).toBeNull()
    expect((await store.listCompleted(results[0]!.configKey, 'bad')).status).toBe('failed')
  })

  it('prunes the oldest result only within the affected configuration', async () => {
    const store = createStore(2)
    const otherConfig = { ...DEFAULT_CONFIG, operations: ['multiply'] as const }
    const first = resultAt(1_000, 1)
    const second = resultAt(2_000, 2)
    const third = resultAt(3_000, 3)
    const other = resultAt(1_500, 4, { ...otherConfig, operations: [...otherConfig.operations] })
    for (const result of [first, second, other, third]) {
      expect((await store.saveCompleted(result)).status).toBe('saved')
    }

    expect((await store.listCompleted(first.configKey)).results.map((item) => item.id)).toEqual([
      third.id,
      second.id,
    ])
    expect((await store.listCompleted(other.configKey)).results).toHaveLength(1)
  })

  it('queries a completion range and clears one configuration', async () => {
    const store = createStore()
    const first = resultAt(1_000, 1)
    const second = resultAt(2_000, 2)
    await store.saveCompleted(first)
    await store.saveCompleted(second)
    expect((await store.listCompletedSince(first.configKey, 1_500)).results.map((item) => item.id)).toEqual([
      second.id,
    ])
    expect(await store.clearConfig(first.configKey)).toEqual({ status: 'cleared' })
    expect((await store.listCompleted(first.configKey)).results).toEqual([])
  })
})
