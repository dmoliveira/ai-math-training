import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CONFIG,
  OPERATIONS,
  createSeededRandom,
  challengeScore,
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

  it('preserves the original seeded Random output byte for byte', () => {
    expect(generateProblems({ ...DEFAULT_CONFIG, problemCount: 3 }, 42)).toEqual([
      { id: '42-1', operands: ['19', '88'], operators: ['add'], answer: '107' },
      { id: '42-2', operands: ['60', '32'], operators: ['add'], answer: '92' },
      { id: '42-3', operands: ['74', '5'], operators: ['add'], answer: '79' },
    ])
  })

  it('creates deterministic, progressively tougher relative challenge bands', () => {
    const base: TrainingConfig = {
      ...DEFAULT_CONFIG,
      maxDigits: 4,
      operatorCount: 3,
      operationMode: 'mixed',
      operations: [...OPERATIONS],
      problemCount: 20,
    }
    const averages = [1, 2, 3, 4, 5].map((challenge) => {
      const config = { ...base, challenge: challenge as 1 | 2 | 3 | 4 | 5 }
      const first = generateProblems(config, 9876)
      expect(first).toEqual(generateProblems(config, 9876))
      expect(first.map((problem) => problem.id)).toEqual(Array.from({ length: 20 }, (_, index) => `9876-${index + 1}`))
      const scores = first.map((problem) => challengeScore(problem, config))
      expect(scores).toEqual(scores.slice().sort((left, right) => left - right))
      return scores.reduce((sum, score) => sum + score, 0) / scores.length
    })
    expect(averages).toEqual(averages.slice().sort((left, right) => left - right))
    expect(new Set(averages).size).toBe(5)
  })

  it('keeps all challenge levels valid across representative operation families', () => {
    const configs: TrainingConfig[] = [
      { ...DEFAULT_CONFIG, operations: ['subtract'], maxDigits: 5, operatorCount: 4, problemCount: 5 },
      { ...DEFAULT_CONFIG, operations: ['multiply'], maxDigits: 3, operatorCount: 3, problemCount: 5 },
      { ...DEFAULT_CONFIG, operations: ['divide'], maxDigits: 5, operatorCount: 4, problemCount: 5 },
      { ...DEFAULT_CONFIG, operations: [...OPERATIONS], operationMode: 'mixed', operatorCount: 4, maxDigits: 5, problemCount: 5 },
    ]
    for (const base of configs) {
      for (const challenge of [1, 2, 3, 4, 5] as const) {
        const config = { ...base, challenge }
        for (const problem of generateProblems(config, challenge * 100)) {
          expect(String(evaluateExpression(problem.operands.map(BigInt), problem.operators))).toBe(problem.answer)
        }
      }
    }
  })

  it('bounds maximum challenge generation cost', () => {
    const started = performance.now()
    const problems = generateProblems({ ...DEFAULT_CONFIG, maxDigits: 5, operatorCount: 4, operationMode: 'mixed', operations: [...OPERATIONS], problemCount: 50, challenge: 5 }, 2468)
    expect(problems).toHaveLength(50)
    expect(performance.now() - started).toBeLessThan(750)
  })

  it('builds exact repeated division without rejection loops', () => {
    const config: TrainingConfig = {
      minDigits: 1,
      maxDigits: 4,
      operatorCount: 4,
      operationMode: 'same',
      operations: ['divide'],
      problemCount: 12,
      challenge: 'random',
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
      challenge: 'random',
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
      challenge: 'random',
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
                  challenge: 'random',
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
