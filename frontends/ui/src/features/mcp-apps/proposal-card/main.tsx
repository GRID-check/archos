/**
 * The proposal card view's entry (ADR-0142): bundled into one HTML document by
 * `scripts/build-mcp-app-views.ts` and served as `ui://piloti/proposal-card`.
 * Nothing here runs in Piloti's own pages.
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ProposalCardApp } from './ProposalCardApp'

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ProposalCardApp />
    </StrictMode>
  )
}
