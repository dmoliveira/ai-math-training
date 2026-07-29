import { OPERATION_DETAILS, validateConfig, type Operation, type TrainingConfig } from '../math/engine'
import {
  SKIP_PENALTY_MS,
  getPenaltyMs,
  type TimingQuality,
  type TrainingSession,
} from '../state/session'
import { configKey, type SharePayload } from './contracts'

export interface SprintProblemResult {
  problemId: string
  operands: string[]
  operators: Operation[]
  outcome: 'correct' | 'skipped' | 'revealed'
  attempts: number
  activeElapsedMs: number | null
  penaltyMs: 0 | typeof SKIP_PENALTY_MS
  scoredElapsedMs: number | null
}

export interface SprintResult {
  schemaVersion: 1
  id: string
  sessionId: string
  configKey: string
  config: TrainingConfig
  completedAt: number
  timingQuality: TimingQuality
  rankEligible: boolean
  totals: {
    problems: number
    correct: number
    skipped: number
    revealed: number
    mistakes: number
    firstTryCorrect: number
    accuracyPercent: number
    activeElapsedMs: number
    penaltyMs: number
    scoredElapsedMs: number
  }
  problems: SprintProblemResult[]
}

export interface DailyStatistics {
  date: string
  count: number
  bestMs: number
  averageMs: number
  medianMs: number
}

export type ResultStoreStatus =
  | 'saved'
  | 'duplicate'
  | 'cleared'
  | 'unavailable'
  | 'blocked'
  | 'quota-exceeded'
  | 'failed'

export interface ResultStoreWriteResult {
  status: ResultStoreStatus
}

export interface ResultPage {
  status: 'ok' | 'unavailable' | 'blocked' | 'failed'
  results: SprintResult[]
  nextCursor: string | null
  corruptRecords: number
}

export interface ResultStore {
  saveCompleted(result: SprintResult): Promise<ResultStoreWriteResult>
  getById(id: string): Promise<SprintResult | null>
  listCompleted(configKey: string, cursor?: string, limit?: number): Promise<ResultPage>
  listRanked(configKey: string, limit?: number): Promise<ResultPage>
  listCompletedSince(configKey: string, since: number): Promise<ResultPage>
  clearConfig(configKey: string): Promise<ResultStoreWriteResult>
}

export function createSprintResult(session: TrainingSession): SprintResult | null {
  if (session.mode === 'review' || session.completedAt === null || session.progress.some((item) => item.status === 'pending')) return null

  const problems: SprintProblemResult[] = []
  for (const [index, progress] of session.progress.entries()) {
    const problem = session.problems[index]
    if (!problem || progress.status === 'pending') return null
    const penaltyMs = progress.status === 'skipped' ? SKIP_PENALTY_MS : 0
    problems.push({
      problemId: problem.id,
      operands: [...problem.operands],
      operators: [...problem.operators],
      outcome: progress.status,
      attempts: progress.attempts,
      activeElapsedMs: progress.activeElapsedMs,
      penaltyMs,
      scoredElapsedMs:
        progress.activeElapsedMs === null ? null : safeAdd(progress.activeElapsedMs, penaltyMs),
    })
  }

  const correct = session.progress.filter((item) => item.status === 'correct').length
  const skipped = session.progress.filter((item) => item.status === 'skipped').length
  const revealed = session.progress.filter((item) => item.status === 'revealed').length
  const firstTryCorrect = session.progress.filter(
    (item) => item.status === 'correct' && item.attempts === 1,
  ).length
  const penaltyMs = getPenaltyMs(session)
  const rankEligible = session.timingQuality === 'exact' && revealed === 0

  return {
    schemaVersion: 1,
    id: `result-v1-${session.id}`,
    sessionId: session.id,
    configKey: configKey(session.config),
    config: { ...session.config, operations: [...session.config.operations] },
    completedAt: session.completedAt,
    timingQuality: session.timingQuality,
    rankEligible,
    totals: {
      problems: session.problems.length,
      correct,
      skipped,
      revealed,
      mistakes: session.mistakes,
      firstTryCorrect,
      accuracyPercent:
        session.problems.length === 0
          ? 0
          : Math.round((firstTryCorrect / session.problems.length) * 100),
      activeElapsedMs: session.elapsedMs,
      penaltyMs,
      scoredElapsedMs: safeAdd(session.elapsedMs, penaltyMs),
    },
    problems,
  }
}

