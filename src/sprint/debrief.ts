import { OPERATIONS, evaluateExpression, type Operation, type Problem, type TrainingConfig } from '../math/engine'
import { SKIP_PENALTY_MS, type TrainingSession } from '../state/session'
import { configKey } from './contracts'
import type { SprintProblemResult, SprintResult } from './results'

export interface DebriefItem {
  index: number
  problem: Problem
  outcome: 'first-try' | 'retried' | 'skipped' | 'revealed'
  outcomeLabel: string
  incorrectAttempts: number
  activeElapsedMs: number | null
  reviewFocus: boolean
}

export interface SprintDebrief {
  total: number
  firstTry: number
  items: DebriefItem[]
  focusItems: DebriefItem[]
  longest: DebriefItem | null
}

export interface HistoricalFocusItem {
  problem: Problem
  outcomeLabel: string
  activeElapsedMs: number | null
  completedAt: number
}

export function createSprintDebrief(session: TrainingSession): SprintDebrief | null {
  if (session.mode !== 'sprint' || session.completedAt === null || session.progress.some((item) => item.status === 'pending')) return null
  if (session.problems.length === 0 || session.problems.length !== session.progress.length) return null
  const items = session.problems.map((problem, index) => {
    const progress = session.progress[index]!
    const outcome = progress.status === 'revealed'
      ? 'revealed'
      : progress.status === 'skipped'
        ? 'skipped'
        : progress.attempts > 1 ? 'retried' : 'first-try'
    const incorrectAttempts = progress.status === 'correct' ? Math.max(0, progress.attempts - 1) : progress.attempts
    return {
      index,
      problem: cloneProblem(problem),
      outcome,
      outcomeLabel: outcomeLabel(outcome, incorrectAttempts),
      incorrectAttempts,
      activeElapsedMs: progress.activeElapsedMs,
      reviewFocus: outcome !== 'first-try',
    } satisfies DebriefItem
  })
  const focusItems = items.filter((item) => item.reviewFocus).sort(compareDebriefItems)
  const timed = items.filter((item) => item.activeElapsedMs !== null)
  const longest = timed.sort((left, right) => (right.activeElapsedMs ?? -1) - (left.activeElapsedMs ?? -1) || left.index - right.index)[0] ?? null
  return { total: items.length, firstTry: items.filter((item) => item.outcome === 'first-try').length, items, focusItems, longest }
}

export function selectHistoricalFocus(
  results: readonly SprintResult[],
  config: TrainingConfig,
  limit = 5,
): HistoricalFocusItem[] {
  if (limit <= 0) return []
  const key = configKey(config)
  const candidates = results.slice(0, 25).flatMap((result) => {
    if (result.configKey !== key || !Number.isSafeInteger(result.completedAt) || result.completedAt < 0 || typeof result.id !== 'string' || !Array.isArray(result.problems)) return []
    return result.problems.flatMap((problem, index) => {
      const sanitized = sanitizeHistoricalProblem(problem, config)
      if (!sanitized || (problem.outcome === 'correct' && problem.attempts <= 1)) return []
      const outcome: DebriefItem['outcome'] = problem.outcome === 'revealed' ? 'revealed' : problem.outcome === 'skipped' ? 'skipped' : 'retried'
      const incorrectAttempts = problem.outcome === 'correct' ? problem.attempts - 1 : problem.attempts
      return [{
        problem: sanitized,
        outcome,
        outcomeLabel: outcomeLabel(outcome, incorrectAttempts),
        incorrectAttempts,
        activeElapsedMs: problem.activeElapsedMs,
        completedAt: result.completedAt,
        resultId: result.id,
        index,
      }]
    })
  }).sort(compareHistoricalItems)

  const seen = new Set<string>()
  const selected: HistoricalFocusItem[] = []
  for (const candidate of candidates) {
    const signature = JSON.stringify([candidate.problem.operands, candidate.problem.operators])
    if (seen.has(signature)) continue
    seen.add(signature)
    selected.push({
      problem: { ...cloneProblem(candidate.problem), id: `historical-focus-${selected.length + 1}` },
      outcomeLabel: candidate.outcomeLabel,
      activeElapsedMs: candidate.activeElapsedMs,
      completedAt: candidate.completedAt,
    })
    if (selected.length >= Math.min(5, limit)) break
  }
  return selected
}

