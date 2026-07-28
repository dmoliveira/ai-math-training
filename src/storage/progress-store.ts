import {
  OPERATIONS,
  evaluateExpression,
  validateConfig,
  type Operation,
  type Problem,
  type TrainingConfig,
} from '../math/engine'
import {
  SESSION_SCHEMA_VERSION,
  pauseSession,
  type ProblemFeedback,
  type ProblemProgress,
  type ProblemStatus,
  type TrainingSession,
} from '../state/session'

export const STORAGE_KEY = 'ai-math-training:progress:v1'
export const APP_SCHEMA_VERSION = 1

export type AppView = 'setup' | 'practice' | 'complete'

export interface PersistedAppState {
  schemaVersion: typeof APP_SCHEMA_VERSION
  view: AppView
  settings: TrainingConfig
  session: TrainingSession | null
}

export type StoreLoadStatus = 'ok' | 'empty' | 'invalid' | 'unavailable'

export interface StoreLoadResult {
  status: StoreLoadStatus
  state: PersistedAppState | null
}

export interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

export class ProgressStore {
  private readonly storage: StorageLike | null

  constructor(storage: StorageLike | null = getBrowserStorage()) {
    this.storage = storage
  }

  load(): StoreLoadResult {
    if (!this.storage) return { status: 'unavailable', state: null }

    let raw: string | null
    try {
      raw = this.storage.getItem(STORAGE_KEY)
    } catch {
      return { status: 'unavailable', state: null }
    }

    if (raw === null) return { status: 'empty', state: null }

    try {
      const parsed: unknown = JSON.parse(raw)
      const state = parsePersistedState(parsed)
      return state ? { status: 'ok', state } : { status: 'invalid', state: null }
    } catch {
      return { status: 'invalid', state: null }
    }
  }

  save(state: PersistedAppState, now: number): boolean {
    if (!this.storage) return false

    const safeState: PersistedAppState = {
      ...state,
      settings: cloneConfig(state.settings),
      session: state.session ? pauseSession(state.session, now) : null,
    }

    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(safeState))
      return true
    } catch {
      return false
    }
  }

  clear(): boolean {
    if (!this.storage) return false
    try {
      this.storage.removeItem(STORAGE_KEY)
      return true
    } catch {
      return false
    }
  }
}

export function parsePersistedState(value: unknown): PersistedAppState | null {
  if (!isRecord(value) || value.schemaVersion !== APP_SCHEMA_VERSION) return null
  if (!isAppView(value.view) || !isTrainingConfig(value.settings)) return null
  if (value.session !== null && !isTrainingSession(value.session)) return null

  return {
    schemaVersion: APP_SCHEMA_VERSION,
    view: value.view,
    settings: cloneConfig(value.settings),
    session: value.session ? cloneSessionAsPaused(value.session) : null,
  }
}

function isTrainingSession(value: unknown): value is TrainingSession {
  if (!isRecord(value) || value.schemaVersion !== SESSION_SCHEMA_VERSION) return false
  if (!isTrainingConfig(value.config)) return false
  if (!isInteger(value.seed, 0) || !Array.isArray(value.problems) || !Array.isArray(value.progress)) {
    return false
  }
  if (value.problems.length !== value.config.problemCount || value.progress.length !== value.problems.length) {
    return false
  }
  if (!value.problems.every(isProblem) || !value.progress.every(isProblemProgress)) return false
  if (!isInteger(value.currentIndex, 0) || value.currentIndex >= value.problems.length) return false
  if (!isInteger(value.mistakes, 0) || !isTimestamp(value.elapsedMs)) return false
  if (!isTimestamp(value.createdAt)) return false
  if (value.timerStartedAt !== null && !isTimestamp(value.timerStartedAt)) return false
  if (value.completedAt !== null && !isTimestamp(value.completedAt)) return false
  if (value.timerStartedAt !== null && value.timerStartedAt < value.createdAt) return false
  if (value.completedAt !== null && value.completedAt < value.createdAt) return false

  const session = value as unknown as TrainingSession
  return hasValidProblemSequence(session) && hasConsistentProgress(session)
}

function hasValidProblemSequence(session: TrainingSession): boolean {
  const ids = new Set<string>()

  return session.problems.every((problem) => {
    if (ids.has(problem.id)) return false
    ids.add(problem.id)

    const operandsMatchConfig = problem.operands.every(
      (operand) =>
        /^[1-9]\d*$/.test(operand) &&
        operand.length >= session.config.minDigits &&
        operand.length <= session.config.maxDigits,
    )
    const operatorsMatchConfig =
      problem.operators.length === session.config.operatorCount &&
      problem.operators.every((operation) => session.config.operations.includes(operation))
    const distinctOperators = new Set(problem.operators).size
    const modeMatchesConfig =
      session.config.operationMode === 'same' ? distinctOperators === 1 : distinctOperators >= 2
    const answer = evaluateExpression(problem.operands.map(BigInt), problem.operators)

    return (
      operandsMatchConfig &&
      operatorsMatchConfig &&
      modeMatchesConfig &&
      answer !== null &&
      String(answer) === problem.answer
    )
  })
}

