import { vi } from 'vitest'

/** One download a test saw start: the link `startBrowserDownload` clicked. */
export interface StartedDownload {
  href: string
  download: string
}

/**
 * The downloads started from now on, as `startBrowserDownload` starts them
 * (`lib/browser-download.ts`, a temporary `<a download>` clicked): what the
 * browser would save, and under which name, without jsdom navigating. Reached
 * through the link rather than by mocking the module, so a helper in the same
 * module (`downloadFetched`) is seen too.
 */
export function captureDownloads(): StartedDownload[] {
  const started: StartedDownload[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    started.push({ href: this.getAttribute('href') ?? '', download: this.download })
  })
  return started
}
