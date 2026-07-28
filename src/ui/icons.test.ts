import { describe, expect, it } from 'vitest'
import { icon } from './icons'

describe('icon', () => {
  it('renders decorative, current-color SVG without external assets', () => {
    const markup = icon('bio')
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain('focusable="false"')
    expect(markup).toContain('ui-icon--bio')
    expect(markup).not.toContain('http')
  })
})
