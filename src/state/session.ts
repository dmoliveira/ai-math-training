import {
  generateProblems,
  validateConfig,
  type Problem,
  type TrainingConfig,
} from '../math/engine'

export const SESSION_SCHEMA_VERSION = 1

export type ProblemStatus = 'pending' | 'correct' | 'revealed'
export type ProblemFeedback = 'none' | 'incorrect' | 'correct' | 'revealed'

export interface ProblemProgress {
  draft: string
  attempts: number
  status: ProblemStatus
  feedback: ProblemFeedback
}

export interface TrainingSession {
  schemaVersion: typeof SESSION_SCHEMA_VERSION
  config: TrainingConfig
  seed: number
  problems: Problem[]
  progress: ProblemProgress[]
  currentIndex: number
  mistakes: number
  elapsedMs: number
  timerStartedAt: number | null
  createdAt: number
  completedAt: number | null
}

export interface SessionSummary {
  total: number
  solved: number
  revealed: number
  firstTryCorrect: number
  accuracy: number
  mistakes: number
  elapsedMs: number
}

export function createTrainingSession(config: TrainingConfig, seed: number, now: number): TrainingSession {
  const errors = validateConfig(config)
  if (errors.length > 0) throw new Error(errors.join(' '))

  const problems = generateProblems(config, seed)
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    config: cloneConfig(config),
    seed: seed >>> 0,
    problems,
    progress: problems.map(() => ({ draft: '', attempts: 0, status: 'pending', feedback: 'none' })),
    currentIndex: 0,
    mistakes: 0,
    elapsedMs: 0,
    timerStartedAt: now,
    createdAt: now,
    completedAt: null,
  }
}

export function setCurrentDraft(session: TrainingSession, value: string): TrainingSession {
  const current = session.progress[session.currentIndex]
  if (!current || current.status !== 'pending') return session

  const normalized = normalizeAnswer(value)
  if (normalized === null) return session

  return replaceProgress(session, session.currentIndex, {
    ...current,
    draft: normalized,
    feedback: 'none',
  })
}

export function appendCurrentDigit(session: TrainingSession, digit: string): TrainingSession {
  if (!/^\d$/.test(digit)) return session
  const current = session.progress[session.currentIndex]
  if (!current) return session
  return setCurrentDraft(session, `${current.draft}${digit}`)
}

export function deleteCurrentDigit(session: TrainingSession): TrainingSession {
  const current = session.progress[session.currentIndex]
  if (!current) return session
  return setCurrentDraft(session, current.draft.slice(0, -1))
}

export function clearCurrentDraft(session: TrainingSession): TrainingSession {
  return setCurrentDraft(session, '')
}

export function checkCurrentAnswer(session: TrainingSession): TrainingSession {
  const current = session.progress[session.currentIndex]
  const problem = session.problems[session.currentIndex]
  if (!current || !problem || current.status !== 'pending' || current.draft === '') return session

  const isCorrect = BigInt(current.draft) === BigInt(problem.answer)
  const nextProgress: ProblemProgress = {
    ...current,
    attempts: current.attempts + 1,
    status: isCorrect ? 'correct' : 'pending',
    feedback: isCorrect ? 'correct' : 'incorrect',
  }

  return {
    ...replaceProgress(session, session.currentIndex, nextProgress),
    mistakes: session.mistakes + (isCorrect ? 0 : 1),
  }
}

export function revealCurrentAnswer(session: TrainingSession): TrainingSession {
  const current = session.progress[session.currentIndex]
  const problem = session.problems[session.currentIndex]
  if (!current || !problem || current.status !== 'pending') return session

  return {
    ...replaceProgress(session, session.currentIndex, {
      ...current,
      draft: problem.answer,
      status: 'revealed',
      feedback: 'revealed',
    }),
    mistakes: session.mistakes + 1,
  }
}

export function advanceSession(session: TrainingSession, now: number): TrainingSession {
  const current = session.progress[session.currentIndex]
  if (!current || current.status === 'pending' || session.completedAt !== null) return session

  if (session.currentIndex < session.problems.length - 1) {
    return {
      ...session,
      currentIndex: session.currentIndex + 1,
    }
  }

  const paused = pauseSession(session, now)
  return {
    ...paused,
    completedAt: now,
  }
}

export function pauseSession(session: TrainingSession, now: number): TrainingSession {
  if (session.timerStartedAt === null) return session
  return {
    ...session,
    elapsedMs: getElapsedMs(session, now),
    timerStartedAt: null,
  }
}

export function resumeSession(session: TrainingSession, now: number): TrainingSession {
  if (session.timerStartedAt !== null || session.completedAt !== null) return session
  return {
    ...session,
    timerStartedAt: now,
  }
}

export function getElapsedMs(session: TrainingSession, now: number): number {
  if (session.timerStartedAt === null) return session.elapsedMs
  return session.elapsedMs + Math.max(0, now - session.timerStartedAt)
}

export function summarizeSession(session: TrainingSession, now: number): SessionSummary {
  const solved = session.progress.filter((item) => item.status === 'correct').length
  const revealed = session.progress.filter((item) => item.status === 'revealed').length
  const firstTryCorrect = session.progress.filter(
    (item) => item.status === 'correct' && item.attempts === 1,
  ).length
  const total = session.problems.length

  return {
    total,
    solved,
    revealed,
    firstTryCorrect,
    accuracy: total === 0 ? 0 : Math.round((firstTryCorrect / total) * 100),
    mistakes: session.mistakes,
    elapsedMs: getElapsedMs(session, now),
  }
}

export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function normalizeAnswer(value: string): string | null {
  const compact = value.replace(/[\s,_]/g, '')
  if (!/^\d*$/.test(compact)) return null
  return compact.slice(0, 80)
}

function replaceProgress(
  session: TrainingSession,
  index: number,
  value: ProblemProgress,
): TrainingSession {
  const progress = [...session.progress]
  progress[index] = value
  return { ...session, progress }
}

function cloneConfig(config: TrainingConfig): TrainingConfig {
  return { ...config, operations: [...config.operations] }
}
