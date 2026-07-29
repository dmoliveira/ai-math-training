import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG } from '../math/engine'
import {
  DEFAULT_PREFERENCES,
  configKey,
  effectiveOrientation,
  isPracticePreferences,
  parsePracticePreferences,
} from './contracts'

describe('Sprint contracts', () => {
  it('uses privacy-friendly, autoplay-safe preference defaults', () => {
    expect(DEFAULT_PREFERENCES).toEqual({ orientation: 'horizontal', audioEnabled: false, theme: 'forest', density: 'comfortable', autoAdvance: true, hideTimers: false })
    expect(isPracticePreferences(DEFAULT_PREFERENCES)).toBe(true)
    expect(isPracticePreferences({ orientation: 'diagonal', audioEnabled: false })).toBe(false)
    expect(parsePracticePreferences({ orientation: 'vertical', audioEnabled: true })).toEqual({ orientation: 'vertical', audioEnabled: true, theme: 'forest', density: 'comfortable', autoAdvance: true, hideTimers: false })
    expect(parsePracticePreferences({ ...DEFAULT_PREFERENCES, theme: 'midnight', density: 'compact' })).toEqual({ orientation: 'horizontal', audioEnabled: false, theme: 'midnight', density: 'compact', autoAdvance: true, hideTimers: false })
  })

  it('keeps legacy and Random history together while isolating fixed challenge levels', () => {
    const legacy = { ...DEFAULT_CONFIG } as Partial<typeof DEFAULT_CONFIG>
    delete legacy.challenge
    expect(configKey(legacy as Omit<typeof DEFAULT_CONFIG, 'challenge'>)).toBe(configKey(DEFAULT_CONFIG))
    expect(configKey({ ...DEFAULT_CONFIG, challenge: 1 })).not.toBe(configKey(DEFAULT_CONFIG))
    expect(configKey({ ...DEFAULT_CONFIG, challenge: 1 })).not.toBe(configKey({ ...DEFAULT_CONFIG, challenge: 2 }))
  })

  it('canonicalizes operation selection order in equivalent configuration keys', () => {
    const left = { ...DEFAULT_CONFIG, operations: ['multiply', 'add'] as const, operationMode: 'mixed' as const, operatorCount: 2 }
    const right = { ...left, operations: ['add', 'multiply'] as const }
    expect(configKey({ ...left, operations: [...left.operations] })).toBe(
      configKey({ ...right, operations: [...right.operations] }),
    )
    expect(configKey({ ...right, operations: [...right.operations], problemCount: 20 })).not.toBe(
      configKey({ ...right, operations: [...right.operations] }),
    )
  })

  it('falls back to horizontal for chained expressions', () => {
    expect(effectiveOrientation('vertical', { operators: ['add'] })).toBe('vertical')
    expect(effectiveOrientation('vertical', { operators: ['add', 'add'] })).toBe('horizontal')
    expect(effectiveOrientation('horizontal', { operators: ['add'] })).toBe('horizontal')
  })
})
