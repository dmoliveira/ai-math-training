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

    try {
      const raw = this.storage.getItem(STORAGE_KEY)
      if (raw === null) return { status: 'empty', state: null }
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
  if (!isInteger(value.mistakes, 0) || !isFiniteNumber(value.elapsedMs) || value.elapsedMs < 0) return false
  if (!isFiniteNumber(value.createdAt)) return false
  if (value.timerStartedAt !== null && !isFiniteNumber(value.timerStartedAt)) return false
  if (value.completedAt !== null && !isFiniteNumber(value.completedAt)) return false

  return value.problems.every((problem) => {
    const answer = evaluateExpression(problem.operands.map(BigInt), problem.operators)
    return answer !== null && String(answer) === problem.answer
  })
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
  if (!isRecord(value) || !Array.isArray(value.operations) || !value.operations.every(isOperation)) {
    return false
  }

  const candidate: TrainingConfig = {
    minDigits: Number(value.minDigits),
    maxDigits: Number(value.maxDigits),
    operatorCount: Number(value.operatorCount),
    operationMode: value.operationMode === 'mixed' ? 'mixed' : 'same',
    operations: [...value.operations],
    problemCount: Number(value.problemCount),
  }

  if (value.operationMode !== 'same' && value.operationMode !== 'mixed') return false
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
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function getBrowserStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}
