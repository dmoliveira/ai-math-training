import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG } from '../math/engine'
import { createReviewSession, createTrainingSession, skipCurrentProblem } from '../state/session'
import { configKey } from './contracts'
import { createSprintDebrief, selectHistoricalFocus } from './debrief'
import type { SprintProblemResult, SprintResult } from './results'

describe('sprint debrief', () => {
  it('returns no debrief for incomplete sprints or reviews', () => {
    const sprint = createTrainingSession({ ...DEFAULT_CONFIG, problemCount: 1 }, 1, 0)
    expect(createSprintDebrief(sprint)).toBeNull()
    const review = createReviewSession(skipCurrentProblem(sprint, 10), 20)!
    expect(createSprintDebrief({ ...review, completedAt: 30 })).toBeNull()
  })

  it('derives factual ordered evidence and focus priority without mutating the session', () => {
    const session = createTrainingSession({ ...DEFAULT_CONFIG, problemCount: 4 }, 2, 0)
    const completed = {
      ...session,
      completedAt: 100,
      progress: [
        { draft: session.problems[0]!.answer, attempts: 1, status: 'correct' as const, feedback: 'correct' as const, activeElapsedMs: 5_000 },
        { draft: session.problems[1]!.answer, attempts: 3, status: 'correct' as const, feedback: 'correct' as const, activeElapsedMs: 9_000 },
        { draft: '', attempts: 2, status: 'skipped' as const, feedback: 'skipped' as const, activeElapsedMs: null },
        { draft: session.problems[3]!.answer, attempts: 1, status: 'revealed' as const, feedback: 'revealed' as const, activeElapsedMs: 7_000 },
      ],
    }
    const before = structuredClone(completed)
    const debrief = createSprintDebrief(completed)!
    expect(debrief.items.map((item) => item.outcomeLabel)).toEqual([
      'Correct first try',
      'Correct after 2 retries',
      'Skipped after 2 attempts · +20s',
      'Answer revealed after 1 attempt',
    ])
    expect(debrief.focusItems.map((item) => item.outcome)).toEqual(['revealed', 'skipped', 'retried'])
    expect(debrief.longest?.index).toBe(1)
    expect(completed).toEqual(before)
  })
})

describe('historical focus selection', () => {
  it('sanitizes, prioritizes, deduplicates, and caps exact-config candidates', () => {
    const config = { ...DEFAULT_CONFIG, problemCount: 6 }
    const expressions = [
      problem(['8', '7'], ['add'], 'revealed', 1, 4_000),
      problem(['9', '6'], ['add'], 'skipped', 2, 8_000),
      problem(['7', '5'], ['add'], 'correct', 3, 10_000),
      problem(['8', '7'], ['add'], 'correct', 4, 12_000),
      problem(['4', '3'], ['add'], 'correct', 2, null),
      problem(['6', '2'], ['add'], 'correct', 2, 2_000),
      problem(['5', '1'], ['add'], 'correct', 2, 1_000),
    ]
    const result = resultWith(config, expressions, 2_000, 'new')
    const before = structuredClone(result)
    const selected = selectHistoricalFocus([result], config)
    expect(selected).toHaveLength(5)
    expect(selected[0]?.outcomeLabel).toBe('Answer revealed after 1 attempt')
    expect(selected[1]?.outcomeLabel).toBe('Skipped after 2 attempts · +20s')
    expect(selected.filter((item) => item.problem.operands.join(',') === '8,7')).toHaveLength(1)
    expect(new Set(selected.map((item) => item.problem.id)).size).toBe(5)
    expect(result).toEqual(before)
  })

  it('skips malformed candidates without evaluating oversized or incoherent expressions', () => {
    const config = { ...DEFAULT_CONFIG, problemCount: 1 }
    const valid = problem(['8', '7'], ['add'], 'correct', 2, 1_000)
    const invalid: unknown[] = [
      { ...valid, operands: ['8'] },
      { ...valid, operands: ['100000', '1'] },
      { ...valid, operands: ['0', '1'] },
      { ...valid, operators: ['divide'], operands: ['8', '3'] },
      { ...valid, operators: ['multiply'] },
      { ...valid, attempts: 0 },
      { ...valid, penaltyMs: 20_000 },
      { ...valid, activeElapsedMs: null, scoredElapsedMs: 1_000 },
      null,
    ]
    const malformed = resultWith(config, [valid, ...invalid] as SprintProblemResult[], 1_000, 'malformed')
    const selected = selectHistoricalFocus([malformed], config)
    expect(selected).toHaveLength(1)
    expect(selected[0]?.problem.answer).toBe('15')
  })

  it('uses only the newest initial 25 exact-key results', () => {
    const config = { ...DEFAULT_CONFIG, problemCount: 1 }
    const results = Array.from({ length: 26 }, (_, index) => resultWith(
      config,
      [index === 25 ? problem(['9', '9'], ['add'], 'revealed', 0, 1_000) : problem(['1', '1'], ['add'], 'correct', 1, 1_000)],
      100 - index,
      String(index),
    ))
    expect(selectHistoricalFocus(results, config)).toEqual([])
    expect(selectHistoricalFocus([{ ...results[0]!, configKey: 'other' }], config)).toEqual([])
  })
})

function problem(
  operands: string[],
  operators: SprintProblemResult['operators'],
  outcome: SprintProblemResult['outcome'],
  attempts: number,
  activeElapsedMs: number | null,
): SprintProblemResult {
  const penaltyMs = outcome === 'skipped' ? 20_000 : 0
  return {
    problemId: '',
    operands,
    operators,
    outcome,
    attempts,
    activeElapsedMs,
    penaltyMs,
    scoredElapsedMs: activeElapsedMs === null ? null : activeElapsedMs + penaltyMs,
  }
}

function resultWith(
  config: typeof DEFAULT_CONFIG,
  problems: SprintProblemResult[],
  completedAt: number,
  id: string,
): SprintResult {
  return {
    schemaVersion: 1,
    id,
    sessionId: `session-${id}`,
    configKey: configKey(config),
    config: { ...config, operations: [...config.operations] },
    completedAt,
    timingQuality: 'exact',
    rankEligible: true,
    totals: { problems: problems.length, correct: 0, skipped: 0, revealed: 0, mistakes: 0, firstTryCorrect: 0, accuracyPercent: 0, activeElapsedMs: 0, penaltyMs: 0, scoredElapsedMs: 0 },
    problems,
  }
}
