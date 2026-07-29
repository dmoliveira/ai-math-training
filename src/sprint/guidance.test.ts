import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG, validateConfig } from '../math/engine'
import { advanceSession, checkCurrentAnswer, createReviewSession, createTrainingSession, setCurrentDraft, skipCurrentProblem } from '../state/session'
import { PRACTICE_PRESETS, createStretchRecommendation, deriveLearningMilestones, deriveNextMission, matchingPresetId, practicePreset } from './guidance'

describe('guided practice', () => {
  it('provides valid, cloned full-config presets with canonical matching', () => {
    expect(PRACTICE_PRESETS).toHaveLength(3)
    for (const preset of PRACTICE_PRESETS) {
      expect(validateConfig(preset.config)).toEqual([])
      expect(matchingPresetId({ ...preset.config, operations: [...preset.config.operations].reverse() })).toBe(preset.id)
      const selected = practicePreset(preset.id)!
      expect(selected.config).toEqual(preset.config)
      expect(selected.config).not.toBe(preset.config)
      selected.config.operations.push('add')
      expect(selected.config.operations).not.toEqual(preset.config.operations)
    }
    expect(matchingPresetId(DEFAULT_CONFIG)).toBe('custom')
    expect(practicePreset('unknown')).toBeNull()
  })

  it('derives deterministic valid stretch steps without mutating input', () => {
    const source = { ...DEFAULT_CONFIG, operations: [...DEFAULT_CONFIG.operations], minDigits: 1, maxDigits: 1 }
    const before = structuredClone(source)
    expect(createStretchRecommendation(source)).toMatchObject({ config: { challenge: 3 }, change: expect.stringContaining('Random to Level 3') })
    expect(source).toEqual(before)

    const maxDigits = { ...source, minDigits: 5, maxDigits: 5, operatorCount: 1, challenge: 5 as const }
    expect(createStretchRecommendation(maxDigits)).toMatchObject({ config: { operatorCount: 2 } })
    expect(createStretchRecommendation({ ...maxDigits, operatorCount: 4 })).toBeNull()
  })

  it('derives finite evidence milestones for sprint and current review completion', () => {
    let clean = createTrainingSession({ ...DEFAULT_CONFIG, problemCount: 1 }, 1, 0)
    clean = setCurrentDraft(clean, clean.problems[0]!.answer)
    clean = advanceSession(checkCurrentAnswer(clean, 100), 200)
    expect(deriveLearningMilestones(clean).map((item) => item.id)).toEqual(['clean-set'])

    const mixed = { ...clean, config: { ...clean.config, operationMode: 'mixed' as const } }
    expect(deriveLearningMilestones(mixed).map((item) => item.id)).toEqual(['clean-set', 'mixed-explorer'])

    let source = createTrainingSession({ ...DEFAULT_CONFIG, problemCount: 1 }, 2, 0)
    source = skipCurrentProblem(source, 100)
    let review = createReviewSession(source, 200)!
    review = setCurrentDraft(review, review.problems[0]!.answer)
    review = advanceSession(checkCurrentAnswer(review, 300), 400)
    expect(deriveLearningMilestones(review).map((item) => item.id)).toEqual(['review-mastered'])
  })

  it('recommends exact review for difficulty, then stretch or repeat for clean runs', () => {
    let difficult = createTrainingSession({ ...DEFAULT_CONFIG, problemCount: 1 }, 3, 0)
    difficult = advanceSession(skipCurrentProblem(difficult, 100), 200)
    expect(deriveNextMission(difficult)).toMatchObject({ kind: 'review', title: 'Master 1 question' })

    let clean = createTrainingSession({ ...DEFAULT_CONFIG, problemCount: 1 }, 4, 0)
    clean = setCurrentDraft(clean, clean.problems[0]!.answer)
    clean = advanceSession(checkCurrentAnswer(clean, 100), 200)
    expect(deriveNextMission(clean)).toMatchObject({ kind: 'stretch', config: { challenge: 3 } })

    const ceiling = { ...clean, config: { ...clean.config, minDigits: 5, maxDigits: 5, operatorCount: 4, challenge: 5 as const } }
    expect(deriveNextMission(ceiling)).toMatchObject({ kind: 'repeat' })
    expect(deriveNextMission({ ...clean, completedAt: null })).toBeNull()
  })
})
