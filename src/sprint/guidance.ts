import { validateConfig, type TrainingConfig } from '../math/engine'
import { isDifficultProgress, type TrainingSession } from '../state/session'
import { configKey } from './contracts'

export type PracticePresetId = 'quick-win' | 'build-fluency' | 'stretch-thinking'

export interface PracticePreset {
  id: PracticePresetId
  eyebrow: string
  title: string
  description: string
  config: TrainingConfig
}

export interface LearningMilestone {
  id: 'clean-set' | 'mixed-explorer' | 'review-mastered'
  title: string
  detail: string
}

export type NextMission =
  | { kind: 'review'; title: string; detail: string }
  | { kind: 'stretch'; title: string; detail: string; config: TrainingConfig; change: string }
  | { kind: 'repeat'; title: string; detail: string }

export const PRACTICE_PRESETS: readonly PracticePreset[] = [
  {
    id: 'quick-win',
    eyebrow: 'Gentle start',
    title: 'Quick win',
    description: '5 one-digit addition and subtraction questions.',
    config: { minDigits: 1, maxDigits: 1, operatorCount: 1, operationMode: 'same', operations: ['add', 'subtract'], problemCount: 5, challenge: 1 },
  },
  {
    id: 'build-fluency',
    eyebrow: 'Skill builder',
    title: 'Build fluency',
    description: '10 one-digit multiplication and exact-division questions.',
    config: { minDigits: 1, maxDigits: 1, operatorCount: 1, operationMode: 'same', operations: ['multiply', 'divide'], problemCount: 10, challenge: 3 },
  },
  {
    id: 'stretch-thinking',
    eyebrow: 'Fresh challenge',
    title: 'Stretch thinking',
    description: '10 two-digit mixed addition and subtraction questions.',
    config: { minDigits: 2, maxDigits: 2, operatorCount: 2, operationMode: 'mixed', operations: ['add', 'subtract'], problemCount: 10, challenge: 4 },
  },
] as const

export function practicePreset(id: string): PracticePreset | null {
  const preset = PRACTICE_PRESETS.find((item) => item.id === id)
  return preset ? { ...preset, config: cloneConfig(preset.config) } : null
}

export function matchingPresetId(config: TrainingConfig): PracticePresetId | 'custom' {
  const key = configKey(config)
  return PRACTICE_PRESETS.find((preset) => configKey(preset.config) === key)?.id ?? 'custom'
}

export function deriveLearningMilestones(session: TrainingSession): LearningMilestone[] {
  if (session.completedAt === null) return []
  if (session.mode === 'review') {
    const mastered = session.progress.every((item) => item.status === 'correct' && item.attempts === 1)
    return mastered
      ? [{ id: 'review-mastered', title: 'Review mastered', detail: 'Every review question landed on the first try.' }]
      : []
  }

  const milestones: LearningMilestone[] = []
  const clean = session.mistakes === 0 && session.progress.every((item) => item.status === 'correct' && item.attempts === 1)
  if (clean) milestones.push({ id: 'clean-set', title: 'Clean set', detail: 'Every answer was correct on the first try.' })
  if (session.config.operationMode === 'mixed') milestones.push({ id: 'mixed-explorer', title: 'Mixed explorer', detail: 'You switched operations inside each expression.' })
  return milestones
}

export function deriveNextMission(session: TrainingSession): NextMission | null {
  if (session.mode !== 'sprint' || session.completedAt === null) return null
  const difficult = session.progress.filter(isDifficultProgress).length
  if (difficult > 0) {
    return {
      kind: 'review',
      title: `Master ${difficult} ${difficult === 1 ? 'question' : 'questions'}`,
      detail: 'Practise the exact expressions that took extra work while they are still fresh.',
    }
  }

  const stretch = createStretchRecommendation(session.config)
  if (stretch) {
    return {
      kind: 'stretch',
      title: 'Try a one-step stretch',
      detail: `${stretch.change} Your new setup will have its own private rankings and history.`,
      config: stretch.config,
      change: stretch.change,
    }
  }

  return { kind: 'repeat', title: 'Repeat for fluency', detail: 'Run this exact setup again and make the comfortable pattern feel automatic.' }
}

export function createStretchRecommendation(config: TrainingConfig): { config: TrainingConfig; change: string } | null {
  const candidates: Array<{ config: TrainingConfig; change: string }> = []
  if (config.challenge === 'random') {
    candidates.push({
      config: { ...cloneConfig(config), challenge: 3 },
      change: 'Switch from Random to Level 3 for a steady easy-to-hard ramp; everything else stays the same.',
    })
  } else if (config.challenge < 5) {
    candidates.push({
      config: { ...cloneConfig(config), challenge: (config.challenge + 1) as 2 | 3 | 4 | 5 },
      change: `Move from challenge Level ${config.challenge} to Level ${config.challenge + 1}; everything else stays the same.`,
    })
  }
  if (config.maxDigits < 5) {
    candidates.push({
      config: { ...cloneConfig(config), maxDigits: config.maxDigits + 1 },
      change: `Increase the largest numbers from ${config.maxDigits} to ${config.maxDigits + 1} digits; everything else stays the same.`,
    })
  }
  if (config.operatorCount < 4) {
    candidates.push({
      config: { ...cloneConfig(config), operatorCount: config.operatorCount + 1 },
      change: `Use ${config.operatorCount + 1} operators per question instead of ${config.operatorCount}; everything else stays the same.`,
    })
  }
  return candidates.find((candidate) => validateConfig(candidate.config).length === 0) ?? null
}

function cloneConfig(config: TrainingConfig): TrainingConfig {
  return { ...config, operations: [...config.operations] }
}