export function rankResults(results: readonly SprintResult[], limit = 5): SprintResult[] {
  return results
    .filter((result) => result.rankEligible)
    .slice()
    .sort(compareResults)
    .slice(0, Math.max(0, limit))
}

export function compareResults(left: SprintResult, right: SprintResult): number {
  return (
    left.totals.scoredElapsedMs - right.totals.scoredElapsedMs ||
    left.totals.mistakes - right.totals.mistakes ||
    left.completedAt - right.completedAt ||
    left.id.localeCompare(right.id)
  )
}

export function dailyStatistics(
  results: readonly SprintResult[],
  timeZone: string,
): DailyStatistics[] {
  const buckets = new Map<string, number[]>()
  for (const result of results) {
    if (!result.rankEligible) continue
    const date = dateKey(result.completedAt, timeZone)
    const bucket = buckets.get(date) ?? []
    bucket.push(result.totals.scoredElapsedMs)
    buckets.set(date, bucket)
  }

  return [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, values]) => {
      const sorted = values.slice().sort((left, right) => left - right)
      const sum = sorted.reduce((total, value) => total + value, 0)
      return {
        date,
        count: sorted.length,
        bestMs: sorted[0]!,
        averageMs: sum / sorted.length,
        medianMs: median(sorted),
      }
    })
}

export function createSharePayload(result: SprintResult, url?: string): SharePayload {
  const operationLabels = result.config.operations
    .map((operation) => OPERATION_DETAILS[operation].shortLabel)
    .join(', ')
  const seconds = (result.totals.scoredElapsedMs / 1_000).toFixed(1)
  const text = `I completed ${result.totals.problems} Mental Math Sprint questions in ${seconds}s scored time (${result.totals.accuracyPercent}% first-try accuracy, ${result.totals.skipped} skipped) — ${operationLabels}.`
  return { title: 'Mental Math Sprint result', text, ...(url ? { url } : {}) }
}

function dateKey(timestamp: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp))
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2
}

export function isSprintResult(value: unknown): value is SprintResult {
  if (typeof value !== 'object' || value === null) return false
  const result = value as Partial<SprintResult>
  if (
    result.schemaVersion !== 1 ||
    typeof result.id !== 'string' ||
    typeof result.sessionId !== 'string' ||
    typeof result.configKey !== 'string' ||
    !result.config ||
    !Number.isSafeInteger(result.completedAt) ||
    result.completedAt! < 0 ||
    (result.timingQuality !== 'exact' && result.timingQuality !== 'legacy-partial') ||
    typeof result.rankEligible !== 'boolean' ||
    !result.totals ||
    !Array.isArray(result.problems)
  ) return false
  const totals = result.totals
  const normalizedConfig = result.config
    ? { ...result.config, operations: [...result.config.operations], challenge: result.config.challenge ?? 'random' }
    : null
  const numericTotals = [
    totals.problems,
    totals.correct,
    totals.skipped,
    totals.revealed,
    totals.mistakes,
    totals.firstTryCorrect,
    totals.accuracyPercent,
    totals.activeElapsedMs,
    totals.penaltyMs,
    totals.scoredElapsedMs,
  ]
  return (
    result.id.length > 0 &&
    result.sessionId.length > 0 &&
    normalizedConfig !== null &&
    validateConfig(normalizedConfig).length === 0 &&
    result.configKey === configKey(result.config) &&
    numericTotals.every((item) => Number.isSafeInteger(item) && item >= 0) &&
    totals.problems === result.problems.length &&
    totals.scoredElapsedMs === safeAdd(totals.activeElapsedMs, totals.penaltyMs)
  )
}

export function normalizeSprintResult(value: unknown): SprintResult | null {
  if (!isSprintResult(value)) return null
  return {
    ...value,
    config: { ...value.config, operations: [...value.config.operations], challenge: value.config.challenge ?? 'random' },
    totals: { ...value.totals },
    problems: value.problems.map((problem) => ({ ...problem, operands: [...problem.operands], operators: [...problem.operators] })),
  }
}

function safeAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}
