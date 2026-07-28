import type { SharePayload, SharePort } from './contracts'

interface NavigatorShareLike {
  share?: (payload: SharePayload) => Promise<void>
  canShare?: (payload: SharePayload) => boolean
  clipboard?: { writeText: (value: string) => Promise<void> }
}

export interface SocialShareLinks {
  x: string
  facebook: string
  linkedIn: string
}

export class BrowserShare implements SharePort {
  private readonly navigator: NavigatorShareLike | null

  constructor(navigatorLike: NavigatorShareLike | null = getNavigator()) {
    this.navigator = navigatorLike
  }

  async share(payload: SharePayload): Promise<'shared' | 'copied' | 'cancelled' | 'unavailable'> {
    const share = this.navigator?.share
    const canShare = this.navigator?.canShare
    let nativeSupported = Boolean(share)
    try {
      if (share && canShare) nativeSupported = canShare.call(this.navigator, payload)
    } catch {
      nativeSupported = false
    }
    if (share && nativeSupported) {
      try {
        const operation = share.call(this.navigator, payload)
        await operation
        return 'shared'
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled'
        return 'unavailable'
      }
    }
    return this.copy(payload)
  }

  async copy(payload: SharePayload): Promise<'copied' | 'unavailable'> {
    try {
      if (!this.navigator?.clipboard) return 'unavailable'
      await this.navigator.clipboard.writeText([payload.text, payload.url].filter(Boolean).join('\n'))
      return 'copied'
    } catch {
      return 'unavailable'
    }
  }
}

export function createSocialShareLinks(payload: SharePayload): SocialShareLinks {
  const x = new URL('https://twitter.com/intent/tweet')
  x.searchParams.set('text', payload.text)
  if (payload.url) x.searchParams.set('url', payload.url)
  const facebook = new URL('https://www.facebook.com/sharer/sharer.php')
  if (payload.url) facebook.searchParams.set('u', payload.url)
  const linkedIn = new URL('https://www.linkedin.com/sharing/share-offsite/')
  if (payload.url) linkedIn.searchParams.set('url', payload.url)
  return { x: x.href, facebook: facebook.href, linkedIn: linkedIn.href }
}

function getNavigator(): NavigatorShareLike | null {
  try {
    return typeof navigator === 'undefined' ? null : navigator
  } catch {
    return null
  }
}
