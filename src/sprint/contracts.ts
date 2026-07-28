import { OPERATIONS, type Problem, type TrainingConfig } from '../math/engine'

export type OrientationPreference = 'horizontal' | 'vertical'
export type ThemePreference = 'forest' | 'midnight'
export type DensityPreference = 'comfortable' | 'compact'

export interface PracticePreferences {
  orientation: OrientationPreference
  audioEnabled: boolean
  theme: ThemePreference
  density: DensityPreference
}

export const DEFAULT_PREFERENCES: PracticePreferences = {
  orientation: 'horizontal',
  audioEnabled: false,
  theme: 'forest',
  density: 'comfortable',
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
  share(payload: SharePayload): Promise<'shared' | 'copied' | 'cancelled' | 'unavailable'>
  copy(payload: SharePayload): Promise<'copied' | 'unavailable'>
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

export function parsePracticePreferences(value: unknown): PracticePreferences | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Record<string, unknown>
  if (
    (candidate.orientation !== 'horizontal' && candidate.orientation !== 'vertical') ||
    typeof candidate.audioEnabled !== 'boolean' ||
    (candidate.theme !== undefined && candidate.theme !== 'forest' && candidate.theme !== 'midnight') ||
    (candidate.density !== undefined && candidate.density !== 'comfortable' && candidate.density !== 'compact')
  ) return null
  return {
    orientation: candidate.orientation,
    audioEnabled: candidate.audioEnabled,
    theme: candidate.theme === 'midnight' ? 'midnight' : 'forest',
    density: candidate.density === 'compact' ? 'compact' : 'comfortable',
  }
}

export function isPracticePreferences(value: unknown): value is PracticePreferences {
  const parsed = parsePracticePreferences(value)
  if (!parsed || typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return candidate.theme === parsed.theme && candidate.density === parsed.density
}
