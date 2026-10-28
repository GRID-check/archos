/**
 * The id of the answer message a headless turn writes. Shared by every caller
 * of the headless driver that waits for or reads its answer (`agent-asks`,
 * `document-check`), so none of them imports another's service for it.
 * `agent.turn.response.answer_message_id` derives the same uuid5.
 */

import { v5 as uuidv5 } from 'uuid'

/** The id of the answer a turn writes for `turnId` in `conversationId`. */
export function askAnswerMessageId(conversationId: string, turnId: string): string {
  return uuidv5(`grid:assistant:${conversationId}:${turnId}`, uuidv5.URL)
}
