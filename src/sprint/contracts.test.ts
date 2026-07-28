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
    expect(DEFAULT_PREFERENCES).toEqual({ orientation: 'horizontal', audioEnabled: false, theme: 'forest', density: 'comfortable' })
    expect(isPracticePreferences(DEFAULT_PREFERENCES)).toBe(true)
    expect(isPracticePreferences({ orientation: 'diagonal', audioEnabled: false })).toBe(false)
    expect(parsePracticePreferences({ orientation: 'vertical', audioEnabled: true })).toEqual({ orientation: 'vertical', audioEnabled: true, theme: 'forest', density: 'comfortable' })
    expect(parsePracticePreferences({ ...DEFAULT_PREFERENCES, theme: 'midnight', density: 'compact' })).toEqual({ orientation: 'horizontal', audioEnabled: false, theme: 'midnight', density: 'compact' })
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
