'use client'

/**
 * A host frame for `/dev/mcp-apps`: the MCP Apps SDK's own host side
 * (`AppBridge`, `PostMessageTransport`) drawing the built `ui://piloti/proposal-card`
 * document in a sandboxed iframe, as Claude or ChatGPT would.
 *
 * What it does as a host (MCP Apps 2026-01-26): the iframe is
 * `sandbox="allow-scripts"` with an opaque origin, its document carries the
 * spec's restrictive default CSP (the resource declares no domain), the bridge
 * connects before the document loads, and the tool result is sent once the view
 * says `initialized`. The view's `tools/call` is answered by a fake of the door
 * that moves the proposal as the proposal routes would; `/dev` has no backend.
 * A real deployment's door is what `mcp-apps.spec.ts` covers.
 */

import { useEffect, useRef, useState } from 'react'
import { AppBridge, PostMessageTransport, type McpUiHostContext } from '@modelcontextprotocol/ext-apps/app-bridge'
import type { CallToolResult } from '@modelcontextprotocol/client'
import type { ProposedChangeView } from '@/lib/proposals/types'

/** The spec's default when a resource declares no CSP domain ("Host Behavior", restrictive default). */
export const DEFAULT_VIEW_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "media-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'"

/** The document with the host's CSP as its first element, as a sandbox proxy would serve it. */
export function withCsp(html: string, csp: string = DEFAULT_VIEW_CSP): string {
  return html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`)
}

const result = (proposal: ProposedChangeView): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify({ proposal }) }],
  structuredContent: { proposal },
})

/** What the door would answer: apply and dismiss move the proposal once; a second press is a 409. */
function fakeDoor(start: ProposedChangeView, log: (line: string) => void) {
  let proposal = start
  return async (name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> => {
    log(`tools/call ${name} ${JSON.stringify(args ?? {})}`)
    await new Promise((settle) => setTimeout(settle, 500))
    if (name === 'proposal-get') return result(proposal)
    if (name !== 'proposal-card-apply' && name !== 'proposal-card-dismiss') {
      return { isError: true, content: [{ type: 'text', text: `Unknown tool ${name}` }], structuredContent: { status: 404 } }
    }
    if (proposal.status !== 'proposed') {
      return { isError: true, content: [{ type: 'text', text: 'Already decided. (HTTP 409, CONFLICT)' }], structuredContent: { status: 409, code: 'CONFLICT' } }
    }
    const applied = name === 'proposal-card-apply'
    proposal = {
      ...proposal,
      status: applied ? 'applied' : 'dismissed',
      canDecide: false,
      decidedBy: 'user_dev',
      decidedByName: 'Anna Berger',
      decidedAt: new Date().toISOString(),
      results: applied ? [{ label: 'folder-rename', ok: true }] : null,
    } as ProposedChangeView
    return result(proposal)
  }
}

export function HostFrame({
  html,
  proposal,
  hostContext,
  label,
}: {
  html: string
  proposal: ProposedChangeView
  hostContext: McpUiHostContext
  label: string
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(120)
  const [lines, setLines] = useState<string[]>([])
  const dark = hostContext.theme === 'dark'

  useEffect(() => {
    const iframe = frame.current
    const target = iframe?.contentWindow
    if (!iframe || !target) return
    const log = (line: string) => setLines((previous) => [...previous.slice(-5), line])
    const door = fakeDoor(proposal, log)
    const bridge = new AppBridge(
      null,
      { name: 'piloti-dev-host', version: '1.0.0' },
      { serverTools: {}, updateModelContext: { text: {} } },
      { hostContext: { ...hostContext, platform: 'web', displayMode: 'inline', containerDimensions: { maxHeight: 2000 } } },
    )
    bridge.oncalltool = (params) => door(params.name, params.arguments as Record<string, unknown> | undefined)
    bridge.onsizechange = ({ height: next }) => {
      if (typeof next === 'number') setHeight(Math.ceil(next))    }
    bridge.onupdatemodelcontext = async (params) => {
      const text = params.content?.find((item) => item.type === 'text')
      log(`ui/update-model-context: ${text && 'text' in text ? text.text : '(structured)'}`)
      return {}
    }
    bridge.oninitialized = () => {
      log('ui/notifications/initialized; sending the tool result')
      void bridge.sendToolInput({ arguments: { params: { id: proposal.id } } })
      void bridge.sendToolResult(result(proposal))
    }
    let closed = false
    void bridge.connect(new PostMessageTransport(target, target)).then(() => {
      if (!closed) iframe.srcdoc = withCsp(html)
    })
    return () => {
      closed = true
      void bridge.close()
    }
  }, [html, proposal, hostContext])

  return (
    <section className="flex w-[620px] max-w-full flex-col gap-2" data-testid={`host-frame-${label}`}>
      <p className="text-muted-foreground text-xs font-medium">{label}</p>
      <div
        className="rounded-2xl p-4"
        // The host's own page around the frame, in its theme.
        style={{ background: dark ? '#1f1e1d' : '#faf9f5', border: `1px solid ${dark ? '#3d3d3a' : '#e8e6dc'}` }}
      >
        <p className="mb-3 text-sm" style={{ color: dark ? '#c2c0b6' : '#5e5d59' }}>
          Assistant: Piloti has one open proposal for this project.
        </p>
        <iframe
          ref={frame}
          title={`Piloti proposal (${label})`}
          sandbox="allow-scripts"
          className="block w-full border-0"
          style={{ height, colorScheme: dark ? 'dark' : 'light' }}
        />
      </div>
      <pre className="text-muted-foreground overflow-x-auto text-[11px] leading-snug" data-testid="host-log">
        {lines.join('\n')}
      </pre>
    </section>
  )
}
