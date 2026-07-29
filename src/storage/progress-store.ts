import {
  OPERATIONS,
  evaluateExpression,
  validateConfig,
  type Operation,
  type Problem,
  type TrainingConfig,
} from '../math/engine'
import { DEFAULT_PREFERENCES, parsePracticePreferences, type PracticePreferences } from '../sprint/contracts'
import {
  SESSION_SCHEMA_VERSION,
  pauseSession,
  type ProblemFeedback,
  type ProblemProgress,
  type ProblemStatus,
  type TrainingSession,
} from '../state/session'

export const V1_STORAGE_KEY = 'ai-math-training:progress:v1'
export const V2_STORAGE_KEY = 'ai-math-training:progress:v2'
export const V3_STORAGE_KEY = 'ai-math-training:progress:v3'
export const STORAGE_KEY = V3_STORAGE_KEY
export const APP_SCHEMA_VERSION = 3

export type AppView = 'setup' | 'practice' | 'complete'

export interface PersistedAppState {
  schemaVersion: typeof APP_SCHEMA_VERSION
  view: AppView
  settings: TrainingConfig
  preferences: PracticePreferences
  session: TrainingSession | null
}

interface LegacyProblemProgress {
  draft: string
  attempts: number
  status: 'pending' | 'correct' | 'revealed'
  feedback: 'none' | 'incorrect' | 'correct' | 'revealed'
}

type LegacyTrainingConfig = Omit<TrainingConfig, 'challenge'>

interface LegacyTrainingSession {
  schemaVersion: 1
  config: LegacyTrainingConfig
  seed: number
  problems: Problem[]
  progress: LegacyProblemProgress[]
  currentIndex: number
  mistakes: number
  elapsedMs: number
  timerStartedAt: number | null
  createdAt: number
  completedAt: number | null
}

interface LegacyPersistedAppState {
  schemaVersion: 1
  view: AppView
  settings: LegacyTrainingConfig
  session: LegacyTrainingSession | null
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

    let currentRaw: string | null
    let v2Raw: string | null
    let legacyRaw: string | null
    try {
      currentRaw = this.storage.getItem(V3_STORAGE_KEY)
      v2Raw = this.storage.getItem(V2_STORAGE_KEY)
      legacyRaw = this.storage.getItem(V1_STORAGE_KEY)
    } catch {
      return { status: 'unavailable', state: null }
    }

    if (currentRaw !== null) {
      const currentResult = parseLoadResult(currentRaw, parsePersistedState)
      if (currentResult.status === 'ok') return currentResult
      if (v2Raw === null && legacyRaw === null) return currentResult
    } else if (v2Raw === null && legacyRaw === null) {
      return { status: 'empty', state: null }
    }

    if (v2Raw !== null) {
      const migratedV2 = parseLoadResult(v2Raw, (value) => parsePersistedState(upgradeV2State(value)))
      if (migratedV2.status === 'ok') {
        this.writeMigratedState(migratedV2.state)
        return migratedV2
      }
    }

    if (legacyRaw === null) return { status: 'invalid', state: null }
    const legacyResult = parseLoadResult(legacyRaw, parseLegacyPersistedState)
    if (legacyResult.status !== 'ok' || !legacyResult.state) return { status: 'invalid', state: null }

    const migrated = migrateLegacyState(legacyResult.state)
    const validated = parsePersistedState(migrated)
    if (!validated) return { status: 'invalid', state: null }

