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
 * - everything else keeps the server's order (newest first).
 *
 * Pure.
 */

import type { InboundMailSummaryView, InboundMailThreadGroupView } from '@/lib/inbound-mail/inbound-mail-wire'

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

  // A group stands where the first of its mails stands; a mail of it not on this page is not drawn.
  const groupOf = new Map<string, ListSection & { kind: 'thread' }>()
  for (const group of options.groups ?? []) {
    const members = group.mails.map((entry) => byId.get(entry.mailId)).filter((mail): mail is InboundMailSummaryView => !!mail)
    if (members.length < 2) continue
    const section = {
      kind: 'thread' as const,
      threadId: group.threadId,
      name: group.name,
      firstVersion: group.firstVersion,
      lastVersion: group.lastVersion,
      mails: members,
    }
    for (const member of members) groupOf.set(member.id, section)
  }

  const sections: ListSection[] = []
  const placed = new Set<string>()
  for (const mail of loud) {
    const group = groupOf.get(mail.id)
    if (!group) {
      sections.push({ kind: 'mail', mail })
      continue
    }
    if (placed.has(group.threadId)) continue
    placed.add(group.threadId)
    sections.push(group)
  }
  if (quiet.length > 0) sections.push({ kind: 'quiet', mails: quiet })
  return sections
}

/** The mails in reading order, as J and K walk them; a collapsed quiet group is skipped. */
export function visibleMails(sections: readonly ListSection[], quietOpen: boolean): InboundMailSummaryView[] {
  return sections.flatMap((section) => {
    if (section.kind === 'mail') return [section.mail]
    if (section.kind === 'thread') return section.mails
    return quietOpen ? section.mails : []
  })
}
