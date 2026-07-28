import { OPERATIONS, type Problem, type TrainingConfig } from '../math/engine'

export type OrientationPreference = 'horizontal' | 'vertical'

export interface PracticePreferences {
  orientation: OrientationPreference
  audioEnabled: boolean
}

export const DEFAULT_PREFERENCES: PracticePreferences = {
  orientation: 'horizontal',
  audioEnabled: false,
}

export type AudioCue =
  | 'type'
  | 'erase'
  | 'submit'
  | 'correct'
  | 'incorrect'
  | 'reveal'
  | 'skip'
  | 'complete'

export interface AudioPort {
  unlockFromUserGesture(): Promise<boolean>
  play(cue: AudioCue): void
  suspend(): void
}

export interface SharePayload {
  title: string
  text: string
  url?: string
}

export interface SharePort {
  share(payload: SharePayload): Promise<'shared' | 'copied' | 'unavailable'>
}

export function configKey(config: TrainingConfig): string {
  const selected = OPERATIONS.filter((operation) => config.operations.includes(operation))
  return [
    'config-v1',
    config.minDigits,
    config.maxDigits,
    config.operatorCount,
    config.operationMode,
    selected.join(','),
    config.problemCount,
  ].join(':')
}

export function effectiveOrientation(
  preference: OrientationPreference,
  problem: Pick<Problem, 'operators'>,
): OrientationPreference {
  return preference === 'vertical' && problem.operators.length === 1 ? 'vertical' : 'horizontal'
}

export function isPracticePreferences(value: unknown): value is PracticePreferences {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    (candidate.orientation === 'horizontal' || candidate.orientation === 'vertical') &&
    typeof candidate.audioEnabled === 'boolean'
  )
}
