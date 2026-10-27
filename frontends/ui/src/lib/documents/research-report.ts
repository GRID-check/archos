/**
 * The first caller of `fileGeneratedDocument`: a finished deep-research run.
 *
 * A separate module from the jobs proxy for the reason every other route in
 * this app has one — a route handler validates a request shape and delegates —
 * and for one specific to this path: what a research report LOOKS like (its
 * title, its renderer, its marking) is a product decision that will change
 * without the proxy changing, and the next producer must be able to arrive as a
 * sibling of this file rather than as another branch inside the proxy.
 *
 * It owns exactly two things the service deliberately does not:
 *
 *   - the renderer. `@/lib/pdf` already turns Markdown into a PDF, so a
 *     research report is that pipeline with the two provenance options turned
 *     on — never a second exporter.
 *   - the title, which is read out of the report the writer agent produced
 *     rather than invented here.
 *
 * ## Why the filed report is a PDF and the saved-answer export is a .docx
 *
 * They are different documents with different jobs, and the format follows the
 * job. A saved answer is exported so somebody can EDIT it — paste it into a
 * Befund, revise it, sign it — and `answer-export/docx.ts` says so in its own
 * header. A filed report is exported so somebody can READ it in the app and
 * ATTACH it to an Einreichung, and both of those want a PDF:
 *
 *   - `PREVIEW_TYPES` in `features/documents/components/file-preview-pane.tsx`
 *     lists the content types the Files pane can render. `.docx` is not one of
 *     them, so the report a user had just commissioned landed in Berichte as a
 *     generic icon with no in-app preview — download-only, for the one document
 *     in the project nobody had read yet;
 *   - an Einreichung attachment is a PDF. Handing the Behörde an editable Word
 *     file is not the form the artifact takes at the end of this flow.
 *
 * The `.docx` export path for saved answers is untouched and stays. This is a
 * new renderer at an existing seam — `fileGeneratedDocument` takes the render
 * function precisely so a new output format is not a new pipeline.
 */

import 'server-only'
import { getLocale, getTranslations } from '@/i18n/server'
import type { Locale } from '@/i18n/config'
import type { Translator } from '@/i18n/translate'
import { PDF_MEDIA_TYPE, renderMarkdownPdf } from '@/lib/pdf/markdown-pdf'
import type { DocumentFact } from '@/lib/answer-export/answer-document'
import { AI_GENERATOR_NAME } from '@/lib/ai-provenance'
import { buildProjectBriefView } from '@/lib/project-profile/brief-view'
import { getOrganizationDisplayName } from '@/lib/organizations/service'
import { findProjectIdByCollectionName, findProjectInOrg } from '@/lib/projects/repository'
import { ApiError } from '@/lib/api/errors'
import type { AuthorizedSession, GridSession } from '@/lib/auth/types'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { findOpenJobId } from '@/lib/jobs-queue/repository'
import { BFF_JOB_PRIORITY, requesterOf, type FileResearchReportPayload } from '@/lib/jobs-queue/types'
import { resolveDocumentBranding } from './branding'
import { contentDigest } from './content-digest'
import { assertMayFileGeneratedDocument, fileGeneratedDocument, type FiledGeneratedDocument } from './generated'
import { createDocumentVersion, transitionDocumentVersion } from './lifecycle'
import { findDocumentAuthoredByRef, findDocumentInOrg } from './repository'
import { internalRead } from '@/lib/documents/document-reader'
import { findOpenVersion } from './version-repository'

export interface FileResearchReportInput {
  session: AuthorizedSession
  projectId: string
  /** The backend async job id of the run. */
  runId: string
  /** The report as the writer agent wrote it: Markdown. */
  report: string
  /**
   * The run's Grid cards, as `metadata.cards` stores them. The `legal_basis`
   * ones become the „Rechtsgrundlagen" section; every other type is ignored
   * here, because the report's prose already carries what they say.
   *
   * Optional, and `unknown[]` rather than a card type, for two separate
   * reasons. It is UNKNOWN because these are jsonb that crossed a process
   * boundary and `@/lib/pdf/legal-basis` is the module that narrows them. It is
   * OPTIONAL because a run need not have produced any — `JobReportResponse`
   * (`frontends/aiq_api/src/aiq_api/routes/jobs.py`) now returns `cards`
   * alongside the report, but returns it null when the run generated none, and
   * a scheduled or replayed run may pass none at all. A section that cannot be
   * built prints nothing rather than an empty heading, so absent is a
   * first-class value here, not a gap waiting to be filled.
   */
  cards?: unknown[]
  request?: Request
}

