export const OPERATIONS = ['add', 'subtract', 'multiply', 'divide'] as const

export type Operation = (typeof OPERATIONS)[number]
export type OperationMode = 'same' | 'mixed'

export interface TrainingConfig {
  minDigits: number
  maxDigits: number
  operatorCount: number
  operationMode: OperationMode
  operations: Operation[]
  problemCount: number
}

export interface Problem {
  id: string
  operands: string[]
  operators: Operation[]
  answer: string
}

export interface RandomSource {
  next: () => number
}

export const OPERATION_DETAILS: Record<
  Operation,
  { label: string; symbol: string; spoken: string; shortLabel: string }
> = {
  add: { label: 'Addition', symbol: '+', spoken: 'plus', shortLabel: 'Add' },
  subtract: { label: 'Subtraction', symbol: '−', spoken: 'minus', shortLabel: 'Subtract' },
  multiply: { label: 'Multiplication', symbol: '×', spoken: 'multiplied by', shortLabel: 'Multiply' },
  divide: { label: 'Division', symbol: '÷', spoken: 'divided by', shortLabel: 'Divide' },
}

export const DEFAULT_CONFIG: TrainingConfig = {
  minDigits: 1,
  maxDigits: 2,
  operatorCount: 1,
  operationMode: 'same',
  operations: ['add'],
  problemCount: 10,
}

const MAX_GENERATION_ATTEMPTS = 320

export function createSeededRandom(seed: number): RandomSource {
  let state = seed >>> 0
  if (state === 0) state = 0x9e3779b9

  return {
    next: () => {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      return (state >>> 0) / 0x1_0000_0000
    },
  }
}

export function createRandomSeed(): number {
  try {
    const values = new Uint32Array(1)
    globalThis.crypto.getRandomValues(values)
    return values[0] ?? 0x9e3779b9
  } catch {
    return (Date.now() ^ Math.floor(performance.now() * 1_000)) >>> 0
  }
}

export function operandBounds(config: Pick<TrainingConfig, 'minDigits' | 'maxDigits'>): {
  min: number
  max: number
} {
  return {
    min: 10 ** (config.minDigits - 1),
    max: 10 ** config.maxDigits - 1,
  }
}

export function validateConfig(config: TrainingConfig): string[] {
  const errors: string[] = []

  if (!Number.isInteger(config.minDigits) || config.minDigits < 1 || config.minDigits > 5) {
    errors.push('Minimum digits must be between 1 and 5.')
  }
  if (!Number.isInteger(config.maxDigits) || config.maxDigits < 1 || config.maxDigits > 5) {
    errors.push('Maximum digits must be between 1 and 5.')
  }
  if (config.minDigits > config.maxDigits) {
    errors.push('Minimum digits cannot be greater than maximum digits.')
  }
  if (!Number.isInteger(config.operatorCount) || config.operatorCount < 1 || config.operatorCount > 4) {
    errors.push('Operators per question must be between 1 and 4.')
  }
  if (!Number.isInteger(config.problemCount) || config.problemCount < 1 || config.problemCount > 50) {
    errors.push('Questions per session must be between 1 and 50.')
  }

  const uniqueOperations = new Set(config.operations)
  if (
    config.operations.length === 0 ||
    uniqueOperations.size !== config.operations.length ||
    config.operations.some((operation) => !OPERATIONS.includes(operation))
  ) {
    errors.push('Choose at least one valid operation without duplicates.')
  }

  if (config.operationMode !== 'same' && config.operationMode !== 'mixed') {
    errors.push('Choose a valid operation pattern.')
  }
  if (config.operationMode === 'mixed' && (uniqueOperations.size < 2 || config.operatorCount < 2)) {
    errors.push('Mixed questions need at least two operations and two operator positions.')
  }

  if (
    errors.length === 0 &&
    config.operationMode === 'same' &&
    uniqueOperations.has('divide') &&
    !canBuildDivisionChain(config)
  ) {
    errors.push(
      'That repeated-division range cannot produce whole-number answers. Broaden the digit range or use fewer operators.',
    )
  }

  return errors
}

export function evaluateExpression(
  operands: readonly bigint[],
  operators: readonly Operation[],
): bigint | null {
  if (operands.length === 0 || operands.length !== operators.length + 1) return null

  let total = 0n
  let term = operands[0]
  if (term === undefined) return null
  let additiveOperation: 'add' | 'subtract' = 'add'

  for (const [index, operation] of operators.entries()) {
    const next = operands[index + 1]
    if (next === undefined) return null

    if (operation === 'multiply') {
      term *= next
      continue
    }
    if (operation === 'divide') {
      if (next === 0n || term % next !== 0n) return null
      term /= next
      continue
    }

    total = additiveOperation === 'add' ? total + term : total - term
    additiveOperation = operation
    term = next
  }

  const result = additiveOperation === 'add' ? total + term : total - term
  return result >= 0n ? result : null
}

export function generateProblems(config: TrainingConfig, seed: number): Problem[] {
  const errors = validateConfig(config)
  if (errors.length > 0) throw new Error(errors.join(' '))

  const random = createSeededRandom(seed)
  return Array.from({ length: config.problemCount }, (_, index) =>
    generateProblem(config, random, `${seed >>> 0}-${index + 1}`),
  )
}

export function formatExpression(problem: Problem): string {
  return problem.operands
    .map((operand, index) => {
      const operation = problem.operators[index]
      return operation ? `${operand} ${OPERATION_DETAILS[operation].symbol}` : operand
    })
    .join(' ')
}

export function speakExpression(problem: Problem): string {
  return problem.operands
    .map((operand, index) => {
      const operation = problem.operators[index]
      return operation ? `${operand} ${OPERATION_DETAILS[operation].spoken}` : operand
    })
    .join(' ')
}

