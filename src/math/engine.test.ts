import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CONFIG,
  OPERATIONS,
  createSeededRandom,
  evaluateExpression,
  formatExpression,
  generateProblems,
  speakExpression,
  validateConfig,
  type Operation,
  type TrainingConfig,
} from './engine'

describe('arithmetic engine', () => {
  it('uses standard precedence and exact division', () => {
    expect(evaluateExpression([8n, 2n, 3n], ['add', 'multiply'])).toBe(14n)
    expect(evaluateExpression([20n, 5n, 2n], ['divide', 'subtract'])).toBe(2n)
    expect(evaluateExpression([8n, 3n], ['divide'])).toBeNull()
    expect(evaluateExpression([3n, 8n], ['subtract'])).toBeNull()
    expect(evaluateExpression([8n, 0n], ['divide'])).toBeNull()
  })

  it('is deterministic for a fixed seed', () => {
    const config: TrainingConfig = {
      ...DEFAULT_CONFIG,
      maxDigits: 3,
      operatorCount: 3,
      operationMode: 'mixed',
      operations: ['add', 'subtract', 'multiply'],
      problemCount: 8,
    }

    expect(generateProblems(config, 42)).toEqual(generateProblems(config, 42))
    expect(generateProblems(config, 42)).not.toEqual(generateProblems(config, 43))
  })

  it('builds exact repeated division without rejection loops', () => {
    const config: TrainingConfig = {
      minDigits: 1,
      maxDigits: 4,
      operatorCount: 4,
      operationMode: 'same',
      operations: ['divide'],
      problemCount: 12,
    }

    for (const problem of generateProblems(config, 7)) {
      const answer = evaluateExpression(problem.operands.map(BigInt), problem.operators)
      expect(String(answer)).toBe(problem.answer)
      expect(problem.operands.every((value) => value.length >= 1 && value.length <= 4)).toBe(true)
    }
  })

  it('handles a near-limit valid repeated-division range', () => {
    const config: TrainingConfig = {
      minDigits: 2,
      maxDigits: 5,
      operatorCount: 4,
      operationMode: 'same',
      operations: ['divide'],
      problemCount: 3,
    }

    for (const problem of generateProblems(config, 99)) {
      expect(problem.operands.every((value) => value.length >= 2 && value.length <= 5)).toBe(true)
      expect(String(evaluateExpression(problem.operands.map(BigInt), problem.operators))).toBe(
        problem.answer,
      )
    }
  })

  it('rejects a repeated-division range that cannot have an integer result', () => {
    const errors = validateConfig({
      minDigits: 5,
      maxDigits: 5,
      operatorCount: 2,
      operationMode: 'same',
      operations: ['divide'],
      problemCount: 5,
    })

    expect(errors).toContain(
      'That repeated-division range cannot produce whole-number answers. Broaden the digit range or use fewer operators.',
    )
  })

  it(
    'terminates and preserves invariants for every valid settings combination',
    { timeout: 30_000 },
    () => {
      const operationSets = subsets([...OPERATIONS])
      let seed = 1

      for (let minDigits = 1; minDigits <= 5; minDigits += 1) {
        for (let maxDigits = minDigits; maxDigits <= 5; maxDigits += 1) {
          for (let operatorCount = 1; operatorCount <= 4; operatorCount += 1) {
            for (const operations of operationSets) {
              for (const operationMode of ['same', 'mixed'] as const) {
                const config: TrainingConfig = {
                  minDigits,
                  maxDigits,
                  operatorCount,
                  operationMode,
                  operations,
                  problemCount: 1,
                }
                if (validateConfig(config).length > 0) continue

                const problem = generateProblems(config, seed)[0]
                seed += 1
                expect(problem, JSON.stringify(config)).toBeDefined()
                if (!problem) continue

                expect(problem.operands).toHaveLength(operatorCount + 1)
                expect(problem.operators).toHaveLength(operatorCount)
                expect(
                  problem.operands.every(
                    (operand) => operand.length >= minDigits && operand.length <= maxDigits,
                  ),
                ).toBe(true)
                expect(String(evaluateExpression(problem.operands.map(BigInt), problem.operators))).toBe(
                  problem.answer,
                )
                expect(BigInt(problem.answer)).toBeGreaterThanOrEqual(0n)
                expect(new Set(problem.operators).size).toBeGreaterThanOrEqual(operationMode === 'mixed' ? 2 : 1)
                if (operationMode === 'same') expect(new Set(problem.operators).size).toBe(1)
              }
            }
          }
        }
      }
    },
  )

  it('formats visual and spoken expressions', () => {
    const problem = {
      id: 'example',
      operands: ['12', '3', '4'],
      operators: ['add', 'multiply'] satisfies Operation[],
      answer: '24',
    }

    expect(formatExpression(problem)).toBe('12 + 3 × 4')
    expect(speakExpression(problem)).toBe('12 plus 3 multiplied by 4')
  })

  it('produces stable pseudo-random values in [0, 1)', () => {
    const first = createSeededRandom(123)
    const second = createSeededRandom(123)
    const values = Array.from({ length: 20 }, () => first.next())
    expect(values).toEqual(Array.from({ length: 20 }, () => second.next()))
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true)
  })
})

function subsets(values: Operation[]): Operation[][] {
  const result: Operation[][] = []
  for (let mask = 1; mask < 1 << values.length; mask += 1) {
    result.push(values.filter((_, index) => (mask & (1 << index)) !== 0))
  }
  return result
}
