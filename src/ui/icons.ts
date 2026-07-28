export type IconName =
  | 'bio'
  | 'github'
  | 'linkedin'
  | 'sun'
  | 'moon'
  | 'compact'
  | 'comfortable'
  | 'share'
  | 'copy'
  | 'heart'
  | 'external'
  | 'spark'

const ICON_PATHS: Record<IconName, string> = {
  bio: '<circle cx="12" cy="8" r="3.25"/><path d="M5.5 20c.5-4 2.65-6 6.5-6s6 2 6.5 6"/>',
  github: '<path d="M12 2.7a9.3 9.3 0 0 0-2.94 18.12c.47.09.64-.2.64-.45v-1.78c-2.62.57-3.17-1.11-3.17-1.11-.43-1.09-1.05-1.38-1.05-1.38-.86-.59.07-.58.07-.58.95.07 1.45.98 1.45.98.85 1.44 2.22 1.03 2.76.79.09-.61.33-1.03.6-1.27-2.09-.24-4.29-1.05-4.29-4.66 0-1.03.37-1.87.98-2.53-.1-.24-.43-1.2.09-2.5 0 0 .8-.26 2.56.97A8.9 8.9 0 0 1 12 6.99c.79 0 1.58.11 2.33.31 1.77-1.23 2.56-.97 2.56-.97.52 1.3.19 2.26.09 2.5.61.66.98 1.5.98 2.53 0 3.62-2.2 4.41-4.3 4.65.34.29.64.86.64 1.74v2.62c0 .25.17.54.65.45A9.3 9.3 0 0 0 12 2.7Z" fill="currentColor" stroke="none"/>',
  linkedin: '<rect x="4" y="9" width="3.5" height="11" rx=".5"/><circle cx="5.75" cy="5.6" r="1.8"/><path d="M11 20v-6.3c0-2.15 1.25-4.05 3.75-4.05 2.65 0 4.25 1.75 4.25 4.9V20h-3.5v-5.05c0-1.45-.45-2.35-1.55-2.35-1.2 0-1.95.8-1.95 2.75V20Z"/>',
  sun: '<circle cx="12" cy="12" r="3.5"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M19.07 4.93l-1.42 1.42M6.35 17.65l-1.42 1.42"/>',
  moon: '<path d="M20 15.2A8.4 8.4 0 0 1 8.8 4a8.7 8.7 0 1 0 11.2 11.2Z"/>',
  compact: '<path d="M4 8h16M4 16h16M8 4 4 8l4 4M16 12l4 4-4 4"/>',
  comfortable: '<path d="M4 6h16M4 18h16M8 10l-4-4 4-4M16 14l4 4-4 4"/>',
  share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.5M8.2 13.2l7.6 4.5"/>',
  copy: '<rect x="8" y="8" width="11" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2"/>',
  heart: '<path d="M20.8 5.8c-1.8-2.1-5.2-1.9-6.8.4L12 9 10 6.2C8.4 3.9 5 3.7 3.2 5.8 1.5 7.8 1.8 10.8 3.7 12.6L12 21l8.3-8.4c1.9-1.8 2.2-4.8.5-6.8Z"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/>',
  spark: '<path d="m12 2 1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8Z"/><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7Z"/>',
}

export function icon(name: IconName): string {
  return `<svg class="ui-icon ui-icon--${name}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</svg>`
}