/**
 * The report's own heading, and the body without it.
 *
 * The writer agent opens `/shared/output.md` with an H1 that names the thing it
 * researched, which is a better document title than anything this module could
 * derive — and leaving it in the body as well would print the same line twice,
 * once as the document's H1 and once as the first paragraph under it.
 *
 * When there is no leading heading the body is returned untouched and the
 * caller falls back to the export's own generic title. A title guessed from the
 * first sentence would be the export stating something the run never did.
 */
export function splitReportTitle(report: string): { title: string | null; body: string } {
  const match = /^[\s]*#\s+(.+?)\s*(?:\n|$)/.exec(report)
  if (!match) return { title: null, body: report }
  return { title: match[1].trim(), body: report.slice(match[0].length) }
}

/**
 * The facts the cover block prints, and why each one is on it.
 *
 * A report that reaches a Behörde with no project, no place and no date is an
 * anonymous essay, and roadmap #3 asks for "a deliverable an architect can hand
 * to the authority". The opposite failure is just as real: a cover sheet that
 * reprints the intake is a second document standing in front of the first. So
 * the rule applied here is that a row earns its place only if the reader cannot
 * READ THE REPORT without it — either because it identifies the object, or
 * because it decides which rules the report's claims were checked against.
 *
 * On the sheet:
 *
 *   - **Projekt** — the object, as the app names it. The one fact a reader
 *     away from the app cannot recover; the .docx has carried it since the
 *     saved-answer export shipped.
 *   - **Standort** (`site_address`, intake A2_adr) — the object, as a
 *     Behörde names it. A project name is an internal label; an Einreichung is
 *     about an address, and two projects in one office may share a name.
 *   - **Bundesland** (`federal_state`, intake A2_land) — the jurisdiction. Each
 *     Bundesland declares its own edition of the OIB-Richtlinien verbindlich
 *     and has its own Bauordnung (`skills/builtin/oib/fire-safety/SKILL.md`
 *     says the edition binds), so a compliance statement without it is not
 *     checkable — the reader cannot tell which law it was checked against.
 *   - **Gebäudeklasse** — the classification nearly everything hangs off.
 *     `lib/oib/applicable-standards.ts` derives which Richtlinien apply from
 *     it, and the brandschutz skill opens with "nearly every requirement in
 *     OIB Richtlinie 2 hangs off the Gebäudeklasse". A fire-resistance class
 *     printed without it is "a number with no claim attached to it".
 *   - **Erstellt am** — when. Already carried by the .docx.
 *   - **Erstellt von** — {@link AI_GENERATOR_NAME}, the same name the file's
 *     `Creator` field carries. The honest answer to the authorship question,
 *     and it makes the printed page and the metadata agree. The commissioning
 *     human is deliberately NOT named: on a document nobody has reviewed, a
 *     person's name in this row reads as a Verfasser claim, which is exactly
 *     what „nicht geprüft" says is not true yet.
 *   - **Analyse-ID** — the run, monospace. The only string that ties this page
 *     back to the run, to the `document.generated` audit event and to the
 *     `AIRunId` keyword in the file's own metadata. „Prüfen Sie jede Angabe"
 *     needs an address to check against.
 *
 * Deliberately NOT on it, and each for a reason:
 *
 *   - **Nutzung** (`main_use`). It belongs by every other measure — it is
 *     the second axis `applicable-standards.ts` reads. It is left off because
 *     its stored values are wire tokens (`wohnen`, `produzierend`) and this
 *     repo has no label set for them: `NUTZUNGEN` in `intake-definition.ts` is
 *     a DIFFERENT, unexported vocabulary (`produktion`, `handel`, `gastro`),
 *     so printing the fact would mean inventing a third list of German words
 *     with nothing to keep it in step with the first two. „produzierend" on a
 *     Behörde document is machine vocabulary leaking into a Bauakt, which
 *     `brief-view.ts` warns about by name. Add the row when the vocabulary has
 *     one home; do not add it by writing a second one here.
 *   - **Projektphase, Katastralgemeinde, Geschosse, Fluchtniveau, Widmung** —
 *     the rest of the brief. A cover identifies; it does not summarise. The
 *     brief is a page in the app and a section of no document.
 *   - **The organization's name or mark, as a FACT ROW.** This is a report, not
 *     a letterhead. The office is named once, in the branding header line above
 *     the facts (`./branding`, „Erstellt mit Piloti für …") — which is chrome
 *     saying who this was made for, not a claim the report makes about its
 *     subject. A fact row would put the office beside Standort and Bundesland,
 *     where every other line is something the report was checked against.
 */
