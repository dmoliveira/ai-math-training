import {
  generateProblems,
  validateConfig,
  type Problem,
  type TrainingConfig,
} from '../math/engine'

export const SESSION_SCHEMA_VERSION = 2
export const SKIP_PENALTY_MS = 20_000

export type TimingQuality = 'exact' | 'legacy-partial'
export type ProblemStatus = 'pending' | 'correct' | 'skipped' | 'revealed'
export type ProblemFeedback = 'none' | 'incorrect' | 'correct' | 'skipped' | 'revealed'

export interface ProblemProgress {
  draft: string
  attempts: number
  status: ProblemStatus
  feedback: ProblemFeedback
  activeElapsedMs: number | null
}

export interface TrainingSession {
  schemaVersion: typeof SESSION_SCHEMA_VERSION
  id: string
  config: TrainingConfig
  seed: number
  problems: Problem[]
  progress: ProblemProgress[]
  currentIndex: number
  mistakes: number
  elapsedMs: number
  timerStartedAt: number | null
  currentProblemStartedAt: number | null
  timingQuality: TimingQuality
  createdAt: number
  completedAt: number | null
}

export interface SessionSummary {
  total: number
  solved: number
  skipped: number
  revealed: number
  firstTryCorrect: number
  accuracy: number
  mistakes: number
  elapsedMs: number
  penaltyMs: number
  scoredElapsedMs: number
}