    try {
      this.storage.setItem(V3_STORAGE_KEY, JSON.stringify(validated))
    } catch {
      // The validated in-memory migration is still safe to use; the v1 rollback snapshot remains intact.
    }
    return { status: 'ok', state: validated }
  }

  save(state: PersistedAppState, now: number): boolean {
    if (!this.storage) return false

    const safeState: PersistedAppState = {
      ...state,
      settings: cloneConfig(state.settings),
      preferences: { ...state.preferences },
      session: state.session ? pauseSession(state.session, now) : null,
    }

    try {
      this.storage.setItem(V3_STORAGE_KEY, JSON.stringify(safeState))
      return true
    } catch {
      return false
    }
  }

  clear(): boolean {
    if (!this.storage) return false
    try {
      this.storage.removeItem(V3_STORAGE_KEY)
      this.storage.removeItem(V2_STORAGE_KEY)
      this.storage.removeItem(V1_STORAGE_KEY)
      return true
    } catch {
      return false
    }
  }

  clearAll(): boolean {
    if (!this.storage) return false
    try {
      this.storage.removeItem(V2_STORAGE_KEY)
      this.storage.removeItem(V1_STORAGE_KEY)
      this.storage.removeItem(V3_STORAGE_KEY)
      return true
    } catch {
      return false
    }
  }

  private writeMigratedState(state: PersistedAppState): void {
    try {
      this.storage?.setItem(V3_STORAGE_KEY, JSON.stringify(state))
    } catch {
      // A validated in-memory migration remains usable and rollback snapshots stay untouched.
    }
  }
}

export function parsePersistedState(value: unknown): PersistedAppState | null {
  if (!isRecord(value) || value.schemaVersion !== APP_SCHEMA_VERSION) return null
  if (!isAppView(value.view) || !isTrainingConfig(value.settings)) return null
  const preferences = parsePracticePreferences(value.preferences)
  if (!preferences) return null
  const session = value.session === null ? null : normalizeTrainingSession(value.session)
  if (value.session !== null && !session) return null

  return {
    schemaVersion: APP_SCHEMA_VERSION,
    view: value.view,
    settings: cloneConfig(value.settings),
    preferences,
    session: session ? cloneSessionAsPaused(session) : null,
  }
}

function parseLegacyPersistedState(value: unknown): LegacyPersistedAppState | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null
  if (!isAppView(value.view) || !isLegacyTrainingConfig(value.settings)) return null
  if (value.session !== null && !isLegacyTrainingSession(value.session)) return null

  return {
    schemaVersion: 1,
    view: value.view,
    settings: cloneLegacyConfig(value.settings),
    session: value.session ? cloneLegacySessionAsPaused(value.session) : null,
  }
}

function migrateLegacyState(value: LegacyPersistedAppState): PersistedAppState {
  const session = value.session
  return {
    schemaVersion: APP_SCHEMA_VERSION,
    view: value.view,
    settings: migrateLegacyConfig(value.settings),
    preferences: { ...DEFAULT_PREFERENCES },
    session: session
      ? {
          schemaVersion: SESSION_SCHEMA_VERSION,
          mode: 'sprint',
          id: `legacy-${session.createdAt}-${session.seed}`,
          config: migrateLegacyConfig(session.config),
          seed: session.seed,
          problems: session.problems.map(cloneProblem),
          progress: session.progress.map((item) => ({ ...item, activeElapsedMs: null })),
          currentIndex: session.currentIndex,
          mistakes: session.mistakes,
          elapsedMs: session.elapsedMs,
          timerStartedAt: null,
          currentProblemStartedAt: null,
          timingQuality: 'legacy-partial',
          createdAt: session.createdAt,
          completedAt: session.completedAt,
        }
      : null,
  }
}

function parseLoadResult<T>(
  raw: string,
  parser: (value: unknown) => T | null,
): { status: 'ok'; state: T } | { status: 'invalid'; state: null } {
  try {
    const state = parser(JSON.parse(raw))
    return state ? { status: 'ok', state } : { status: 'invalid', state: null }
  } catch {
    return { status: 'invalid', state: null }
  }
}

function upgradeV2State(value: unknown): unknown {
  if (!isRecord(value) || value.schemaVersion !== 2) return null
  const session = isRecord(value.session)
    ? { ...value.session, config: upgradeLegacyConfig(value.session.config) }
    : value.session
  return {
    ...value,
    schemaVersion: APP_SCHEMA_VERSION,
    settings: upgradeLegacyConfig(value.settings),
    session,
  }
}

