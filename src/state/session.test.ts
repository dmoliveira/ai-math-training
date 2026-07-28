import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG, type TrainingConfig } from '../math/engine'
import {
  advanceSession,
  appendCurrentDigit,
  checkCurrentAnswer,
  clearCurrentDraft,
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