export function createTrainingSession(config: TrainingConfig, seed: number, now: number): TrainingSession {
  const errors = validateConfig(config)
  if (errors.length > 0) throw new Error(errors.join(' '))

  const normalizedSeed = seed >>> 0
  const problems = generateProblems(config, normalizedSeed)
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: `session-${now}-${normalizedSeed}`,
    config: cloneConfig(config),
    seed: normalizedSeed,
    problems,
    progress: problems.map(() => ({
      draft: '',
      attempts: 0,
      status: 'pending',
      feedback: 'none',
      activeElapsedMs: 0,
    })),
    currentIndex: 0,
    mistakes: 0,
    elapsedMs: 0,
    timerStartedAt: now,
    currentProblemStartedAt: now,
    timingQuality: 'exact',
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

export function checkCurrentAnswer(session: TrainingSession, now: number): TrainingSession {
  const current = session.progress[session.currentIndex]
  const problem = session.problems[session.currentIndex]
  if (!current || !problem || current.status !== 'pending' || current.draft === '') return session

  const isCorrect = BigInt(current.draft) === BigInt(problem.answer)
  if (!isCorrect) {
    return {
      ...replaceProgress(session, session.currentIndex, {
        ...current,
        attempts: current.attempts + 1,
        feedback: 'incorrect',
      }),
      mistakes: session.mistakes + 1,
    }
  }

  const settled = settleActiveTime(session, now)
  const settledCurrent = settled.progress[settled.currentIndex]!
  return replaceProgress(settled, settled.currentIndex, {
    ...settledCurrent,
    attempts: settledCurrent.attempts + 1,
    status: 'correct',
    feedback: 'correct',
  })
}

export function revealCurrentAnswer(session: TrainingSession, now: number): TrainingSession {
  const current = session.progress[session.currentIndex]
  const problem = session.problems[session.currentIndex]
  if (!current || !problem || current.status !== 'pending') return session

  const settled = settleActiveTime(session, now)
  const settledCurrent = settled.progress[settled.currentIndex]!
  return {
    ...replaceProgress(settled, settled.currentIndex, {
      ...settledCurrent,
      draft: problem.answer,
      status: 'revealed',
      feedback: 'revealed',
    }),
    mistakes: settled.mistakes + 1,
  }
}

export function skipCurrentProblem(session: TrainingSession, now: number): TrainingSession {
  const current = session.progress[session.currentIndex]
  if (!current || current.status !== 'pending') return session

  const settled = settleActiveTime(session, now)
  const settledCurrent = settled.progress[settled.currentIndex]!
  return replaceProgress(settled, settled.currentIndex, {
    ...settledCurrent,
    draft: '',
    status: 'skipped',
    feedback: 'skipped',
  })
}

export function advanceSession(session: TrainingSession, now: number): TrainingSession {
  const current = session.progress[session.currentIndex]
  if (!current || current.status === 'pending' || session.completedAt !== null) return session

  if (session.currentIndex < session.problems.length - 1) {
    return {
      ...session,
      currentIndex: session.currentIndex + 1,
      timerStartedAt: now,
      currentProblemStartedAt: now,
    }
  }

  return {
    ...session,
    timerStartedAt: null,
    currentProblemStartedAt: null,
    completedAt: Math.max(now, session.createdAt),
  }
}

export function pauseSession(session: TrainingSession, now: number): TrainingSession {
  return settleActiveTime(session, now)
}

export function resumeSession(session: TrainingSession, now: number): TrainingSession {
  const current = session.progress[session.currentIndex]
  if (
    session.timerStartedAt !== null ||
    session.completedAt !== null ||
    !current ||
    current.status !== 'pending'
  ) {
    return session
  }
  return {
    ...session,
    timerStartedAt: now,
    currentProblemStartedAt: now,
  }
}

export function getElapsedMs(session: TrainingSession, now: number): number {
  if (session.timerStartedAt === null) return session.elapsedMs
  return addDuration(session.elapsedMs, durationSince(session.timerStartedAt, now))
}

export function getCurrentProblemElapsedMs(session: TrainingSession, now: number): number | null {
  const current = session.progress[session.currentIndex]
  if (!current || current.activeElapsedMs === null) return null
  if (current.status !== 'pending' || session.currentProblemStartedAt === null) {
    return current.activeElapsedMs
  }
  return addDuration(current.activeElapsedMs, durationSince(session.currentProblemStartedAt, now))
}

export function getPenaltyMs(session: TrainingSession): number {
  const skipped = session.progress.filter((item) => item.status === 'skipped').length
  return Math.min(Number.MAX_SAFE_INTEGER, skipped * SKIP_PENALTY_MS)
}

export function getScoredElapsedMs(session: TrainingSession, now: number): number {
  return addDuration(getElapsedMs(session, now), getPenaltyMs(session))
}

export function summarizeSession(session: TrainingSession, now: number): SessionSummary {
  const solved = session.progress.filter((item) => item.status === 'correct').length
  const skipped = session.progress.filter((item) => item.status === 'skipped').length
  const revealed = session.progress.filter((item) => item.status === 'revealed').length
  const firstTryCorrect = session.progress.filter(
    (item) => item.status === 'correct' && item.attempts === 1,
  ).length
  const total = session.problems.length
  const elapsedMs = getElapsedMs(session, now)
  const penaltyMs = getPenaltyMs(session)

  return {
    total,
    solved,
    skipped,
    revealed,
    firstTryCorrect,
    accuracy: total === 0 ? 0 : Math.round((firstTryCorrect / total) * 100),
    mistakes: session.mistakes,
    elapsedMs,
    penaltyMs,
    scoredElapsedMs: addDuration(elapsedMs, penaltyMs),
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

function settleActiveTime(session: TrainingSession, now: number): TrainingSession {
  if (session.timerStartedAt === null) return session

  const delta = durationSince(session.timerStartedAt, now)
  const current = session.progress[session.currentIndex]
  let next = session
  if (current?.status === 'pending') {
    next = replaceProgress(session, session.currentIndex, {
      ...current,
      activeElapsedMs:
        current.activeElapsedMs === null ? null : addDuration(current.activeElapsedMs, delta),
    })
  }

  return {
    ...next,
    elapsedMs: addDuration(session.elapsedMs, delta),
    timerStartedAt: null,
    currentProblemStartedAt: null,
  }
}

function durationSince(startedAt: number, now: number): number {
  return Math.max(0, now - startedAt)
}

function addDuration(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
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
