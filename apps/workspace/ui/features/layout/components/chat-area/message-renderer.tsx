import { type FC, memo } from 'react'
import { FileText } from 'lucide-react'
import { AgentPrompt, AgentResponse, ErrorBanner, UserMessage } from '@/features/chat'
import type { ChatMessage } from '@/features/chat/types'
import type { UserMessageAuthor } from '@/features/chat/components/UserMessage'
import type { Finding, Findings } from '@/lib/conversations/message-findings'
import { RunBlockMessage } from '@/features/runs/components/RunBlockMessage'
import { useTranslations } from '@/i18n'
import { commonCopy } from '@/i18n/namespaces/common'
import { researchCopy } from '@/i18n/namespaces/research'
import { SourceDeletedNote } from '@/components/projects/source-deleted-note'

/**
 * Message renderer that dispatches to the correct component based on message type
 */
interface MessageRendererProps {
  message: ChatMessage
  /** Id of the conversation these messages belong to (for the memory chip). */
  conversationId?: string | null
  /** The active project — the run block reads its live ledger through it. */
  projectId?: string | null
  onErrorDismiss?: (messageId: string) => void
  /** Resend the last user message + dismiss this error card (retry affordance). */
  onErrorRetry?: (messageId: string) => void
  /** The reader's showReasoningSkills preference (fetched once by ChatArea). */
  showReasoning?: boolean
  /**
   * Who wrote this message. Present ONLY in a shared thread — absent means "render
   * exactly as before", which is what keeps a solo thread unchanged.
   */
  author?: UserMessageAuthor
  /** This message continues a run by the same author (no repeated header). */
  grouped?: boolean
  /** The reader, so a mention of them can be marked in the text. */
  currentUserId?: string | null
  /** Who a restored prompt was addressed to, for the read-only line (ADR-0037). */
  promptAddresseeName?: string | null
  /** The previous run's findings in this thread, for a report's change marks. */
  previousFindings?: Findings
  /** Commission a run to clear an open finding; absent when the thread cannot. */
  onCommissionFinding?: (finding: Finding) => Promise<boolean>
  /** „Bericht fortschreiben" for a finished run's message. */
  onContinueRun?: (message: ChatMessage) => Promise<void>
}