const COVER_FACT_PLACEHOLDER = '—'

/**
 * A confirmed fact from the project brief, as the app itself words it.
 *
 * Read through `buildProjectBriefView` rather than off `profile.facts`
 * directly, so the cover sheet and the Overview's Project Brief cannot disagree
 * about what „wien" is called: that builder resolves option labels out of the
 * intake definition („Wien", „Außerhalb Österreichs"), and a second resolution
 * here would be a second answer to the same question.
 *
 * The em dash is what the builder prints for a fact whose value is null. It is
 * meaningful in a fact sheet the reader can see is complete, and misleading on
 * a cover sheet, where it would look like the report deliberately declined to
 * state a jurisdiction — so it is filtered rather than printed.
 */
function briefFact(
  facts: ReadonlyMap<string, string>,
  key: string
): string | undefined {
  const value = facts.get(key)?.trim()
  if (!value || value === COVER_FACT_PLACEHOLDER) return undefined
  return value
}

/**
 * The cover block's rows.
 *
 * `answer-document.ts`'s rule holds unchanged and is the reason every row below
 * is its own `if`: **a field that has no value produces no line.** A report
 * filed from a project with no Bundesland must not print „Bundesland" with
 * nothing after it, because a reader away from the app cannot tell that apart
 * from a claim that there is none.
 */
function coverRows(
  projectName: string | undefined,
  profile: unknown,
  createdAt: Date,
  runId: string,
  t: Translator,
  locale: Locale
): DocumentFact[] {
  const rows: DocumentFact[] = []
  if (projectName?.trim()) rows.push({ label: t('project'), value: projectName.trim() })

  const brief = buildProjectBriefView(profile ?? {})
  const facts = new Map(
    brief.groups.flatMap((group) => group.facts.map((fact) => [fact.key, fact.value] as const))
  )

  const location = briefFact(facts, 'site_address')
  if (location) rows.push({ label: t('reportCover.location'), value: location })

  const federalState = briefFact(facts, 'federal_state')
  if (federalState) rows.push({ label: t('reportCover.bundesland'), value: federalState })

  // `fields.gebaeudeklasse` and not a new key: the .docx already labels this
  // exact fact on a card, and two names for the Gebäudeklasse across the two
  // documents an architect puts side by side is the drift `answerExport` exists
  // to prevent.
  const buildingClass = briefFact(facts, 'building_class')
  if (buildingClass) rows.push({ label: t('fields.gebaeudeklasse'), value: buildingClass })

  rows.push({
    label: t('createdAt'),
    value: new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(createdAt),
  })
  rows.push({ label: t('reportCover.author'), value: AI_GENERATOR_NAME })
  // `mono` because a run id is transcribed, not read — see `PdfFactRow.mono`
  // and the design language's "monospace for identifiers".
  rows.push({ label: t('reportCover.analysisId'), value: runId, mono: true })

  return rows
}

/**
 * The project's brief, or nothing.
 *
 * A SECOND read of the row `fileGeneratedDocument` already loaded, and that is
 * deliberate: `GeneratedRenderContext` carries the project's name because the
 * service needed the name anyway, and widening it to hand every future producer
 * a whole profile is the service's decision to make, not this producer's.
 *
 * Failure is swallowed, which nothing else in this file does. The cover block
 * is ADDED MATTER: a database blip while reading a Gebäudeklasse must not cost
 * the user the filing of a report a multi-minute run just produced. The report
 * still files, with a cover that states what it could confirm.
 */
async function loadProfile(projectId: string, organizationId: string): Promise<unknown> {
  try {
    const project = await findProjectInOrg(projectId, organizationId)
    return project?.profile ?? null
  } catch (error) {
    console.error('[documents] could not read the project profile for a report cover', {
      projectId,
      cause: error instanceof Error ? error.name : 'unknown',
    })
    return null
  }
}

