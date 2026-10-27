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
 * the person. After a decision the model is told what the person decided
 * (`ui/update-model-context`), so the next turn does not offer it again.
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
import { A2uiCard } from '@/features/a2ui/A2uiCard'
import { ProposalTransportProvider, type ProposalTransport } from '@/features/grid-cards/hooks/proposal-transport'
import type { ProposalResponse } from '@/lib/proposals/types'
import { appProposalTransport, proposalOfResult } from './app-transport'
import { applyHostTheme } from './host-theme'
import { cardOfProposal, renderProposalCard } from './proposal-cards'

export const APP_INFO = { name: 'piloti-proposal-card', version: '1.0.0' } as const

type HostApp = Pick<App, 'callServerTool' | 'updateModelContext'>

/** What the model reads after the person decided on the card: one line, in the catalog's words. */
export function decisionContext(response: ProposalResponse): string {
  const { proposal } = response
  return `The person ${proposal.status === 'dismissed' ? 'discarded' : `decided (${proposal.status})`} Piloti proposal ${proposal.id} on its card. Do not propose it again.`
}

/** The transport, telling the model about each decision. A host that refuses the context update changes nothing. */
function reportingTransport(app: HostApp, initial: ProposalResponse | null): ProposalTransport {
  const base = appProposalTransport(app, initial)
  const report = async (response: ProposalResponse): Promise<ProposalResponse> => {
    await app
      .updateModelContext({ content: [{ type: 'text', text: decisionContext(response) }] })
      .catch(() => undefined)
    return response
  }
  return {
    ...base,
    apply: (id, body) => base.apply(id, body).then(report),
    dismiss: (id) => base.dismiss(id).then(report),
  }
}

function CardBody({ result, app }: { result: CallToolResult | null; app: HostApp }) {
  const t = useTranslations('chat')
  const initial = useMemo(() => proposalOfResult(result), [result])
  // One transport per proposal shown: the seed is the result the host handed over.
  const transport = useMemo(() => reportingTransport(app, initial), [app, initial])
  if (!result) {
    return <p className="card-caption text-muted-foreground" data-testid="mcp-app-waiting">{t('cards.mcpApp.waiting')}</p>
  }
  if (!initial) {
    return <p className="text-muted-foreground text-sm" data-testid="mcp-app-unreadable">{t('cards.mcpApp.unreadable')}</p>
  }
  const card = cardOfProposal(initial.proposal, {
    files: (count) => t('cards.mcpApp.fileTitle', { count }),
    memory: t('cards.mcpApp.memoryTitle'),
  })
  if (!card) {
    return <p className="text-muted-foreground text-sm" data-testid="mcp-app-decide-in-piloti">{t('cards.mcpApp.decideInPiloti')}</p>
  }
  return (
    <ProposalTransportProvider value={transport}>
      <A2uiCard card={card} surfaceKey={`proposal-${initial.proposal.id}`} render={renderProposalCard} />
    </ProposalTransportProvider>
  )
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
  if (error) console.error('[mcp-app] could not connect to the host', error)
  if (!app) return null
  return <ProposalCardFrame result={result} hostContext={hostContext} app={app} />
}