const MessageRendererComponent: FC<MessageRendererProps> = ({
  message,
  conversationId,
  projectId,
  onErrorDismiss,
  onErrorRetry,
  showReasoning = false,
  author,
  grouped,
  currentUserId,
  promptAddresseeName,
  previousFindings,
  onCommissionFinding,
  onContinueRun,
}) => {
  const tFileStatus = useTranslations(researchCopy)
  const tCommon = useTranslations(commonCopy)
  const messageType = message.messageType || (message.role === 'user' ? 'user' : 'assistant')

  switch (messageType) {
    case 'user':
      return (
        <UserMessage
          content={message.content}
          timestamp={message.timestamp}
          author={author}
          grouped={grouped}
          mentions={message.mentions}
          currentUserId={currentUserId}
        />
      )

    case 'prompt':
      return (
        <AgentPrompt
          content={message.content}
          options={message.promptOptions}
          isResponded={message.isPromptResponded}
          response={message.promptResponse}
          timestamp={message.timestamp}
          // `promptFor` is present only on a prompt restored from the server
          // (ADR-0037). Absent means a live prompt, where this browser holds the
          // socket and IS the addressee. Present and not us means a colleague's
          // question: read-only, because the agent tier refuses our answer anyway.
          isAddressee={!message.promptFor || message.promptFor === currentUserId}
          addresseeName={promptAddresseeName}
        />
      )

    case 'agent_response': {
      // Short answers from the agent displayed in the chat area. Built once,
      // here, because a RUN's message renders the same card beneath its block
      // once the run has a report — and the prop mapping must exist in one place.
      const answer = (
        <>
          <AgentResponse
            // An answer removed with its source folder shows the removal note
            // in the reader's language, not the stored German text (ADR-0088).
            content={message.erasedAt ? tCommon('derivedSource.erased') : message.content}
            timestamp={message.timestamp}
            answerDurationMs={message.answerDurationMs}
            cards={message.cards}
            citations={message.citations}
            conversationId={conversationId}
            // Both feed the „Piloti hat sich gemerkt" chip, which is now a fact
            // about THIS TURN rather than a poll of the conversation's memory:
            // the reflection stage's frame lands on `stages`, and a
            // `memory_proposal` counts only once `cardInteractions` says the
            // reader said yes.
            cardInteractions={message.cardInteractions}
            stages={message.stages}
            answerMeta={message.answerMeta}
            findings={message.findings}
            previousFindings={previousFindings}
            onCommissionFinding={onCommissionFinding}
            answerConfidence={message.answerConfidence}
            answerConfidenceCappedReason={message.answerConfidenceCappedReason}
            answerConfidenceReason={message.answerConfidenceReason}
            confidenceCheck={message.confidenceCheck}
            answerConfidenceVersion={message.answerConfidenceVersion}
            lookupFoundNothing={message.lookupFoundNothing}
            citationsRemoved={message.citationsRemoved}
            readSources={message.readSources}
            researchTruncated={message.researchTruncated}
            truncationReason={message.truncationReason}
            degradedReasons={message.degradedReasons}
            skillsActivated={message.skillsActivated}
            skillsHidden={message.skillsHidden}
            showReasoning={showReasoning}
            messageId={message.id}
            isStreaming={message.isStreaming}
            stopped={message.stopped === true}
            // A turn that failed under a written answer: the words stay, marked
            // as cut off, and stop typing at the failure.
            failed={message.failed === true}
            routingDecision={message.routingDecision}
            retrievalLedger={message.retrievalLedger}
            quoteStamps={message.quoteStamps}
          />
          {message.sourceDeletedAt && !message.erasedAt && (
            <SourceDeletedNote at={message.sourceDeletedAt} className="mt-1 px-1" />
          )}
        </>
      )
      // A message that carries a run ledger IS a run (ADR-0062): the block
      // renders from the ledger, and the answer card above becomes the report
      // beneath it once the run has one. Nothing else about the message
      // changes — same row, same id, same deep-link target.
      //
      // The answer card is now the whole of it. The Python worker still stamps
      // `deep_research_job_id` into every run message's metadata, and that used
      // to reach `AgentResponse` as `jobId` and grow a "Bericht anzeigen"
      // button on the finished block — a door that opened the legacy research
      // panel OVER the run it belongs to. `AgentResponse` no longer takes those
      // props, so the report is read where the reader already is.
      if (message.runLedger) {
        return (
          <RunBlockMessage
            message={message}
            projectId={projectId}
            conversationId={conversationId}
            answer={answer}
            onContinue={onContinueRun ? () => onContinueRun(message) : null}
          />
        )
      }
      return answer
    }

    case 'file':
      // File operation messages show upload/ingest status. The wire status is
      // never shown raw: anything this build cannot word falls back to
      // "Available" rather than leaking `success`/`deleted` into the thread.
      if (!message.fileData) {
        return null
      }
      // FileCard was removed in an earlier refactor — file display is handled
      // by FileSourceCard in the panel; the thread keeps this status line.
      const fileStatus = message.fileData.fileStatus
      const fileStatusLabel =
        fileStatus === 'uploading'
          ? tFileStatus('fileSourceCard.statusUploading')
          : fileStatus === 'ingesting'
            ? tFileStatus('fileSourceCard.statusIngesting')
            : fileStatus === 'success'
              ? tFileStatus('fileSourceCard.statusAvailable')
              : fileStatus === 'error'
                ? tFileStatus('fileSourceCard.statusError')
                : tFileStatus('fileSourceCard.statusAvailable')
      return (
        <div
          className="bg-muted flex items-center gap-2 rounded-bubble px-4 py-2 "
          role="status"
        >
          <FileText className="text-muted-foreground size-4" aria-hidden="true" />
          <span className="text-muted-foreground text-sm">
            {message.fileData.fileName} ({fileStatusLabel})
          </span>
        </div>
      )

    case 'error':
      // Error banners (dismissable)
      if (!message.errorData) {
        return null
      }
      return (
        <ErrorBanner
          code={message.errorData.errorCode}
          message={message.errorData.errorMessage}
          details={message.errorData.errorDetails}
          timestamp={message.timestamp}
          onDismiss={onErrorDismiss ? () => onErrorDismiss(message.id) : undefined}
          onRetry={onErrorRetry ? () => onErrorRetry(message.id) : undefined}
        />
      )

    case 'assistant':
      // Assistant messages (full reports) are not shown in chat area
      // They are displayed in the Details Panel instead
      return null

    default:
      return null
  }
}

/**
 * Memoized so a per-token store update (which streams into ONE message) only
 * re-renders that one bubble, not every message in the thread.
 *
 * The messages store rebuilds only the object of the message it mutates and
 * preserves references for all others (`[...messages.slice(0, -1), updated]`),
 * so message-object identity is an exact, load-bearing signal that this
 * message's id/content/isStreaming (and every other field) is unchanged. We
 * pair it with the small set of scalar/callback props the renderer actually
 * uses — all of which are stable across renders.
 */
const areMessageRendererPropsEqual = (
  prev: MessageRendererProps,
  next: MessageRendererProps
): boolean =>
  prev.message === next.message &&
  prev.message.id === next.message.id &&
  prev.message.content === next.message.content &&
  prev.message.isStreaming === next.message.isStreaming &&
  prev.conversationId === next.conversationId &&
  prev.projectId === next.projectId &&
  prev.previousFindings === next.previousFindings &&
  prev.onCommissionFinding === next.onCommissionFinding &&
  prev.onContinueRun === next.onContinueRun &&
  prev.showReasoning === next.showReasoning &&
  // Authorship is derived per render (from the roster + the reader), so compare
  // its fields rather than the object — otherwise every roster refresh would
  // re-render every bubble in the thread.
  prev.grouped === next.grouped &&
  prev.currentUserId === next.currentUserId &&
  Boolean(prev.author) === Boolean(next.author) &&
  prev.author?.userId === next.author?.userId &&
  prev.author?.name === next.author?.name &&
  prev.author?.avatarUrl === next.author?.avatarUrl &&
  prev.author?.isYou === next.author?.isYou &&
  prev.onErrorDismiss === next.onErrorDismiss &&
  prev.onErrorRetry === next.onErrorRetry

export const MessageRenderer = memo(MessageRendererComponent, areMessageRendererPropsEqual)
MessageRenderer.displayName = 'MessageRenderer'
