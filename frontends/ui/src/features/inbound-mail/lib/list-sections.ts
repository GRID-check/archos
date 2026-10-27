/**
 * How the waiting list is arranged (DECISION §9, „List row“):
 *
 * - mails that continue the same E-Mail-Verlauf and would be pre-selected
 *   into it are grouped, so the conversation is filed in one press
 *   („3 E-Mails in E-Mail-Verlauf „…“ ablegen (wird Fassung 10–12)“). Which
 *   mails group, in which order, and the Fassung each becomes are the
 *   server's (`threadGroups` on the list, `lib/inbound-mail/thread-groups.ts`);
 *   this only places them;
 * - mail whose domain is not confirmed, and automatic mail, sit in one
 *   collapsed group at the end. They are listed, never hidden (every held
 *   mail is announced, D3), but they do not crowd out the conversation. A
 *   mail that reads as an impersonation is never quiet: it is the one a
 *   person must see;
 * - everything else is split in two, each under its own heading: „Bereit“,
 *   the mails filing as suggested asks nothing of anyone (`isReady`, the
 *   server's `incompleteReason`), first, because one press each clears them;
 *   then „Braucht Sie“, where each row names what it needs. A server thread
 *   group is split along the same line, so a conversation's ready mails go in
 *   one press even while one of its mails waits for a person;
 * - inside each, the server's order (newest first).
 *
 * Pure.
 */

import type { InboundMailSummaryView, InboundMailThreadGroupView } from '@/lib/inbound-mail/inbound-mail-wire'
import { isReady } from './completeness'

export type ListSection =
  | { kind: 'mail'; mail: InboundMailSummaryView }
  | {
      kind: 'thread'
      threadId: string
      name: string
      /** The Fassungen the thread goes through once every mail of the group is filed. */
      firstVersion: number
      lastVersion: number
      /** In the order they would be filed. */
      mails: InboundMailSummaryView[]
    }
  | { kind: 'quiet'; mails: InboundMailSummaryView[] }
  /** The heading over „Bereit“ or „Braucht Sie“, with every mail under it (thread groups included). */
  | { kind: 'readiness'; readiness: Readiness; mails: InboundMailSummaryView[] }

/** The two halves of the waiting list: filing as suggested asks nothing (`ready`), or it asks the person (`needs_you`). */
export type Readiness = 'ready' | 'needs_you'

/** Mail the list keeps quiet: an unconfirmed stranger, or a machine; never an impersonation. */
export function isQuietMail(mail: Pick<InboundMailSummaryView, 'senderTrust' | 'automatic' | 'riskLevel'>): boolean {
  if (mail.riskLevel === 'impersonation') return false
  return mail.automatic || mail.senderTrust === 'external_unverified'
}

export function listSections(
  mails: readonly InboundMailSummaryView[],
  options: { grouped: boolean; groups?: readonly InboundMailThreadGroupView[] },
): ListSection[] {
  if (!options.grouped) return mails.map((mail) => ({ kind: 'mail', mail }))
  const quiet = mails.filter(isQuietMail)
  const loud = mails.filter((mail) => !isQuietMail(mail))
  const byId = new Map(loud.map((mail) => [mail.id, mail]))
  const readinessOf = (mail: InboundMailSummaryView): Readiness => (isReady(mail) ? 'ready' : 'needs_you')

  // A server group is split by readiness first: one mail that needs a person must not hold
  // the rest of the conversation back from „Bereit“. Each half of two or more is a group of
  // its own, in the server's order; filed now, it takes the thread's next Fassungen from the
  // group's first on. A half of one is a plain row.
  const groupOf = new Map<string, ListSection & { kind: 'thread' }>()
  for (const group of options.groups ?? []) {
    const members = group.mails.map((entry) => byId.get(entry.mailId)).filter((mail): mail is InboundMailSummaryView => !!mail)
    for (const readiness of ['ready', 'needs_you'] as const) {
      const half = members.filter((mail) => readinessOf(mail) === readiness)
      if (half.length < 2) continue
      const section = {
        kind: 'thread' as const,
        threadId: group.threadId,
        name: group.name,
        firstVersion: group.firstVersion,
        lastVersion: group.firstVersion + half.length - 1,
        mails: half,
      }
      for (const member of half) groupOf.set(member.id, section)
    }
  }

  // A group stands where the first of its mails stands; a mail of it not on this page is not drawn.
  const halves: Record<Readiness, ListSection[]> = { ready: [], needs_you: [] }
  const placed = new Set<ListSection>()
  for (const mail of loud) {
    const group = groupOf.get(mail.id)
    if (!group) {
      halves[readinessOf(mail)].push({ kind: 'mail', mail })
      continue
    }
    if (placed.has(group)) continue
    placed.add(group)
    halves[readinessOf(mail)].push(group)
  }

  const sections: ListSection[] = []
  for (const readiness of ['ready', 'needs_you'] as const) {
    if (halves[readiness].length === 0) continue
    sections.push({ kind: 'readiness', readiness, mails: halves[readiness].flatMap(mailsOf) })
    sections.push(...halves[readiness])
  }
  if (quiet.length > 0) sections.push({ kind: 'quiet', mails: quiet })
  return sections
}

const mailsOf = (section: ListSection): InboundMailSummaryView[] =>
  section.kind === 'mail' ? [section.mail] : section.kind === 'thread' ? section.mails : []

/** The mails in reading order, as J and K walk them; a collapsed quiet group is skipped. */
export function visibleMails(sections: readonly ListSection[], quietOpen: boolean): InboundMailSummaryView[] {
  return sections.flatMap((section) => {
    if (section.kind === 'mail') return [section.mail]
    if (section.kind === 'thread') return section.mails
    if (section.kind === 'readiness') return []
    return quietOpen ? section.mails : []
  })
}
