'use client'

/** The five frames of `/dev/mcp-apps`; what each shows is in `page.tsx`. */

import type { McpUiHostContext } from '@modelcontextprotocol/ext-apps/app-bridge'
import { FILE_PROPOSAL, HOST_STYLES, OPERATION_PROPOSAL, READ_ONLY_PROPOSAL } from './fixtures'
import { HostFrame } from './host-frame'

const styles = { variables: HOST_STYLES }

// Module constants: a host context that changed identity would reconnect its frame.
const LIGHT: McpUiHostContext = { theme: 'light', locale: 'en-US', styles }
const DARK: McpUiHostContext = { theme: 'dark', locale: 'en-US', styles }
const PLAIN: McpUiHostContext = { theme: 'light', locale: 'en-US' }
const GERMAN: McpUiHostContext = { theme: 'light', locale: 'de-AT', styles }

export function McpAppsPreview({ html }: { html: string }) {
  return (
    <main className="bg-background flex min-h-screen flex-wrap items-start gap-8 p-8">
      <HostFrame label="host theme, light" html={html} proposal={OPERATION_PROPOSAL} hostContext={LIGHT} />
      <HostFrame label="host theme, dark" html={html} proposal={OPERATION_PROPOSAL} hostContext={DARK} />
      <HostFrame label="no host styles" html={html} proposal={FILE_PROPOSAL} hostContext={PLAIN} />
      <HostFrame label="German host" html={html} proposal={FILE_PROPOSAL} hostContext={GERMAN} />
      <HostFrame label="read only" html={html} proposal={READ_ONLY_PROPOSAL} hostContext={LIGHT} />
    </main>
  )
}