function upgradeLegacyConfig(value: unknown): unknown {
  return isRecord(value) ? { ...value, challenge: 'random' } : value
}

function isTrainingSession(value: unknown): value is TrainingSession {
  if (!isRecord(value) || value.schemaVersion !== SESSION_SCHEMA_VERSION) return false
  if (value.mode !== 'sprint' && value.mode !== 'review') return false
  if (typeof value.id !== 'string' || value.id.length === 0 || !isTrainingConfig(value.config)) return false
  if (!isInteger(value.seed, 0) || !Array.isArray(value.problems) || !Array.isArray(value.progress)) return false
  if (value.problems.length !== value.config.problemCount || value.progress.length !== value.problems.length) return false
  if (!value.problems.every(isProblem) || !value.progress.every(isProblemProgress)) return false
  if (!isInteger(value.currentIndex, 0) || value.currentIndex >= value.problems.length) return false
  if (!isInteger(value.mistakes, 0) || !isTimestamp(value.elapsedMs) || !isTimestamp(value.createdAt)) return false
  if (value.timerStartedAt !== null && !isTimestamp(value.timerStartedAt)) return false
  if (value.currentProblemStartedAt !== null && !isTimestamp(value.currentProblemStartedAt)) return false
  if ((value.timerStartedAt === null) !== (value.currentProblemStartedAt === null)) return false
  if (value.timerStartedAt !== value.currentProblemStartedAt) return false
  if (value.completedAt !== null && !isTimestamp(value.completedAt)) return false
  if (value.timingQuality !== 'exact' && value.timingQuality !== 'legacy-partial') return false
  if (value.timerStartedAt !== null && value.timerStartedAt < value.createdAt) return false
  if (value.completedAt !== null && value.completedAt < value.createdAt) return false
  if (value.timingQuality === 'exact' && value.progress.some((item) => item.activeElapsedMs === null)) return false
  if (value.timingQuality === 'legacy-partial' && value.progress.some((item) => item.activeElapsedMs !== null)) return false

  const session = value as unknown as TrainingSession
  if (!hasValidProblemSequence(session) || !hasConsistentProgress(session)) return false
  if (session.timingQuality === 'exact') {
    const problemTime = session.progress.reduce((sum, item) => sum + (item.activeElapsedMs ?? 0), 0)
    if (problemTime !== session.elapsedMs) return false
  }
  return true
}

function normalizeTrainingSession(value: unknown): TrainingSession | null {
  if (!isRecord(value)) return null
  const mode = value.mode === undefined ? 'sprint' : value.mode
  if (mode !== 'sprint' && mode !== 'review') return null
  const normalized = { ...value, mode }
  return isTrainingSession(normalized) ? normalized : null
}

function isLegacyTrainingSession(value: unknown): value is LegacyTrainingSession {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isLegacyTrainingConfig(value.config)) return false
  if (!isInteger(value.seed, 0) || !Array.isArray(value.problems) || !Array.isArray(value.progress)) return false
  if (value.problems.length !== value.config.problemCount || value.progress.length !== value.problems.length) return false
  if (!value.problems.every(isProblem) || !value.progress.every(isLegacyProblemProgress)) return false
  if (!isInteger(value.currentIndex, 0) || value.currentIndex >= value.problems.length) return false
  if (!isInteger(value.mistakes, 0) || !isTimestamp(value.elapsedMs) || !isTimestamp(value.createdAt)) return false
  if (value.timerStartedAt !== null && !isTimestamp(value.timerStartedAt)) return false
  if (value.completedAt !== null && !isTimestamp(value.completedAt)) return false
  if (value.timerStartedAt !== null && value.timerStartedAt < value.createdAt) return false
  if (value.completedAt !== null && value.completedAt < value.createdAt) return false

  const session = value as unknown as LegacyTrainingSession
  return hasValidLegacyProblemSequence(session) && hasConsistentLegacyProgress(session)
}

