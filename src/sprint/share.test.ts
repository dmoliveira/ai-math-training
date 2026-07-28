import { describe, expect, it, vi } from 'vitest'

import { BrowserShare, createSocialShareLinks } from './share'

const payload = { title: 'Result', text: 'Fast & accurate ✓', url: 'https://example.test/app/' }

describe('BrowserShare', () => {
  it('uses native sharing directly when supported', async () => {
    const share = vi.fn(async () => undefined)
    const clipboard = { writeText: vi.fn(async () => undefined) }
    const adapter = new BrowserShare({ share, canShare: () => true, clipboard })
    expect(await adapter.share(payload)).toBe('shared')
    expect(share).toHaveBeenCalledOnce()
    expect(clipboard.writeText).not.toHaveBeenCalled()
  })

  it('treats native cancellation separately without copying', async () => {
    const share = vi.fn(async () => { throw new DOMException('cancelled', 'AbortError') })
    const clipboard = { writeText: vi.fn(async () => undefined) }
    const adapter = new BrowserShare({ share, clipboard })
    expect(await adapter.share(payload)).toBe('cancelled')
    expect(clipboard.writeText).not.toHaveBeenCalled()
  })

  it('copies when native sharing is unavailable and reports clipboard failure', async () => {
    const clipboard = { writeText: vi.fn(async () => undefined) }
    expect(await new BrowserShare({ clipboard }).share(payload)).toBe('copied')
    expect(clipboard.writeText).toHaveBeenCalledWith('Fast & accurate ✓\nhttps://example.test/app/')
    expect(await new BrowserShare(null).copy(payload)).toBe('unavailable')
  })

  it('builds provider-specific encoded intent URLs', () => {
    const links = createSocialShareLinks(payload)
    expect(new URL(links.x).searchParams.get('text')).toBe(payload.text)
    expect(new URL(links.x).searchParams.get('url')).toBe(payload.url)
    expect(new URL(links.facebook).searchParams.get('u')).toBe(payload.url)
    expect(new URL(links.facebook).searchParams.has('text')).toBe(false)
    expect(new URL(links.linkedIn).searchParams.get('url')).toBe(payload.url)
  })
})
