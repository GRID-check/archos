/**
 * Piloti's A2A agent card (ADR-0124), at the path the A2A specification names
 * (`/.well-known/agent-card.json`): what an A2A client reads before it sends a
 * message. Public by specification, like the RFC 9728 document beside it; the
 * proxy lets `/.well-known/*` through.
 */

import { agentCardResponse } from '@/lib/a2a/agent-card'

export const dynamic = 'force-dynamic'

export const GET = (): Response => agentCardResponse()
