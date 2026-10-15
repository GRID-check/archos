/**
 * The way back to a long answer's list of sections, handed to its headings.
 *
 * A research report is ten sections of German legal prose, and on a phone a
 * citation, a table or a diagram sends the reader somewhere in the middle of
 * it. The report's `Abschnitte` sheet (`features/chat/components/AnswerOutline`)
 * is the jump list; this is how each section heading offers it, so that wherever
 * the reader stands the next section is one tap away and not a scroll to the top.
 *
 * Context rather than a prop because the heading is drawn by a markdown
 * component the renderer owns, several levels under the surface that knows the
 * answer is long enough to need an outline. Absent (the default) a heading is
 * exactly the heading it always was.
 */

'use client'

import { createContext, useContext } from 'react'

/** Opens the answer's section list; `null` when the answer offers none. */
const OutlineContext = createContext<(() => void) | null>(null)

export const OutlineProvider = OutlineContext.Provider

export const useOpenOutline = (): (() => void) | null => useContext(OutlineContext)
