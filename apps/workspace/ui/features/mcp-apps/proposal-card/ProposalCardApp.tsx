'use client'

/**
 * The proposal card as an MCP App (ADR-0142): what the host's sandboxed iframe
 * runs for a `proposal-get` result on Piloti's door.
 *
 * The view holds no data of its own. The host hands it the tool result
 * (`ui/notifications/tool-result`), whose `structuredContent` is the route's
 * own answer, `{ proposal }`; the card is the catalog card for it, drawn by the
 * A2UI renderer the chat uses (`A2uiCard`), in Piloti's components with the
 * host's theme (`host-theme.ts`) and the host's language (`hostContext.locale`).
 * Its buttons call the app-only tools (`proposal-card-apply`,
 * `proposal-card-dismiss`) through the host, which run the proposal routes as
 * the person. Whenever the card settles on a proposal that is no longer open
 * (the person's press, a 409's re-read, a replayed result that turned out
 * decided), the model is told it is no longer open (`ui/update-model-context`),
 * so the next turn does not offer to apply it.
 *
 * `ProposalCardFrame` is the part a spec or a `/dev` preview drives without a
 * host: a tool result, a host context and something that calls tools.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  useApp,
  type App,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps/react-with-deps'
import type { CallToolResult } from '@modelcontextprotocol/client'
import { I18nProvider, resolveLocale, useTranslations } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import { A2uiCard } from '@/features/a2ui/A2uiCard'
import { ProposalTransportProvider, type ProposalTransport } from '@/features/grid-cards/hooks/proposal-transport'
import type { ProposalResponse } from '@/lib/proposals/types'
import { appProposalTransport, proposalOfResult } from './app-transport'
import { applyHostTheme } from './host-theme'
import { cardOfProposal, renderProposalCard } from './proposal-cards'

export const APP_INFO = { name: 'piloti-proposal-card', version: '1.0.0' } as const

type HostApp = Pick<App, 'callServerTool' | 'updateModelContext'>

/** What the model reads once the card shows a proposal that is no longer open: one line, in the catalog's words. */
export function settledContext(response: ProposalResponse): string {
  const { proposal } = response
  const by = proposal.decidedByName ? ` by ${proposal.decidedByName}` : ''
  return `Piloti proposal ${proposal.id} is ${proposal.status}${by}; it is no longer open; do not apply or dismiss it.`
}

/**
 * The transport, telling the model each settled state the card reads, once per
 * proposal and status: a decision on the card, a 409's re-read, a replayed
 * result that is already decided. A host that refuses the update changes nothing.
 */
function reportingTransport(app: HostApp, initial: ProposalResponse | null): ProposalTransport {
  const base = appProposalTransport(app, initial)
  const told = new Set<string>()
  const report = async (response: ProposalResponse): Promise<ProposalResponse> => {
    const key = `${response.proposal.id}:${response.proposal.status}`
    if (response.proposal.status === 'proposed' || told.has(key)) return response
    told.add(key)
    await app
      .updateModelContext({ content: [{ type: 'text', text: settledContext(response) }] })
      .catch(() => undefined)
    return response
  }
  return {
    ...base,
    get: (id) => base.get(id).then(report),
    apply: (id, body) => base.apply(id, body).then(report),
    dismiss: (id) => base.dismiss(id).then(report),
  }
}

function CardBody({ result, app }: { result: CallToolResult | null; app: HostApp }) {
  const t = useTranslations(chatCopy)
  const initial = useMemo(() => proposalOfResult(result), [result])
  // One transport per proposal shown: the seed is the result the host handed over.
  const transport = useMemo(() => reportingTransport(app, initial), [app, initial])
  if (!result) {
    return <p className="card-caption text-muted-foreground" data-testid="mcp-app-waiting">{t('cards.mcpApp.waiting')}</p>
  }
  if (!initial) return <Unreadable />
  const drawn = cardOfProposal(initial.proposal, {
    files: (count) => t('cards.mcpApp.fileTitle', { count }),
    memory: t('cards.mcpApp.memoryTitle'),
  })
  if (drawn.kind === 'not-drawn') {
    return <p className="text-muted-foreground text-sm" data-testid="mcp-app-decide-in-workspace">{t('cards.mcpApp.decideInAgent')}</p>
  }
  if (drawn.kind === 'invalid') return <Unreadable />
  return (
    <ProposalTransportProvider value={transport}>
      <A2uiCard card={drawn.card} surfaceKey={`proposal-${initial.proposal.id}`} render={renderProposalCard} />
    </ProposalTransportProvider>
  )
}

function Unreadable() {
  const t = useTranslations(chatCopy)
  return <p className="text-muted-foreground text-sm" data-testid="mcp-app-unreadable">{t('cards.mcpApp.unreadable')}</p>
}

export function ProposalCardFrame({
  result,
  hostContext,
  app,
}: {
  result: CallToolResult | null
  hostContext: McpUiHostContext | undefined
  app: HostApp
}) {
  useEffect(() => applyHostTheme(hostContext), [hostContext])
  const locale = resolveLocale(hostContext?.locale)
  return (
    // The host's language, pinned: the frame has no session to read a preference from.
    <I18nProvider key={locale} initialLocale={locale} fixedLocale>
      <main className="text-foreground font-sans antialiased" data-testid="mcp-app-proposal-card">
        <CardBody result={result} app={app} />
      </main>
    </I18nProvider>
  )
}

/** The view a host loads: connects to the host and draws whatever proposal it hands over. */
export function ProposalCardApp() {
  const [result, setResult] = useState<CallToolResult | null>(null)
  const [hostContext, setHostContext] = useState<McpUiHostContext | undefined>(undefined)
  const { app, error } = useApp({
    appInfo: APP_INFO,
    capabilities: { availableDisplayModes: ['inline'] },
    onAppCreated: (created) => {
      created.ontoolresult = (params) => setResult(params as CallToolResult)
      created.onhostcontextchanged = (changed) => setHostContext((previous) => ({ ...previous, ...changed }))
    },
  })
  // The context `ui/initialize` answered with; later changes arrive through the handler above.
  useEffect(() => {
    if (app) setHostContext((previous) => ({ ...app.getHostContext(), ...previous }))
  }, [app])
  if (error) {
    console.error('[mcp-app] could not connect to the host', error)
    return <UnconnectedFrame />
  }
  if (!app) return null
  return <ProposalCardFrame result={result} hostContext={hostContext} app={app} />
}

/** No host to talk to: the unreadable line, in the browser's language, so the frame is never blank. */
function UnconnectedFrame() {
  const locale = resolveLocale(typeof navigator === 'undefined' ? undefined : navigator.language)
  return (
    <I18nProvider initialLocale={locale} fixedLocale>
      <main className="text-foreground font-sans antialiased" data-testid="mcp-app-proposal-card">
        <Unreadable />
      </main>
    </I18nProvider>
  )
}