/**
 * Render a finished run's report and file it into the project.
 *
 * Both provenance options are set HERE, and they are independent by design: the
 * printed *"KI-generiert — nicht geprüft"* block on page one (`notice`) is what
 * a person reads, and the document metadata (`marking`) is what a records
 * system detects without OCR. A caller that sets one and not the other ships a
 * document that is marked for exactly one of its two audiences.
 *
 * Only ONE of the two is still this caller's to forget. `fileGeneratedDocument`
 * requires the machine-readable half back as `GeneratedRendering.marking` and
 * checks it against the produced bytes, so a rendering that lost it does not
 * file at all. The printed block is not checkable from outside the PDF — the
 * words are inside a compressed, glyph-encoded content stream — so it stays a
 * decision this producer makes and `markdown-pdf.spec.ts` reads back with
 * pdf.js. That asymmetry is honest rather than tidy: the half that can be
 * enforced is enforced, and the half that cannot is tested where a parser can
 * see it.
 *
 * The notice's words come from `answerExport.aiNotice.*` — the SAME keys the
 * .docx export reads. There is one German sentence saying this and one English
 * one, and a format that spelled out its own copy would be a second sentence
 * with the same job, drifting from the first with nothing to catch it.
 */
export async function fileResearchReport(
  input: FileResearchReportInput,
): Promise<FiledGeneratedDocument> {
  const filed = await renderAndFileReport(input)
  await openReviewRound(input, filed)
  return filed
}

/**
 * The report's review round: version 1 as a `draft`, submitted to the person
 * who commissioned it.
 *
 * ## Why a report goes through the same door as a chat draft
 *
 * Before ADR-0054 a filed report had no editorial state at all: it appeared in
 * Berichte looking exactly like a document somebody had checked, and the only
 * thing saying otherwise was the „KI-generiert — nicht geprüft" block printed
 * inside the PDF. „Piloti hat für Sie recherchiert" and „das Büro steht dahinter"
 * are different sentences, and until now the Files pane could only say the
 * second one.
 *
 * So the report is a `draft` and its arrival is a request for somebody to look
 * at it. One vocabulary for humans and for Piloti was the whole point of the
 * decision (ADR-0054, option 4 overturned): a reviewer should not have to know
 * who produced a file to know what state it is in.
 *
 * ## What stays exactly as it was
 *
 * The producer (`deep_research`), the PDF renderer, the cover sheet, the
 * marking, the `Berichte` folder and the idempotency key. This adds a version
 * row and a submit; it changes nothing about the bytes. A publish would index
 * the report — and `deep_research` is outside the `piloti/` namespace, so
 * `ingestPublished` refuses it and says so, which is the honest behaviour for a
 * producer whose output was never meant to be a Fundstelle.
 *
 * ## Best effort, and why
 *
 * A report that filed but could not open its review round is still a report in
 * the project — the run took minutes and its artifact is the thing the user
 * waited for. Failing the whole filing to report a submit problem would trade
 * the artifact for the notification. An already-filed reference (the report GET
 * being opened twice) finds its version already there and does nothing.
 */
async function openReviewRound(
  input: FileResearchReportInput,
  filed: FiledGeneratedDocument,
): Promise<void> {
  const { session, request } = input
  try {
    const existing = await findOpenVersion(filed.documentId, session.organizationId)
    if (existing) return

    const document = await findDocumentInOrg(filed.documentId, session.organizationId, internalRead('just-written'))
    if (!document) return

    const version = await createDocumentVersion(session, {
      document,
      op: 'create',
      storageKey: document.storageKey,
      storageBucket: document.storageBucket,
      contentType: document.contentType,
      fileSize: document.fileSize,
      contentHash: document.contentHash ?? contentDigest(new TextEncoder().encode(input.report)),
      request,
    })

    // To the person who commissioned it. `emitInboxItems` drops a row whose
    // recipient is its own actor, so a report somebody asked for interactively
    // opens no inbox item at THEM — they are looking at it — while a scheduled
    // run, submitted in the pinned requester's session, does. Either way the
    // Files pane shows „in Prüfung", which is the state that had no way to be
    // true before.
    await transitionDocumentVersion(session, filed.documentId, version.id, 'submit', {
      reviewerUserIds: [session.userId],
      request,
      // The RUN made this gesture, in the commissioning human's session
      // (migration 0085). Without saying so, `submitted_by` reads as that
      // person having asserted the report themselves — and the
      // not-the-submitter guard then refused the one person who asked for it
      // the right to release it.
      actingHuman: false,
    })
  } catch (error) {
    console.error('[documents] a filed report could not open its review round', {
      documentId: filed.documentId,
      cause: error instanceof Error ? error.name : 'unknown',
    })
  }
}

