/**
 * A name for a device that a person recognises, from its user agent
 * ("Safari auf iPhone", "Chrome auf Windows").
 *
 * Deliberately small and wrong in the corners: it only has to tell a person's
 * three devices apart in a list they can remove from. A library would parse
 * hundreds of agents we never see, and the one family that mattered (ua-parser-js
 * since v2) changed licence. Unknown parts are left out, never guessed, and the
 * label is always something, because the column is not null.
 */

const MAX_LABEL = 120

function browserOf(ua: string): string | null {
  // Order matters: every Chromium browser also says Chrome and Safari.
  if (/\bEdg(e|A|iOS)?\//.test(ua)) return 'Edge'
  if (/\bOPR\/|\bOpera\b/.test(ua)) return 'Opera'
  if (/\bSamsungBrowser\//.test(ua)) return 'Samsung Internet'
  if (/\b(Firefox|FxiOS)\//.test(ua)) return 'Firefox'
  if (/\b(Chrome|CriOS)\//.test(ua)) return 'Chrome'
  if (/\bSafari\//.test(ua)) return 'Safari'
  return null
}

function deviceOf(ua: string): string | null {
  if (/\biPhone\b/.test(ua)) return 'iPhone'
  if (/\biPad\b/.test(ua)) return 'iPad'
  if (/\bAndroid\b/.test(ua)) return /\bMobile\b/.test(ua) ? 'Android-Smartphone' : 'Android-Tablet'
  if (/\bWindows\b/.test(ua)) return 'Windows'
  if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) return 'Mac'
  if (/\bCrOS\b/.test(ua)) return 'Chromebook'
  if (/\bLinux\b|\bX11\b/.test(ua)) return 'Linux'
  return null
}

/** The label for a user agent header; "Unbekanntes Gerät" when nothing is recognised. */
export function deviceLabelFromUserAgent(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? '').slice(0, 512)
  const browser = browserOf(ua)
  const device = deviceOf(ua)
  const label = browser && device ? `${browser} auf ${device}` : (browser ?? device ?? 'Unbekanntes Gerät')
  return label.slice(0, MAX_LABEL)
}