function hasValidProblemSequence(session: Pick<TrainingSession, 'config' | 'problems'>): boolean {
  return hasValidProblemSequenceForConfig(session.config, session.problems)
}

function hasValidLegacyProblemSequence(session: Pick<LegacyTrainingSession, 'config' | 'problems'>): boolean {
  return hasValidProblemSequenceForConfig(session.config, session.problems)
}

function hasValidProblemSequenceForConfig(config: Omit<TrainingConfig, 'challenge'>, problems: Problem[]): boolean {
  const ids = new Set<string>()
  return problems.every((problem) => {
    if (ids.has(problem.id)) return false
    ids.add(problem.id)
    const operandsMatchConfig = problem.operands.every(
      (operand) =>
        /^[1-9]\d*$/.test(operand) &&
        operand.length >= config.minDigits &&
        operand.length <= config.maxDigits,
    )
    const operatorsMatchConfig =
      problem.operators.length === config.operatorCount &&
      problem.operators.every((operation) => config.operations.includes(operation))
    const distinctOperators = new Set(problem.operators).size
    const modeMatchesConfig = config.operationMode === 'same' ? distinctOperators === 1 : distinctOperators >= 2
    const answer = evaluateExpression(problem.operands.map(BigInt), problem.operators)
    return operandsMatchConfig && operatorsMatchConfig && modeMatchesConfig && answer !== null && String(answer) === problem.answer
  })
}

function hasConsistentProgress(session: TrainingSession): boolean {
  let expectedMistakes = 0
  for (const [index, item] of session.progress.entries()) {
    const problem = session.problems[index]
    if (!problem) return false

    if (item.status === 'correct') {
      if (item.attempts < 1 || item.feedback !== 'correct' || item.draft === '' || BigInt(item.draft) !== BigInt(problem.answer)) return false
      expectedMistakes += item.attempts - 1
    } else if (item.status === 'revealed') {
      if (item.feedback !== 'revealed' || item.draft !== problem.answer) return false
      expectedMistakes += item.attempts + 1
    } else if (item.status === 'skipped') {
      if (item.feedback !== 'skipped' || item.draft !== '') return false
      expectedMistakes += item.attempts
    } else {
      if (item.feedback === 'correct' || item.feedback === 'revealed' || item.feedback === 'skipped') return false
      if (item.feedback === 'incorrect' && item.attempts < 1) return false
      expectedMistakes += item.attempts
    }

    if (index < session.currentIndex && item.status === 'pending') return false
    if (index > session.currentIndex && !isPristineProgress(item)) return false
  }

  const current = session.progress[session.currentIndex]
  if (current?.status !== 'pending' && session.timerStartedAt !== null) return false
  const allLocked = session.progress.every((item) => item.status !== 'pending')
  if (session.completedAt !== null) {
    if (!allLocked || session.currentIndex !== session.progress.length - 1 || session.timerStartedAt !== null) return false
  }
  return expectedMistakes === session.mistakes
}

