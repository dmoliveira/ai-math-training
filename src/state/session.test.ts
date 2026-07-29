import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG, type TrainingConfig } from '../math/engine'
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
  getPenaltyMs,
  getScoredElapsedMs,
  normalizeAnswer,
  pauseSession,
  resumeSession,
  restartReviewSession,
  revealCurrentAnswer,
  setCurrentDraft,
  skipCurrentProblem,
  summarizeSession,
} from './session'

const oneQuestion: TrainingConfig = { ...DEFAULT_CONFIG, problemCount: 1 }

describe('training session', () => {
  it('counts wrong attempts and stops exact problem timing on a correct answer', () => {
    let session = createTrainingSession(oneQuestion, 12, 1_000)
    const answer = session.problems[0]?.answer
    expect(answer).toBeDefined()
    if (!answer) return

    session = setCurrentDraft(session, String(BigInt(answer) + 1n))
    session = checkCurrentAnswer(session, 2_000)
    expect(session.mistakes).toBe(1)
    expect(session.progress[0]).toMatchObject({ attempts: 1, status: 'pending', feedback: 'incorrect' })

    session = setCurrentDraft(session, answer)
    session = checkCurrentAnswer(session, 4_000)
    expect(session.progress[0]).toMatchObject({
      attempts: 2,
      status: 'correct',
      feedback: 'correct',
      activeElapsedMs: 3_000,
    })
    expect(session.elapsedMs).toBe(3_000)
    expect(session.timerStartedAt).toBeNull()
    expect(session.mistakes).toBe(1)

    expect(setCurrentDraft(session, '999')).toBe(session)
    expect(checkCurrentAnswer(session, 9_000)).toBe(session)
  })

  it('reveals once, excludes feedback delay, and completes on advance', () => {
    let session = createTrainingSession(oneQuestion, 5, 2_000)
    session = setCurrentDraft(session, '123')
    session = revealCurrentAnswer(session, 7_000)

    expect(session.progress[0]).toMatchObject({
      draft: session.problems[0]?.answer,
      attempts: 0,
      status: 'revealed',
      feedback: 'revealed',
      activeElapsedMs: 5_000,
    })
    expect(session.mistakes).toBe(1)
    expect(revealCurrentAnswer(session, 8_000)).toBe(session)

    session = advanceSession(session, 12_000)
    expect(session.completedAt).toBe(12_000)
    expect(session.timerStartedAt).toBeNull()
    expect(session.elapsedMs).toBe(5_000)
    expect(advanceSession(session, 13_000)).toBe(session)
  })

  it('tracks session and current-problem active time across pause and resume', () => {
    let session = createTrainingSession(oneQuestion, 9, 1_000)
    expect(getElapsedMs(session, 4_000)).toBe(3_000)
    expect(getCurrentProblemElapsedMs(session, 4_000)).toBe(3_000)

    session = pauseSession(session, 4_000)
    expect(getElapsedMs(session, 10_000)).toBe(3_000)
    expect(session.progress[0]?.activeElapsedMs).toBe(3_000)
    expect(pauseSession(session, 11_000)).toBe(session)

    session = resumeSession(session, 20_000)
    expect(getElapsedMs(session, 22_500)).toBe(5_500)
    session = pauseSession(session, 22_500)
    expect(session.progress[0]?.activeElapsedMs).toBe(5_500)
    expect(getCurrentProblemElapsedMs(session, 99_000)).toBe(5_500)
  })

  it('adds exactly twenty seconds per skip without changing active time', () => {
    const config = { ...DEFAULT_CONFIG, problemCount: 2 }
    let session = createTrainingSession(config, 2, 0)

    session = skipCurrentProblem(session, 1_000)
    expect(session.progress[0]).toMatchObject({ status: 'skipped', activeElapsedMs: 1_000 })
    expect(getPenaltyMs(session)).toBe(20_000)
    expect(getScoredElapsedMs(session, 4_000)).toBe(21_000)
    expect(skipCurrentProblem(session, 4_000)).toBe(session)

    session = advanceSession(session, 5_000)
    session = skipCurrentProblem(session, 7_000)
    expect(session.elapsedMs).toBe(3_000)
    expect(getPenaltyMs(session)).toBe(40_000)
    expect(getScoredElapsedMs(session, 9_000)).toBe(43_000)
  })

  it('summarizes first-try accuracy, skips, and scored time independently', () => {
    const config = { ...DEFAULT_CONFIG, problemCount: 2 }
    let session = createTrainingSession(config, 2, 0)
    const firstAnswer = session.problems[0]?.answer
    expect(firstAnswer).toBeTruthy()
    if (!firstAnswer) return

    session = setCurrentDraft(session, firstAnswer)
    session = checkCurrentAnswer(session, 100)
    session = advanceSession(session, 200)
    session = skipCurrentProblem(session, 500)

    expect(summarizeSession(session, 800)).toMatchObject({
      total: 2,
      solved: 1,
      skipped: 1,
      revealed: 0,
      firstTryCorrect: 1,
      accuracy: 50,
      mistakes: 0,
      elapsedMs: 400,
      penaltyMs: 20_000,
      scoredElapsedMs: 20_400,
    })
  })

  it('builds an exact review from corrected, skipped, and revealed questions in source order', () => {
    const config = { ...DEFAULT_CONFIG, problemCount: 4 }
    let source = createTrainingSession(config, 77, 1_000)
    const first = source.problems[0]!
    const second = source.problems[1]!

    source = setCurrentDraft(source, first.answer)
    source = checkCurrentAnswer(source, 1_100)
    source = advanceSession(source, 1_200)
    source = setCurrentDraft(source, String(BigInt(second.answer) + 1n))
    source = checkCurrentAnswer(source, 1_300)
    source = setCurrentDraft(source, second.answer)
    source = checkCurrentAnswer(source, 1_400)
    source = advanceSession(source, 1_500)
    source = skipCurrentProblem(source, 1_600)
    source = advanceSession(source, 1_700)
    source = revealCurrentAnswer(source, 1_800)

    const review = createReviewSession(source, 2_000)
    expect(review).not.toBeNull()
    expect(review?.mode).toBe('review')
    expect(review?.config.problemCount).toBe(3)
    expect(review?.problems.map(({ operands, operators, answer }) => ({ operands, operators, answer }))).toEqual(source.problems.slice(1).map(({ operands, operators, answer }) => ({ operands, operators, answer })))
    expect(new Set(review?.problems.map((problem) => problem.id)).size).toBe(3)
    expect(review?.problems[0]).not.toBe(source.problems[1])
    expect(review?.progress).toEqual(Array.from({ length: 3 }, () => ({
      draft: '', attempts: 0, status: 'pending', feedback: 'none', activeElapsedMs: 0,
    })))
    expect(review?.timerStartedAt).toBe(2_000)
    expect(createReviewSession(createTrainingSession(oneQuestion, 1, 0), 2_000)).toBeNull()
  })

  it('restarts review sessions with the same exact questions and no skip penalty', () => {
    let source = createTrainingSession(oneQuestion, 22, 1_000)
    source = skipCurrentProblem(source, 1_100)
    const review = createReviewSession(source, 2_000)!
    const restarted = restartReviewSession(review, 3_000)

    expect(restarted.id).not.toBe(review.id)
    expect(restarted.problems.map(({ operands, operators, answer }) => ({ operands, operators, answer }))).toEqual(review.problems.map(({ operands, operators, answer }) => ({ operands, operators, answer })))
    expect(restarted.problems[0]).not.toBe(review.problems[0])
    expect(restarted.progress[0]).toMatchObject({ status: 'pending', attempts: 0, draft: '' })
    expect(getPenaltyMs(skipCurrentProblem(restarted, 3_500))).toBe(0)
    expect(createReviewSession(review, 4_000)).toBeNull()
    expect(() => restartReviewSession(source, 4_000)).toThrow('Only review sessions')
  })

  it('builds validated unscored reviews from exact external problems', () => {
    const config = { ...DEFAULT_CONFIG, problemCount: 2 }
    const source = createTrainingSession(config, 42, 1_000)
    const review = createProblemReviewSession(config, 42, source.problems, 2_000)
    expect(review).toMatchObject({ mode: 'review', seed: 42, config: { problemCount: 2 }, timerStartedAt: 2_000 })
    expect(new Set(review?.problems.map((problem) => problem.id)).size).toBe(2)
    expect(createProblemReviewSession(config, 42, [], 2_000)).toBeNull()
    expect(createProblemReviewSession(config, 42, [{ ...source.problems[0]!, answer: '999' }], 2_000)).toBeNull()
    expect(createProblemReviewSession(config, -1, source.problems, 2_000)).toBeNull()
  })

  it('never subtracts time when the wall clock moves backward', () => {
    let session = createTrainingSession(oneQuestion, 9, 1_000)
    session = pauseSession(session, 500)
    expect(session.elapsedMs).toBe(0)
    expect(session.progress[0]?.activeElapsedMs).toBe(0)
  })

  it('normalizes input and supports keypad editing helpers', () => {
    expect(normalizeAnswer(' 1,234 ')).toBe('1234')
    expect(normalizeAnswer('12x')).toBeNull()
    expect(normalizeAnswer('-3')).toBeNull()

    let session = createTrainingSession(oneQuestion, 4, 0)
    session = appendCurrentDigit(session, '1')
    session = appendCurrentDigit(session, '2')
    session = appendCurrentDigit(session, 'x')
    expect(session.progress[0]?.draft).toBe('12')
    session = deleteCurrentDigit(session)
    expect(session.progress[0]?.draft).toBe('1')
    session = clearCurrentDraft(session)
    expect(session.progress[0]?.draft).toBe('')
  })

  it('formats a compact duration', () => {
    expect(formatDuration(0)).toBe('00:00')
    expect(formatDuration(65_999)).toBe('01:05')
  })
})
