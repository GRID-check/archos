/**
 * A held mail that reads as someone posing as another (`riskLevel:
 * 'impersonation'`, `lib/inbound-mail/sender-risk.ts`): a rejected signature,
 * or an outsider writing under a member's name. The owner's rule after the
 * screenshots of 2026-10-22: such a mail is announced above everything else,
 * nothing of it is offered checked, and Piloti suggests nothing for it.
 *
 * The server already says so (every part's `preselected` is false, the view
 * drops a stored suggestion, the suggest job skips it). The detail holds the
 * same rule on its side too, through {@link guardImpersonation}, so a view
 * written before D8b, a stale cache or a fixture cannot pre-check a part or
 * draw a suggestion chip for a mail that asks for money under a colleague's
 * name. Pure, so the rule is tested once.
 */

import type { ImpersonationBasis } from '@/lib/inbound-mail/inbound-mail-vocabulary'
import type { InboundMailView } from '@/lib/inbound-mail/inbound-mail-wire'

/** What the warning names: why it reads as an impersonation, the name it uses, and the address it really came from. */
export interface ImpersonationWarning {
  basis: ImpersonationBasis
  name: string
  address: string
}

export function impersonationWarningOf(view: Pick<InboundMailView, 'riskLevel' | 'impersonation' | 'sender'>): ImpersonationWarning | null {
  if (view.riskLevel !== 'impersonation') return null
  const address = view.sender?.address ?? ''
  return {
    // A mail that reads as one without saying why is treated as the stronger case.
    basis: view.impersonation ?? 'rejected_signature',
    name: view.sender?.name?.trim() || address,
    address,
  }
}

/**
 * The view as the detail draws it: for an impersonation, every part without
 * Piloti's suggestion and not pre-selected; any other view unchanged (the
 * same object, so effects keyed on it do not run again).
 */
export function guardImpersonation(view: InboundMailView): InboundMailView {
  if (view.riskLevel !== 'impersonation') return view
  if (view.parts.every((part) => part.suggestion === null && !part.preselected)) return view
  return { ...view, parts: view.parts.map((part) => ({ ...part, suggestion: null, preselected: false })) }
}