/** Render the PDF and file the item. The half that was here before. */
async function renderAndFileReport(
  input: FileResearchReportInput,
): Promise<FiledGeneratedDocument> {
  const { session, projectId, runId, report, cards, request } = input
  const { title, body } = splitReportTitle(report)
  const [t, locale, organizationName] = await Promise.all([
    getTranslations('answerExport'),
    getLocale(),
    getOrganizationDisplayName(session.organizationId),
  ])
  const documentTitle = title ?? t('documentTitle')
  // The words on the cover's header line, prose block and page footer. Resolved
  // ONCE, before the render, and from one module — see `./branding`. It fails
  // soft to the platform's own copy, which is true of every deployment, so a
  // settings read that cannot be made never costs the filing of a report a
  // twelve-minute run just produced.
  const branding = await resolveDocumentBranding({
    organizationId: session.organizationId,
    organizationName,
    locale,
  })

  return fileGeneratedDocument({
    session,
    projectId,
    producer: 'deep_research',
    // The backend async job id. `deep_research` is declared in
    // `GENERATED_DOCUMENT_PRODUCER_REF_KINDS` as filing under `agent_run`, so
    // the row and the audit target say so without this caller asserting it.
    ref: runId,
    title: documentTitle,
    request,
    render: async ({ projectName, marking }) => {
      const profile = await loadProfile(projectId, session.organizationId)
      // `renderMarkdownPdf` refuses a body over `MAX_MARKDOWN_PDF_CHARS` and
      // this call does NOT catch that, deliberately. Three things follow, and
      // they are the whole of what happens when a report is too long:
      //
      //   1. Nothing is filed and nothing is left behind. `fileGeneratedDocument`
      //      calls `render` before it creates the folder, PUTs the object or
      //      inserts the row, so a throwing renderer leaves no half-filed
      //      document — the ordering its own comment calls out.
      //   2. The user still gets the report. It is a chat answer first and a
      //      document second; filing is the second thing that happens to it,
      //      and `fileCommissionedReport` swallows this failure exactly as it
      //      swallows a quota refusal, so the answer they waited minutes for is
      //      never at risk from the filing.
      //   3. The reader is TOLD. This lands in the `outcome: 'failed'` arm of
      //      `fileCommissionedReport`, so the report response carries
      //      `filingFailed: true` — the promise the starting banner made
      //      („wird abgelegt") was made and broken, and that is the one case
      //      that key exists for. A key nobody reads is the same as no key
      //      at all, and that is what this one is again: `deep-research-client.ts`
      //      (`getJobReport`) carries it across the boundary, but its reader,
      //      the research side panel's success banner, was retired with that
      //      panel and the run block does not read it yet. No reason travels with
      //      it, deliberately: a quota refusal, a revoked permission and a
      //      report too long to render are one fact to an architect — the
      //      document is not there. The length and the limit are on the error,
      //      and the error is in the log the operator reads.
      //
      // Not pre-checked here even though the length is known before the
      // permission read and the two lookups it would save. The bound is the
      // renderer's invariant, and a caller that re-states it is a caller that
      // can re-state it wrongly — which is precisely how this path came to have
      // no bound while `POST /api/generate-pdf` had one.
      const bytes = await renderMarkdownPdf(body, {
        title: documentTitle,
        // The writer agent is not taught mermaid, but a skill scope does not
        // stop a model from writing a fence — and when it does, the thread
        // draws a picture while this document would otherwise print
        // `flowchart TD` in a grey box. Same dictionary, same locale as every
        // other word on the page.
        diagramPlaceholder: t('diagramPlaceholder'),
        // The cover carries the WHOLE fact list, so `projectName` and
        // `createdAt` are deliberately not passed: `reportSections` would derive
        // its own project and date rows from them and this list already has
        // both, in the order a Deckblatt reads — Projekt, Standort, Bundesland,
        // Gebäudeklasse, dann Datum. Bundesland is the one that makes the sheet
        // checkable: it names the Bauordnung the report was checked against.
        facts: coverRows(
          projectName,
          profile,
          // The instant the report is filed. Unlike a saved answer — which has
          // its own older `createdAt` and must not be re-dated by a download —
          // this document comes into existence now, and the run that produced
          // it finished moments ago.
          new Date(),
          runId,
          t,
          locale
        ),
        // The run's cards become the document's findings section, which is
        // where „Rechtsgrundlagen" now comes from. This used to be a
        // PDF-specific `legalBasisSection`; `lib/answer-export/cards.ts` already
        // renders every card type for the Word export, `legal_basis` included,
        // so the two documents an architect puts side by side are built from
        // one walker rather than two that can disagree.
        cards,
        locale,
        // Handed down by the seam and handed straight back below, so the
        // marking in the file's `Keywords` and the marking
        // `fileGeneratedDocument` verifies are the same string by construction.
        // This producer used to build its own from `{ runId }`, which was right
        // twice and is now right once — for the reason the seam gives: it is
        // the one place that knows whether a reference IS a run.
        marking,
        // The header line, the cover prose and the footer line. `branding` is a
        // superset of the renderer's `DocumentChrome`, so the words stay owned
        // by `./branding` and the PDF module never imports the copy.
        branding,
      })
      return { bytes, contentType: PDF_MEDIA_TYPE, marking }
    },
  })
}

