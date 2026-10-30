/**
 * A Skizze a person started on a page says a person drew it, in its line and
 * in its machine marking, until an agent's edit is filed; a Skizze Piloti drew
 * keeps the two-author line and the AI marking (S6 review, finding 5).
 */
import { describe, expect, it, vi } from 'vitest'
import { markingIsInBytes } from '@/lib/ai-provenance'
import { isPersonSketchRef, PERSON_SKETCH_REF_PREFIX } from '@/lib/documents/document-authors'
import { generatedDocumentMarking } from '@/lib/documents/generated'
import { aiDrewOn, sketchNoticeFor } from './sketch-notice'

vi.mock('server-only', () => ({}))

const notices = { edited: 'Von Piloti entworfen, von einer Person bearbeitet', person: 'Von einer Person gezeichnet', personEdited: 'Von einer Person gezeichnet, von Piloti weitergeführt' }
const PERSON = `${PERSON_SKETCH_REF_PREFIX}6f1c0d1e-0000-4000-8000-000000000001`
const ANSWER = 'msg_1-1a2b3c4d'

describe('who drew a Skizze', () => {
  it('marks a person-started Skizze as a person’s, not as AI-generated', () => {
    expect(isPersonSketchRef(PERSON)).toBe(true)
    expect(sketchNoticeFor(PERSON, notices, false)).toEqual({ notice: notices.person, aiAssisted: false })
    const marking = generatedDocumentMarking('diagram_svg', PERSON)
    expect(marking).toBe('AIGenerated=false')
    expect(markingIsInBytes(new TextEncoder().encode(`<desc>${marking}</desc>`), marking)).toBe(true)
  })

  it('marks it AI-assisted once an agent drew on it, and keeps that from its bytes', () => {
    expect(sketchNoticeFor(PERSON, notices, true)).toEqual({ notice: notices.personEdited, aiAssisted: true })
    const marking = generatedDocumentMarking('diagram_svg', PERSON, { aiAssisted: true })
    expect(marking).toContain('AIGenerated=true')
    expect(aiDrewOn(`<desc>${marking}</desc>`)).toBe(true)
    expect(aiDrewOn('<desc>AIGenerated=false</desc>')).toBe(false)
  })

  it('keeps Piloti’s markings on a Skizze an answer drew', () => {
    expect(isPersonSketchRef(ANSWER)).toBe(false)
    expect(sketchNoticeFor(ANSWER, notices, false)).toEqual({ notice: notices.edited, aiAssisted: true })
    expect(generatedDocumentMarking('diagram_pdf', ANSWER)).toContain('AIGenerated=true')
  })
})
