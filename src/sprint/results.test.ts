import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG } from '../math/engine'
import {
  advanceSession,
  checkCurrentAnswer,
  createReviewSession,
  createTrainingSession,
  setCurrentDraft,
  skipCurrentProblem,
} from '../state/session'
import {
  createSharePayload,
  createSprintResult,
  dailyStatistics,
  rankResults,
  type SprintResult,
} from './results'

function completedResult(): SprintResult {
  const config = { ...DEFAULT_CONFIG, operations: [...DEFAULT_CONFIG.operations], problemCount: 2 }
  let session = createTrainingSession(config, 7, 0)
  const answer = session.problems[0]!.answer
  session = setCurrentDraft(session, answer)
  session = checkCurrentAnswer(session, 1_000)
  session = advanceSession(session, 3_000)
  session = skipCurrentProblem(session, 5_000)
  session = advanceSession(session, 8_000)
  const result = createSprintResult(session)
  if (!result) throw new Error('Expected completed result')
  return result
}

describe('Sprint results', () => {
  it('never projects review sessions into scored history results', () => {
    let source = createTrainingSession({ ...DEFAULT_CONFIG, problemCount: 1 }, 8, 1_000)
    source = skipCurrentProblem(source, 1_100)
    const review = createReviewSession(source, 2_000)
    expect(review).not.toBeNull()
    expect(review && createSprintResult(review)).toBeNull()
  })

  it('projects immutable scored results and excludes feedback delay', () => {
    const result = completedResult()
    expect(result.totals).toMatchObject({
      problems: 2,
      correct: 1,
      skipped: 1,
      activeElapsedMs: 3_000,
      penaltyMs: 20_000,
      scoredElapsedMs: 23_000,
    })
    expect(result.rankEligible).toBe(true)
    expect(result.problems.map((problem) => problem.scoredElapsedMs)).toEqual([1_000, 22_000])
  })

  it('rejects incomplete sessions', () => {
    expect(createSprintResult(createTrainingSession(DEFAULT_CONFIG, 1, 0))).toBeNull()
  })

  it('preserves legacy results while excluding them from rankings', () => {
    const result = completedResult()
    const session = createTrainingSession({ ...DEFAULT_CONFIG, problemCount: 1 }, 4, 0)
    const legacy = {
      ...session,
      timingQuality: 'legacy-partial' as const,
      completedAt: 1_000,
      timerStartedAt: null,
      currentProblemStartedAt: null,
      progress: session.progress.map((item) => ({
        ...item,
        status: 'skipped' as const,
        feedback: 'skipped' as const,
        activeElapsedMs: null,
      })),
    }
    const projected = createSprintResult(legacy)
    expect(projected).not.toBeNull()
    expect(projected?.rankEligible).toBe(false)
    expect(rankResults([result, projected!])).toEqual([result])
  })

  it('ranks eligible results with stable score, mistake, timestamp, and id ties', () => {
    const base = completedResult()
    const slower = structuredClone(base)
    slower.id = 'slower'
    slower.totals.scoredElapsedMs += 1
    const fewerMistakes = structuredClone(base)
    fewerMistakes.id = 'fewer'
    fewerMistakes.totals.mistakes = 0
    const ineligible = structuredClone(base)
    ineligible.id = 'ineligible'
    ineligible.rankEligible = false

    expect(rankResults([slower, base, ineligible, fewerMistakes]).map((item) => item.id)).toEqual([
      'fewer',
      base.id,
      'slower',
    ])
  })

  it('buckets best, average, and median by an explicit timezone', () => {
    const first = completedResult()
    first.completedAt = Date.parse('2026-03-08T04:30:00Z')
    const second = structuredClone(first)
    second.id = 'second'
    second.completedAt = Date.parse('2026-03-08T07:30:00Z')
    second.totals.scoredElapsedMs = 25_000

    expect(dailyStatistics([first, second], 'America/New_York')).toEqual([
      { date: '2026-03-07', count: 1, bestMs: 23_000, averageMs: 23_000, medianMs: 23_000 },
      { date: '2026-03-08', count: 1, bestMs: 25_000, averageMs: 25_000, medianMs: 25_000 },
    ])
  })

  it('creates an aggregate-only, privacy-safe share payload', () => {
    const result = completedResult()
    const payload = createSharePayload(result, 'https://example.test/sprint')
    expect(payload.title).toBe('Mental Math Sprint result')
    expect(payload.text).toContain('23.0s scored time')
    expect(payload.text).not.toContain(result.sessionId)
    for (const problem of result.problems) {
      expect(payload.text).not.toContain(problem.problemId)
      expect(payload.text).not.toContain(problem.operands.join(' '))
    }
  })
})
