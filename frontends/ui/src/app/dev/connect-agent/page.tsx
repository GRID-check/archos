'use client'

/**
 * Dev preview for "Agent verbinden" in the profile (ADR-0121): the section in
 * every state the server can decide, from fixtures. Not linked from anywhere;
 * 404s outside development. Pinned to German, the product's primary language.
 */

import type { JSX, ReactNode } from 'react'
import { notFound } from 'next/navigation'

import { I18nProvider } from '@/i18n'
import { ConnectAgentCard } from '@/features/agent-connect/components'
import { CONNECT_AGENT_FIXTURES } from '@/features/agent-connect/components/fixtures'
import { CONNECT_AGENT_GUIDE_URL } from '@/features/agent-connect/lib/guide'

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">{title}</h2>
      {children}
    </section>
  )
}

export default function ConnectAgentDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') notFound()

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main data-testid="connect-agent-preview" className="mx-auto flex max-w-3xl flex-col gap-10 p-4 text-foreground sm:p-8">
        <Section title="Eingeschaltet, Adresse und Schritte">
          <ConnectAgentCard state={CONNECT_AGENT_FIXTURES.ready} guideHref={CONNECT_AGENT_GUIDE_URL} />
        </Section>
        <Section title="Für die Organisation aus · Mitglied">
          <ConnectAgentCard state={CONNECT_AGENT_FIXTURES.orgDisabledMember} guideHref={CONNECT_AGENT_GUIDE_URL} />
        </Section>
        <Section title="Für die Organisation aus · Administration">
          <ConnectAgentCard state={CONNECT_AGENT_FIXTURES.orgDisabledAdmin} guideHref={CONNECT_AGENT_GUIDE_URL} />
        </Section>
        <Section title="Installation nicht eingerichtet · Mitglied">
          <ConnectAgentCard state={CONNECT_AGENT_FIXTURES.notConfigured} guideHref={CONNECT_AGENT_GUIDE_URL} />
        </Section>
        <Section title="Installation nicht eingerichtet · Administration">
          <ConnectAgentCard state={CONNECT_AGENT_FIXTURES.notConfiguredAdmin} guideHref={CONNECT_AGENT_GUIDE_URL} />
        </Section>
      </main>
    </I18nProvider>
  )
}