function hasConsistentLegacyProgress(session: LegacyTrainingSession): boolean {
  let expectedMistakes = 0
  for (const [index, item] of session.progress.entries()) {
    const problem = session.problems[index]
    if (!problem) return false
    if (item.status === 'correct') {
      if (item.attempts < 1 || item.feedback !== 'correct' || item.draft === '' || BigInt(item.draft) !== BigInt(problem.answer)) return false
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
    if (index > session.currentIndex && (item.status !== 'pending' || item.draft !== '' || item.attempts !== 0 || item.feedback !== 'none')) return false
  }
  const allLocked = session.progress.every((item) => item.status !== 'pending')
  if (session.completedAt !== null && (!allLocked || session.currentIndex !== session.progress.length - 1 || session.timerStartedAt !== null)) return false
  return expectedMistakes === session.mistakes
}

function isProblem(value: unknown): value is Problem {
  return isRecord(value) && typeof value.id === 'string' && Array.isArray(value.operands) && value.operands.length >= 2 && value.operands.every((operand) => typeof operand === 'string' && /^\d+$/.test(operand)) && Array.isArray(value.operators) && value.operators.length === value.operands.length - 1 && value.operators.every(isOperation) && typeof value.answer === 'string' && /^\d+$/.test(value.answer)
}

function isProblemProgress(value: unknown): value is ProblemProgress {
  return isRecord(value) && typeof value.draft === 'string' && /^\d*$/.test(value.draft) && value.draft.length <= 80 && isInteger(value.attempts, 0) && isProblemStatus(value.status) && isProblemFeedback(value.feedback) && (value.activeElapsedMs === null || isTimestamp(value.activeElapsedMs))
}

function isLegacyProblemProgress(value: unknown): value is LegacyProblemProgress {
  return isRecord(value) && typeof value.draft === 'string' && /^\d*$/.test(value.draft) && value.draft.length <= 80 && isInteger(value.attempts, 0) && (value.status === 'pending' || value.status === 'correct' || value.status === 'revealed') && (value.feedback === 'none' || value.feedback === 'incorrect' || value.feedback === 'correct' || value.feedback === 'revealed')
}

function isPristineProgress(item: ProblemProgress): boolean {
  return item.status === 'pending' && item.draft === '' && item.attempts === 0 && item.feedback === 'none' && (item.activeElapsedMs === 0 || item.activeElapsedMs === null)
}

function isTrainingConfig(value: unknown): value is TrainingConfig {
  if (!isRecord(value) || typeof value.minDigits !== 'number' || typeof value.maxDigits !== 'number' || typeof value.operatorCount !== 'number' || typeof value.problemCount !== 'number' || (value.operationMode !== 'same' && value.operationMode !== 'mixed') || !Array.isArray(value.operations) || !value.operations.every(isOperation)) return false
  const candidate: TrainingConfig = { minDigits: value.minDigits, maxDigits: value.maxDigits, operatorCount: value.operatorCount, operationMode: value.operationMode, operations: [...value.operations], problemCount: value.problemCount, challenge: value.challenge as TrainingConfig['challenge'] }
  return validateConfig(candidate).length === 0
}

function isLegacyTrainingConfig(value: unknown): value is LegacyTrainingConfig {
  if (!isRecord(value)) return false
  return isTrainingConfig({ ...value, challenge: 'random' })
}

function cloneSessionAsPaused(session: TrainingSession): TrainingSession {
  return { ...session, config: cloneConfig(session.config), problems: session.problems.map(cloneProblem), progress: session.progress.map((item) => ({ ...item })), timerStartedAt: null, currentProblemStartedAt: null }
}

function cloneLegacySessionAsPaused(session: LegacyTrainingSession): LegacyTrainingSession {
  return { ...session, config: cloneLegacyConfig(session.config), problems: session.problems.map(cloneProblem), progress: session.progress.map((item) => ({ ...item })), timerStartedAt: null }
}

function cloneProblem(problem: Problem): Problem {
  return { ...problem, operands: [...problem.operands], operators: [...problem.operators] }
}

function cloneConfig(config: TrainingConfig): TrainingConfig {
  return { ...config, operations: [...config.operations] }
}

function cloneLegacyConfig(config: LegacyTrainingConfig): LegacyTrainingConfig {
  return { ...config, operations: [...config.operations] }
}

function migrateLegacyConfig(config: LegacyTrainingConfig): TrainingConfig {
  return { ...cloneLegacyConfig(config), challenge: 'random' }
}

function isOperation(value: unknown): value is Operation {
  return typeof value === 'string' && OPERATIONS.includes(value as Operation)
}

function isProblemStatus(value: unknown): value is ProblemStatus {
  return value === 'pending' || value === 'correct' || value === 'skipped' || value === 'revealed'
}

function isProblemFeedback(value: unknown): value is ProblemFeedback {
  return value === 'none' || value === 'incorrect' || value === 'correct' || value === 'skipped' || value === 'revealed'
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
