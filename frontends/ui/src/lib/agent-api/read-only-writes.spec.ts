/**
 * @vitest-environment node
 */
/**
 * Every operation that says `readOnly: true` while its method could write, with
 * the reason it really changes nothing (H2, ADR-0122).
 *
 * `readOnly` decides what Piloti runs without asking: a read runs as the
 * requester, a write becomes a proposal the person decides. An operation that
 * claims to read and writes (`project-experience-extract` patched the project
 * profile and drafted decisions) runs a write past the person. So a new one
 * needs a sentence here, written by someone who read the route's service; the
 * test fails until it has one, and fails when one listed here stops claiming.
 *
 * "Changes nothing" means no row, file, grant or credential: a paid model call
 * that only answers is still a read.
 */
import { describe, expect, it } from 'vitest'
import { AGENT_OPERATIONS } from './catalog'
import { annotationsOf } from './operation'

const READ_ONLY_WRITE_METHODS: Readonly<Record<string, string>> = {
  'bim-model-query': 'queryAccessibleModel answers a query over the stored model; the POST carries the query.',
  'citation-format': 'renderCitations formats the citations in the body; reads no stored data and stores none.',
  'passage-similar-search': 'findSimilarPassages searches the projects the person may read; stores nothing.',
  'document-search': 'searchProjectDocuments / searchOfficeShelfDocuments search one shelf; the POST carries the query.',
  'document-by-name-resolve': 'resolveProjectDocumentsByName / resolveOfficeShelfDocumentsByName look documents up by file name.',
  'document-name-match': 'probeProjectDocumentNames / probeOfficeShelfDocumentNames report which names already exist.',
  'platform-norm-verify': 'verifyNormPointer asks RIS whether a norm pointer resolves; the registry is not written.',
  'project-cleanup-propose': 'proposeCleanup returns a list of candidates (rules and a model call); deletes and stores nothing.',
  'project-consistency-check': 'checkProjectConsistency asks the model about the fields sent; the profile is not saved.',
  'document-revision-compare': 'compareRevisionVisually compares two Fassungen in the backend; stores no result.',
  'document-revision-candidates': 'probeProjectRevisionCandidates / probeOfficeShelfRevisionCandidates list earlier revisions by name.',
  'skill-review': 'reviewSkill asks the model to review a draft in the body; the skill is not saved.',
}

const claims = AGENT_OPERATIONS.filter((op) => op.method !== 'GET' && annotationsOf(op).readOnlyHint)

describe('a non-GET operation that claims to change nothing', () => {
  it('is listed with the reason its service writes nothing', () => {
    const unlisted = claims.map((op) => op.name).filter((name) => !(name in READ_ONLY_WRITE_METHODS))
    expect(
      unlisted,
      'Read the route’s service. If it writes anything (a row, a file, a grant, a credential), drop readOnly; ' +
        'otherwise add the operation here with one line saying why it writes nothing.'
    ).toEqual([])
  })

  it('is listed only while it still claims it', () => {
    const claimed = new Set(claims.map((op) => op.name))
    expect(Object.keys(READ_ONLY_WRITE_METHODS).filter((name) => !claimed.has(name))).toEqual([])
  })

  it('gives a reason of its own', () => {
    for (const [name, reason] of Object.entries(READ_ONLY_WRITE_METHODS)) {
      expect(reason.length, name).toBeGreaterThan(30)
    }
  })

  it('is never sensitive: a sensitive operation hands out or widens something, which is a write', () => {
    expect(AGENT_OPERATIONS.filter((op) => op.sensitivity && op.method !== 'GET' && annotationsOf(op).readOnlyHint).map((op) => op.name)).toEqual([])
  })
})

/**
 * A sensitive GET: it changes nothing, but shows what an attacker would want
 * to know, so it sits behind the same guards. Each with what it returns, and
 * why that is no secret.
 */
const SENSITIVE_READS: Readonly<Record<string, string>> = {
  'organization-llm-credential-list':
    'listOrgCredentials maps every row through toView: a masked keyHint (…abcd) and a sha256 fingerprint prefix, never the key.',
}

describe('a sensitive read', () => {
  it('is listed with the reason it returns no secret', () => {
    const reads = AGENT_OPERATIONS.filter((op) => op.sensitivity && annotationsOf(op).readOnlyHint).map((op) => op.name)
    expect(reads.sort()).toEqual(Object.keys(SENSITIVE_READS).sort())
  })
})

describe('the operations the audit corrected', () => {
  const find = (name: string) => AGENT_OPERATIONS.find((op) => op.name === name)

  it('project-experience-extract writes the profile and project memory, so Piloti proposes it', () => {
    expect(find('project-experience-extract')).toBeDefined()
    expect(annotationsOf(find('project-experience-extract')!).readOnlyHint).toBe(false)
  })

  it('the audit-portal links mint a credential: secret, not a read', () => {
    for (const name of ['platform-audit-portal-link', 'organization-audit-portal-link-create']) {
      expect(find(name), name).toMatchObject({ sensitivity: 'secret' })
      expect(annotationsOf(find(name)!).readOnlyHint, name).toBe(false)
    }
  })
})
