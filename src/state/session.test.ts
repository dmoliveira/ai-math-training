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
  getElapsedMs,
  normalizeAnswer,
  pauseSession,
  resumeSession,
  revealCurrentAnswer,
  setCurrentDraft,
  summarizeSession,
} from './session'

const oneQuestion: TrainingConfig = { ...DEFAULT_CONFIG, problemCount: 1 }

describe('training session', () => {
  it('counts wrong attempts, allows retry, and locks a correct answer', () => {
    let session = createTrainingSession(oneQuestion, 12, 1_000)
    const answer = session.problems[0]?.answer
    expect(answer).toBeDefined()
    if (!answer) return

    session = setCurrentDraft(session, String(BigInt(answer) + 1n))
    session = checkCurrentAnswer(session)
    expect(session.mistakes).toBe(1)
    expect(session.progress[0]).toMatchObject({ attempts: 1, status: 'pending', feedback: 'incorrect' })

    session = setCurrentDraft(session, answer)
    session = checkCurrentAnswer(session)
    expect(session.progress[0]).toMatchObject({ attempts: 2, status: 'correct', feedback: 'correct' })
    expect(session.mistakes).toBe(1)

    expect(setCurrentDraft(session, '999')).toBe(session)
    expect(checkCurrentAnswer(session)).toBe(session)
  })

  it('reveals once, locks the problem, and completes on advance', () => {
    let session = createTrainingSession(oneQuestion, 5, 2_000)
    session = setCurrentDraft(session, '123')
    session = revealCurrentAnswer(session)

    expect(session.progress[0]).toMatchObject({
      draft: session.problems[0]?.answer,
      attempts: 0,
      status: 'revealed',
      feedback: 'revealed',
    })
    expect(session.mistakes).toBe(1)
    expect(revealCurrentAnswer(session)).toBe(session)

    session = advanceSession(session, 7_000)
    expect(session.completedAt).toBe(7_000)
    expect(session.timerStartedAt).toBeNull()
    expect(session.elapsedMs).toBe(5_000)
    expect(advanceSession(session, 8_000)).toBe(session)
  })

  it('tracks only active time across pause and resume', () => {
    let session = createTrainingSession(oneQuestion, 9, 1_000)
    expect(getElapsedMs(session, 4_000)).toBe(3_000)

    session = pauseSession(session, 4_000)
    expect(getElapsedMs(session, 10_000)).toBe(3_000)
    expect(pauseSession(session, 11_000)).toBe(session)

    session = resumeSession(session, 20_000)
    expect(getElapsedMs(session, 22_500)).toBe(5_500)
  })

  it('summarizes first-try accuracy independently from mistakes', () => {
    const config = { ...DEFAULT_CONFIG, problemCount: 2 }
    let session = createTrainingSession(config, 2, 0)
    const firstAnswer = session.problems[0]?.answer
    const secondAnswer = session.problems[1]?.answer
    expect(firstAnswer && secondAnswer).toBeTruthy()
    if (!firstAnswer || !secondAnswer) return

    session = setCurrentDraft(session, firstAnswer)
    session = checkCurrentAnswer(session)
    session = advanceSession(session, 100)
    session = setCurrentDraft(session, String(BigInt(secondAnswer) + 1n))
    session = checkCurrentAnswer(session)
    session = setCurrentDraft(session, secondAnswer)
    session = checkCurrentAnswer(session)

    expect(summarizeSession(session, 500)).toMatchObject({
      total: 2,
      solved: 2,
      revealed: 0,
      firstTryCorrect: 1,
      accuracy: 50,
      mistakes: 1,
      elapsedMs: 500,
    })
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