function hasConsistentProgress(session: TrainingSession): boolean {
  let expectedMistakes = 0

  for (const [index, item] of session.progress.entries()) {
    const problem = session.problems[index]
    if (!problem) return false

    if (item.status === 'correct') {
      if (
        item.attempts < 1 ||
        item.feedback !== 'correct' ||
        item.draft === '' ||
        BigInt(item.draft) !== BigInt(problem.answer)
      ) {
        return false
      }
      expectedMistakes += item.attempts - 1
    } else if (item.status === 'revealed') {
      if (item.feedback !== 'revealed' || item.draft !== problem.answer) return false
      expectedMistakes += item.attempts + 1
    } else {
      if (item.feedback === 'correct' || item.feedback === 'revealed') return false
      if (item.feedback === 'incorrect' && item.attempts < 1) return false
      expectedMistakes += item.attempts
    }

    if (index < session.currentIndex && item.status === 'pending') return false
    if (
      index > session.currentIndex &&
      (item.status !== 'pending' || item.draft !== '' || item.attempts !== 0 || item.feedback !== 'none')
    ) {
      return false
    }
  }

  const allLocked = session.progress.every((item) => item.status !== 'pending')
  if (session.completedAt !== null) {
    if (
      !allLocked ||
      session.currentIndex !== session.progress.length - 1 ||
      session.timerStartedAt !== null ||
      session.completedAt < session.createdAt
    ) {
      return false
    }
  }

  return expectedMistakes === session.mistakes
}

function isProblem(value: unknown): value is Problem {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    Array.isArray(value.operands) &&
    value.operands.length >= 2 &&
    value.operands.every((operand) => typeof operand === 'string' && /^\d+$/.test(operand)) &&
    Array.isArray(value.operators) &&
    value.operators.length === value.operands.length - 1 &&
    value.operators.every(isOperation) &&
    typeof value.answer === 'string' &&
    /^\d+$/.test(value.answer)
  )
}

function isProblemProgress(value: unknown): value is ProblemProgress {
  return (
    isRecord(value) &&
    typeof value.draft === 'string' &&
    /^\d*$/.test(value.draft) &&
    value.draft.length <= 80 &&
    isInteger(value.attempts, 0) &&
    isProblemStatus(value.status) &&
    isProblemFeedback(value.feedback)
  )
}

function isTrainingConfig(value: unknown): value is TrainingConfig {
  if (
    !isRecord(value) ||
    typeof value.minDigits !== 'number' ||
    typeof value.maxDigits !== 'number' ||
    typeof value.operatorCount !== 'number' ||
    typeof value.problemCount !== 'number' ||
    (value.operationMode !== 'same' && value.operationMode !== 'mixed') ||
    !Array.isArray(value.operations) ||
    !value.operations.every(isOperation)
  ) {
    return false
  }

  const candidate: TrainingConfig = {
    minDigits: value.minDigits,
    maxDigits: value.maxDigits,
    operatorCount: value.operatorCount,
    operationMode: value.operationMode,
    operations: [...value.operations],
    problemCount: value.problemCount,
  }

  return validateConfig(candidate).length === 0
}

function cloneSessionAsPaused(session: TrainingSession): TrainingSession {
  return {
    ...session,
    config: cloneConfig(session.config),
    problems: session.problems.map((problem) => ({
      ...problem,
      operands: [...problem.operands],
      operators: [...problem.operators],
    })),
    progress: session.progress.map((item) => ({ ...item })),
    timerStartedAt: null,
  }
}

function cloneConfig(config: TrainingConfig): TrainingConfig {
  return { ...config, operations: [...config.operations] }
}

function isOperation(value: unknown): value is Operation {
  return typeof value === 'string' && OPERATIONS.includes(value as Operation)
}

function isProblemStatus(value: unknown): value is ProblemStatus {
  return value === 'pending' || value === 'correct' || value === 'revealed'
}

function isProblemFeedback(value: unknown): value is ProblemFeedback {
  return value === 'none' || value === 'incorrect' || value === 'correct' || value === 'revealed'
}

function isAppView(value: unknown): value is AppView {
  return value === 'setup' || value === 'practice' || value === 'complete'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isInteger(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function isTimestamp(value: unknown): value is number {
  return isInteger(value, 0)
}

function getBrowserStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}