function generateProblem(config: TrainingConfig, random: RandomSource, id: string): Problem {
  const initialOperators = chooseOperators(config, random)

  if (initialOperators.every((operation) => operation === 'divide')) {
    const divisionProblem = buildDivisionChain(config, random, initialOperators, id)
    if (divisionProblem) return divisionProblem
  }

  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const operands = Array.from({ length: config.operatorCount + 1 }, () => randomOperand(config, random))
    const answer = evaluateExpression(operands, initialOperators)
    if (answer !== null) return createProblem(id, operands, initialOperators, answer)
  }

  const fallback = findFallback(config, initialOperators, id)
  if (fallback) return fallback

  throw new Error('Unable to create a valid question for this configuration.')
}

function chooseOperators(config: TrainingConfig, random: RandomSource): Operation[] {
  if (config.operationMode === 'same') {
    const operation = pick(config.operations, random)
    return Array.from({ length: config.operatorCount }, () => operation)
  }

  const operators = Array.from({ length: config.operatorCount }, () => pick(config.operations, random))
  if (new Set(operators).size === 1) {
    const first = operators[0]
    const alternative = config.operations.find((operation) => operation !== first)
    if (alternative) operators[operators.length - 1] = alternative
  }
  return operators
}

function randomOperand(config: TrainingConfig, random: RandomSource): bigint {
  const digits = randomInteger(random, config.minDigits, config.maxDigits)
  const min = 10 ** (digits - 1)
  const max = 10 ** digits - 1
  return BigInt(randomInteger(random, min, max))
}

function buildDivisionChain(
  config: TrainingConfig,
  random: RandomSource,
  operators: Operation[],
  id: string,
): Problem | null {
  const bounds = operandBounds(config)
  const min = BigInt(bounds.min)
  const max = BigInt(bounds.max)
  const divisors: bigint[] = []
  let product = 1n

  for (let index = 0; index < config.operatorCount; index += 1) {
    const remaining = BigInt(config.operatorCount - index - 1)
    const futureMinimum = min ** remaining
    const upper = max / (product * futureMinimum)
    if (upper < min) return null
    const divisor = BigInt(randomInteger(random, bounds.min, Number(upper)))
    divisors.push(divisor)
    product *= divisor
  }

  const quotientMinimum = maxBigInt(1n, divideRoundUp(min, product))
  const quotientMaximum = max / product
  if (quotientMaximum < quotientMinimum) return null
  const quotient = BigInt(randomInteger(random, Number(quotientMinimum), Number(quotientMaximum)))
  const dividend = product * quotient

  return createProblem(id, [dividend, ...divisors], operators, quotient)
}

function findFallback(config: TrainingConfig, initialOperators: Operation[], id: string): Problem | null {
  const bounds = operandBounds(config)
  const operandChoices = [...new Set([bounds.min, bounds.max])].map(BigInt)
  const operatorSequences = [initialOperators, ...enumerateOperatorSequences(config)]
  const seenSequences = new Set<string>()

  for (const operators of operatorSequences) {
    const sequenceKey = operators.join(',')
    if (seenSequences.has(sequenceKey)) continue
    seenSequences.add(sequenceKey)

    if (operators.every((operation) => operation === 'divide')) {
      const fixedRandom: RandomSource = { next: () => 0 }
      const divisionProblem = buildDivisionChain(config, fixedRandom, operators, id)
      if (divisionProblem) return divisionProblem
      continue
    }

    for (const operands of enumerateOperands(operandChoices, config.operatorCount + 1)) {
      const answer = evaluateExpression(operands, operators)
      if (answer !== null) return createProblem(id, operands, operators, answer)
    }
  }

  return null
}

function enumerateOperatorSequences(config: TrainingConfig): Operation[][] {
  const output: Operation[][] = []

  const visit = (current: Operation[]): void => {
    if (current.length === config.operatorCount) {
      const distinctCount = new Set(current).size
      if (config.operationMode === 'mixed' ? distinctCount >= 2 : distinctCount === 1) {
        output.push([...current])
      }
      return
    }

    for (const operation of config.operations) {
      if (config.operationMode === 'same' && current.length > 0 && current[0] !== operation) continue
      current.push(operation)
      visit(current)
      current.pop()
    }
  }

  visit([])
  return output
}

function* enumerateOperands(choices: bigint[], count: number): Generator<bigint[]> {
  const total = choices.length ** count
  for (let encoded = 0; encoded < total; encoded += 1) {
    let cursor = encoded
    const operands: bigint[] = []
    for (let index = 0; index < count; index += 1) {
      const choice = choices[cursor % choices.length]
      if (choice === undefined) break
      operands.push(choice)
      cursor = Math.floor(cursor / choices.length)
    }
    if (operands.length === count) yield operands
  }
}

function canBuildDivisionChain(config: TrainingConfig): boolean {
  const bounds = operandBounds(config)
  const minimumProduct = BigInt(bounds.min) ** BigInt(config.operatorCount)
  return minimumProduct <= BigInt(bounds.max)
}

function createProblem(
  id: string,
  operands: readonly bigint[],
  operators: readonly Operation[],
  answer: bigint,
): Problem {
  return {
    id,
    operands: operands.map(String),
    operators: [...operators],
    answer: String(answer),
  }
}

function pick<T>(values: readonly T[], random: RandomSource): T {
  const value = values[Math.floor(random.next() * values.length)]
  if (value === undefined) throw new Error('Cannot choose from an empty collection.')
  return value
}

function randomInteger(random: RandomSource, min: number, max: number): number {
  if (max < min) throw new Error(`Invalid random range: ${min}–${max}`)
  return Math.floor(random.next() * (max - min + 1)) + min
}

function divideRoundUp(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right
}
