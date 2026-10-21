'use client'

/**
 * "Agent verbinden" in the profile (ADR-0122): how a person connects their own
 * AI assistant (Claude, ChatGPT, Cursor, ...) to Piloti.
 *
 * Draws a server-decided {@link AgentConnectState}; it reads no environment and
 * no flag itself, so `/dev/connect-agent` renders every state from fixtures.
 * Only when the state is `ready` does it show the address and the steps: an
 * address that leads to a refusal helps nobody. Otherwise a calm notice says
 * what is missing and who can change it.
 *
 * Built from the kit: Card, Alert, Tabs, and the CodeBlock (which already
 * carries the copy button) for the address and the commands.
 */

import type { JSX } from 'react'
import { BookOpen, Check, Plug, ShieldCheck, Info } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { SectionLabel } from '@/components/ui/section-label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTranslations } from '@/i18n'
import { CodeBlock } from '@/shared/components/CodeBlock'
import type { AgentConnectState } from '../lib/connect-state'

const SERVER_NAME = 'piloti'

type ClientId = 'claude' | 'claudeCode' | 'cursor' | 'chatgpt' | 'other'

interface ClientSpec {
  id: ClientId
  /** Step keys under `connectAgent.clients.<id>`, in order. */
  steps: readonly string[]
  /** A step after which a snippet is shown, with the snippet. */
  snippetAfter?: { step: string; language: string; value: (url: string) => string }
}

const CLIENTS: readonly ClientSpec[] = [
  { id: 'claude', steps: ['s1', 's2', 's3', 's4'] },
  {
    id: 'claudeCode',
    steps: ['s1', 's2', 's3'],
    snippetAfter: {
      step: 's1',
      language: 'bash',
      value: (url) => `claude mcp add --transport http ${SERVER_NAME} ${url}`,
    },
  },
  {
    id: 'cursor',
    steps: ['s1', 's2'],
    snippetAfter: {
      step: 's1',
      language: 'json',
      value: (url) => JSON.stringify({ mcpServers: { [SERVER_NAME]: { url } } }, null, 2),
    },
  },
  { id: 'chatgpt', steps: ['s1', 's2', 's3'] },
  { id: 'other', steps: ['s1', 's2', 's3'] },
]

const CAN_KEYS = ['projects', 'documents', 'shares', 'annotations', 'tasks', 'inbox'] as const
const STAYS_KEYS = ['confirm', 'sensitive', 'rights'] as const

export interface ConnectAgentCardProps {
  state: AgentConnectState
  /** Where the full user guide lives. */
  guideHref: string
}

function Notice({ state }: { state: AgentConnectState }): JSX.Element {
  const t = useTranslations('profile.connectAgent')
  const prefix = state.availability === 'not-configured' ? 'notConfigured' : 'orgDisabled'
  return (
    <Alert variant="info" data-testid="connect-agent-notice">
      <Info aria-hidden />
      <AlertTitle>{t(`notice.${prefix}Title`)}</AlertTitle>
      <AlertDescription>
        <p>{t(`notice.${prefix}Body`)}</p>
        <p className="mt-2">{t(`notice.${prefix}${state.canAdminister ? 'Admin' : 'Member'}`)}</p>
      </AlertDescription>
    </Alert>
  )
}

function ClientSteps({ client, url }: { client: ClientSpec; url: string }): JSX.Element {
  const t = useTranslations('profile.connectAgent')
  return (
    <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
      {client.steps.map((step) => (
        <li key={step}>
          <span>{t(`clients.${client.id}.${step}`)}</span>
          {client.snippetAfter?.step === step && (
            <CodeBlock
              value={client.snippetAfter.value(url)}
              language={client.snippetAfter.language}
            />
          )}
        </li>
      ))}
    </ol>
  )
}

function Bullets({ group, keys }: { group: 'can' | 'stays'; keys: readonly string[] }): JSX.Element {
  const t = useTranslations('profile.connectAgent')
  const Icon = group === 'can' ? Check : ShieldCheck
  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {keys.map((key) => (
        <li key={key} className="flex items-start gap-2">
          <Icon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{t(`${group}.${key}`)}</span>
        </li>
      ))}
    </ul>
  )
}

export function ConnectAgentCard({ state, guideHref }: ConnectAgentCardProps): JSX.Element {
  const t = useTranslations('profile.connectAgent')
  const url = state.availability === 'ready' ? state.url : null

  return (
    <Card data-testid="connect-agent">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Plug className="text-muted-foreground size-4" aria-hidden />
          {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {url === null ? (
          <Notice state={state} />
        ) : (
          <>
            <section className="flex flex-col gap-1">
              <SectionLabel as="h3">{t('urlLabel')}</SectionLabel>
              <CodeBlock value={url} language={t('urlCode')} className="!my-1" />
              <p className="text-muted-foreground text-xs">{t('urlHint')}</p>
            </section>

            <section className="flex flex-col gap-2">
              <SectionLabel as="h3">{t('steps.title')}</SectionLabel>
              <Tabs defaultValue={CLIENTS[0].id}>
                <TabsList className="flex-wrap">
                  {CLIENTS.map((client) => (
                    <ClientTab key={client.id} id={client.id} />
                  ))}
                </TabsList>
                {CLIENTS.map((client) => (
                  <TabsContent key={client.id} value={client.id} className="pt-2">
                    <ClientSteps client={client} url={url} />
                  </TabsContent>
                ))}
              </Tabs>
              <p className="text-muted-foreground text-xs">{t('steps.signIn')}</p>
            </section>
          </>
        )}

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <section className="flex flex-col gap-2">
            <SectionLabel as="h3">{t('can.title')}</SectionLabel>
            <p className="text-muted-foreground text-sm">{t('can.intro')}</p>
            <Bullets group="can" keys={CAN_KEYS} />
          </section>
          <section className="flex flex-col gap-2">
            <SectionLabel as="h3">{t('stays.title')}</SectionLabel>
            <Bullets group="stays" keys={STAYS_KEYS} />
          </section>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button asChild variant="outline" size="sm">
            <a href={guideHref} target="_blank" rel="noreferrer">
              <BookOpen aria-hidden />
              {t('guide')}
            </a>
          </Button>
          <span className="text-muted-foreground text-xs">{t('guideHint')}</span>
        </div>
      </CardContent>
    </Card>
  )
}

function ClientTab({ id }: { id: ClientId }): JSX.Element {
  const t = useTranslations('profile.connectAgent')
  return <TabsTrigger value={id}>{t(`clients.${id}.name`)}</TabsTrigger>
}