function sanitizeHistoricalProblem(input: unknown, config: TrainingConfig): Problem | null {
  if (typeof input !== 'object' || input === null) return null
  const value = input as SprintProblemResult
  if (!Array.isArray(value.operands) || value.operands.length < 2 || value.operands.length > 5) return null
  if (!value.operands.every((operand) => typeof operand === 'string' && /^[1-9]\d{0,4}$/.test(operand) && operand.length >= config.minDigits && operand.length <= config.maxDigits)) return null
  if (!Array.isArray(value.operators) || value.operands.length !== value.operators.length + 1 || value.operators.length !== config.operatorCount) return null
  if (!value.operators.every((operation) => OPERATIONS.includes(operation) && config.operations.includes(operation))) return null
  const distinct = new Set(value.operators).size
  if (config.operationMode === 'same' ? distinct !== 1 : distinct < 2) return null
  if (!Number.isSafeInteger(value.attempts) || value.attempts < 0) return null
  if (value.outcome === 'correct' && value.attempts < 1) return null
  if (value.penaltyMs !== (value.outcome === 'skipped' ? SKIP_PENALTY_MS : 0)) return null
  if (value.activeElapsedMs === null ? value.scoredElapsedMs !== null : value.scoredElapsedMs !== value.activeElapsedMs + value.penaltyMs) return null
  if (value.activeElapsedMs !== null && (!Number.isSafeInteger(value.activeElapsedMs) || value.activeElapsedMs < 0)) return null
  const answer = evaluateExpression(value.operands.map(BigInt), value.operators)
  if (answer === null) return null
  return { id: 'historical-candidate', operands: [...value.operands], operators: [...value.operators] as Operation[], answer: String(answer) }
}

function compareDebriefItems(left: DebriefItem, right: DebriefItem): number {
  return severity(right.outcome) - severity(left.outcome)
    || right.incorrectAttempts - left.incorrectAttempts
    || compareTimeDescending(left.activeElapsedMs, right.activeElapsedMs)
    || left.index - right.index
}

function compareHistoricalItems(
  left: { outcome: DebriefItem['outcome']; incorrectAttempts: number; activeElapsedMs: number | null; completedAt: number; resultId: string; index: number },
  right: { outcome: DebriefItem['outcome']; incorrectAttempts: number; activeElapsedMs: number | null; completedAt: number; resultId: string; index: number },
): number {
  return severity(right.outcome) - severity(left.outcome)
    || right.incorrectAttempts - left.incorrectAttempts
    || compareTimeDescending(left.activeElapsedMs, right.activeElapsedMs)
    || right.completedAt - left.completedAt
    || left.resultId.localeCompare(right.resultId)
    || left.index - right.index
}

function severity(outcome: DebriefItem['outcome']): number {
  return outcome === 'revealed' ? 3 : outcome === 'skipped' ? 2 : outcome === 'retried' ? 1 : 0
}

function compareTimeDescending(left: number | null, right: number | null): number {
  if (left === null) return right === null ? 0 : 1
  if (right === null) return -1
  return right - left
}

function outcomeLabel(outcome: DebriefItem['outcome'], incorrectAttempts: number): string {
  if (outcome === 'first-try') return 'Correct first try'
  if (outcome === 'retried') return `Correct after ${incorrectAttempts} ${incorrectAttempts === 1 ? 'retry' : 'retries'}`
  if (outcome === 'skipped') return incorrectAttempts > 0 ? `Skipped after ${incorrectAttempts} ${incorrectAttempts === 1 ? 'attempt' : 'attempts'} · +20s` : 'Skipped · +20s'
  return incorrectAttempts > 0 ? `Answer revealed after ${incorrectAttempts} ${incorrectAttempts === 1 ? 'attempt' : 'attempts'}` : 'Answer revealed'
}

function cloneProblem(problem: Problem): Problem {
  return { ...problem, operands: [...problem.operands], operators: [...problem.operators] }
}