/**
 * The report this run already filed into this project, if it did.
 *
 * The cheap half of "has this been filed": one probe on the same key
 * `fileGeneratedDocument` uses, so a reader who opens a report that is already
 * filed learns that without a job and without a render.
 */
export async function findFiledResearchReport(input: {
  organizationId: string
  projectId: string
  runId: string
}): Promise<FiledGeneratedDocument | null> {
  const existing = await findDocumentAuthoredByRef(
    input.runId,
    input.organizationId,
    input.projectId,
    'deep_research'
  )
  if (!existing) return null
  return { documentId: existing.id, filename: existing.filename, folderId: existing.folderId, alreadyFiled: true }
}

/**
 * Why this session may not file a report into this project today, or `null` when
 * it may.
 *
 * Asked by a reader's request BEFORE it queues a filing, because a refusal found
 * only by the job is invisible: the job has no row to record it on (a reader's
 * request names none) and ends cleanly, and the next read, finding nothing
 * filed, queues the same job again, for ever, telling the reader each time that
 * the report is being filed. Asking first makes the refusal the answer the
 * reader gets. The authorization ladder answers a missing permission as 404 and
 * a switched-off feature as 403, and both mean "not as this person, not today";
 * anything else is a fault and is thrown.
 */
export async function findReportFilingRefusal(
  session: AuthorizedSession,
  projectId: string,
): Promise<string | null> {
  try {
    await assertMayFileGeneratedDocument(session, projectId)
    return null
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      return `${error.name}: ${error.message}`.slice(0, 500)
    }
    throw error
  }
}

/**
 * Hand a finished run's report to the `bff-jobs` pool to be rendered and filed
 * ({@link fileResearchReport} runs there, ADR-0079).
 *
 * Both callers that used to render in their own request arrive here: the
 * worker's outcome callback (a scheduled run, or an interactive one nobody
 * reopened) and the report read of a person who opened it. Rendering a long
 * report is seconds of CPU on whichever pod took the request, and a failure
 * left nothing behind to retry; as a job it runs off the chat pod and is
 * retried by the queue.
 *
 * ONE job per run, whoever asks: the open one is returned. The filing is
 * idempotent on the run's id, so a second job could only repeat the first, and
 * which of the two callers' identity files it makes no difference to the
 * document (`createdBy` is the one visible trace; the first caller wins).
 *
 * `interactive` priority: the report is the answer to a run somebody waited
 * minutes for, one job of seconds, and it must not sit behind that office's own
 * reindex.
 */
export async function queueResearchReportFiling(input: {
  organizationId: string
  payload: FileResearchReportPayload
}): Promise<{ jobId: string }> {
  const open = await findOpenJobId({
    kind: 'file_research_report',
    organizationId: input.organizationId,
    matching: { runId: input.payload.runId },
  })
  if (open) return { jobId: open }
  return enqueueJob({
    kind: 'file_research_report',
    organizationId: input.organizationId,
    priority: BFF_JOB_PRIORITY.interactive,
    payload: input.payload,
  })
}

/**
 * What the client is told about the filing, alongside the report itself.
 *
 * Additive: every field the report response already had is untouched, so a
 * client that has never heard of filing keeps working. `documentId` is what the
 * toast's *Öffnen* and *Zuweisen* actions need; `alreadyFiled` distinguishes
 * "this run just produced a document" from "this is the fourth time the tab was
 * opened", which is the difference between showing that toast and not.
 */
interface ReportFilingResult {
  documentId: string
  filename: string
  alreadyFiled: boolean
}

