/**
 * What another feature may take from the chat's `components/` and `hooks/`.
 *
 * The rest of its public surface is its top-level modules, imported by name
 * (`@/features/chat/store`, `/types`): the seam rule (`feature-deep-import`)
 * lets a feature reach those directly. This file used to `export *` the store,
 * the hooks, the types and every component, so a module that needed the store
 * pulled the whole chat in, and every spec reaching it re-ran on a change to
 * any chat component (docs/audit/blast-radius-2026-10.md §7.5). Add here only
 * what another feature imports from `components/` or `hooks/`.
 */

export { AgentPrompt } from './components/AgentPrompt'
export { AgentResponse } from './components/AgentResponse'
export { ChatThinking } from './components/ChatThinking'
export { ChatUsageNotice } from './components/ChatUsageNotice'
export { ErrorBanner } from './components/ErrorBanner'
export { NoSourcesBanner } from './components/NoSourcesBanner'
export { UserMessage } from './components/UserMessage'
export { useIsCurrentSessionBusy } from './hooks/use-current-session-busy'
export { formatElapsed, useElapsedSeconds } from './hooks/use-elapsed-seconds'
export { useWebSocketChat } from './hooks/use-websocket-chat'