/**
 * What happened to the filing, when something happened at all.
 *
 * ## Why a failure is reported and not just swallowed
 *
 * Filing stays best-effort — the answer is never the filing's to lose, and the
 * `catch` below still swallows the error. What changed is that swallowing it
 * SILENTLY is a broken promise: before the run starts, the banner prints
 * „Der fertige Bericht wird in diesem Projekt unter ‚Berichte' abgelegt."
 * (`deepResearch.starting.filingDisclosure`). A reader who was told that, and
 * is then shown a plain success, goes to Berichte and finds nothing — with
 * nothing anywhere to tell them why, because the only record is a server log
 * they cannot read.
 *
 * `null` used to mean four different things: not a report request, no project
 * to file into, no report yet, and "we tried and it did not work". The first
 * three are states in which no promise was made. Only the fourth is a promise
 * broken, and it is the only one worth a word to the reader.
 *
 * ## Why the reason does not travel
 *
 * A quota refusal, a revoked permission and an object store that is down are
 * one fact to this reader: the document is not there. The differences between
 * them are actionable by an administrator, not by the architect reading a
 * report, and the messages that carry them name buckets, permissions and
 * limits. Those belong in the log, which already has them. A boolean is the
 * whole of what the surface can honestly act on.
 *
 * ## Why `queued` exists (ADR-0079)
 *
 * The PDF is no longer rendered inside this request. A report that is not filed
 * yet is handed to a `file_research_report` job on the `bff-jobs` pool and the
 * answer says so (`filingQueued`): the promise is being kept, not broken, and
 * the document appears in Berichte when the job has run, retried by the queue
 * if it fails. A report that IS filed already answers `filed`, as it always
 * did, from one probe and no render.
 *
 * ## Why `refused` is its own end, and an answer of this request
 *
 * A reader who may not file here (no permission, the feature switched off) used
 * to get a job queued on every read: the job was refused, had no row to say so
 * on and ended cleanly, and the next read queued it again and answered
 * `filingQueued`, for ever. The permission is asked BEFORE queueing now
 * (`findReportFilingRefusal`), so a refusal is what the reader is told
 * (`filingFailed`, the promise broken) and nothing is queued; the reason is in
 * the log. It leaves the same body as `failed`: the reader cannot act on the
 * difference.
 */
export type ReportFilingOutcome =
  | { outcome: 'filed'; filed: ReportFilingResult }
  | { outcome: 'queued' }
  | { outcome: 'refused' }
  | { outcome: 'failed' }

/** The report endpoint's body, as `JobReportResponse` on the backend defines it. */
function readReportMarkdown(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const body = data as { has_report?: unknown; report?: unknown }
  if (body.has_report !== true) return null
  return typeof body.report === 'string' && body.report.trim() ? body.report : null
}

/**
 * The collection of the project this run was COMMISSIONED in, off the same body.
 *
 * The backend records it on `job_access` at submit time, from the request that
 * started the run, and returns it beside the report. It is the only statement
 * about the destination that the reader of the report cannot influence.
 */
function readCommissioningCollection(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const body = data as { project_collection?: unknown }
  return typeof body.project_collection === 'string' && body.project_collection
    ? body.project_collection
    : null
}

/**
 * The run's cards off the same body, for the filed PDF's „Rechtsgrundlagen".
 *
 * Only shape is checked, not card identity: the backend already validated these
 * at generation (`aiq_agent.cards.validate_cards`) and `legalBasisSection`
 * narrows them again at render, so a third opinion here could only reject a
 * card both of those accept. What it does do is refuse a non-array, so a
 * malformed body cannot reach `fileResearchReport` as something to iterate.
 *
 * Absent rather than empty when there is nothing: the section prints no heading
 * at all for an absent value, which is the state a report with no legal basis
 * should reach.
 */
function readReportCards(data: unknown): unknown[] | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const { cards } = data as { cards?: unknown }
  return Array.isArray(cards) && cards.length > 0 ? cards : undefined
}

/**
 * File a finished run's report into the project, if this is one.
 *
 * Called by the jobs proxy (`app/api/jobs/async/[...path]/route.ts`) when a
 * reader's GET of `job/{id}/report` returns; the route only matches the path
 * and turns the outcome into the response's additive keys (ADR-0017).
 *
 * ## Why the failure is swallowed
 *
 * The user asked a question and waited minutes for the answer. Filing is a
 * SECOND thing that happens to that answer, and no failure of it — a quota
 * refusal, a revoked permission, an object store that is down — is a reason to
 * throw the answer away. It is logged and surfaced on the response (`filed`
 * absent) rather than raised, which is the same posture every other best-effort
 * enrichment on this route already takes.
 *
 * ## Interactive runs here; scheduled runs at completion
 *
 * A scheduled run (`jobs.schedule_cron`) has no live session and never reaches
 * this handler. It is filed by the worker's outcome callback instead
 * (`/api/internal/jobs/[jobId]/outcome` → `completeTaskForRun`), as the
 * REQUESTER the task row pinned when the job was set up — the person's own
 * membership and permissions resolved at completion (ADR-0051, the design's
 * decision 10). Both paths key the document on the same backend job id, so a
 * report filed at 03:00 and opened here at 09:00 is one row (migration 0064).
 * The session check below stays the anonymous-mode guard, and the rule stays:
 * never a service token — the agent's principal is WIDER than the user's,
 * which is the hole this whole feature was shaped to avoid.
 */
export async function fileCommissionedReport({
  runId,
  session,
  body,
}: {
  /** The backend async job id whose report was read. */
  runId: string
  /** The reader's session; `null` in anonymous mode, which files nothing. */
  session: GridSession | null
  /** The backend's report response, as `JobReportResponse` defines it. */
  body: unknown
}): Promise<ReportFilingOutcome | null> {
  // The reader's project is deliberately NOT a parameter of this function. It
  // used to be, as a precondition — `|| !projectId` — which survived the change
  // that moved the destination onto the run and quietly kept the old coupling:
  // a run commissioned in a project, opened from a context that resolved no
  // project of its own, was never filed, and the response carried neither
  // `filed` nor `filingFailed`, so a reader who had been promised „wird
  // abgelegt" was told nothing at all. Taking the argument away is what stops
  // that being re-introduced by someone reading the precondition as a guard.
  if (!session?.organizationId) return null

  const report = readReportMarkdown(body)
  if (!report) return null

  // WHERE the report goes is a property of the RUN, never of the request that
  // reads it. `projectId` above is whatever the reader's request named, and
  // `buildCollectionScopeFromRequest` fills a missing one in from their stored
  // `active_project_id` — so a run started in a project-less chat (whose banner
  // therefore promised no filing at all) would be filed into whatever project
  // that reader last had open, and an old run reopened while a different
  // project is active would be filed there. Both file a report researched under
  // one Bauordnung carrying a cover sheet that names another one, marked
  // „KI-generiert" and shaped for an Einreichung.
  //
  // So the destination is DERIVED from the run's own `job_access` row and the
  // request's project is not consulted. A run with no commissioning project
  // files nothing: that is the honest reading of „no promise was made", not a
  // licence to pick one.
  const commissioned = readCommissioningCollection(body)
  if (!commissioned) return null
  const commissionedProjectId = await findProjectIdByCollectionName(commissioned, session.organizationId)
  // The collection is real but names no project THIS organization owns. Filing
  // anywhere on that basis would be the cross-tenant version of the bug above.
  if (!commissionedProjectId) return null

  try {
    const filed = await findFiledResearchReport({
      organizationId: session.organizationId,
      projectId: commissionedProjectId,
      runId,
    })
    if (filed) {
      return {
        outcome: 'filed',
        filed: { documentId: filed.documentId, filename: filed.filename, alreadyFiled: true },
      }
    }

    const refusal = await findReportFilingRefusal(session as AuthorizedSession, commissionedProjectId)
    if (refusal) {
      console.warn(`[Deep Research API] the reader may not file the report of run ${runId}: ${refusal}`)
      return { outcome: 'refused' }
    }

    // Narrowed the way every other proxy-layer call to a session-taking service
    // narrows it (`collection-scope-request.ts`): the organization is what makes
    // a session authorized, and it has just been checked. The reader is the
    // requester the job files as (identity and permissions, no access token),
    // exactly as this route used to file in the reader's own session.
    await queueResearchReportFiling({
      organizationId: session.organizationId,
      payload: {
        runId,
        projectId: commissionedProjectId,
        report,
        cards: readReportCards(body),
        taskRunId: null,
        requester: requesterOf(session as AuthorizedSession),
      },
    })
    return { outcome: 'queued' }
  } catch (error) {
    // Logged with the reason, reported without it. The log is where an operator
    // finds the bucket, the permission or the limit; the response carries only
    // what the reader can act on.
    console.error(`[Deep Research API] failed to queue the report's filing:`, error)
    return { outcome: 'failed' }
  }
}
