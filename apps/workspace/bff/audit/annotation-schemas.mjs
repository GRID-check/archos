/**
 * The audit registry's entries for Anmerkungen leaving and entering the
 * office's record: the Protokoll exports and the BCF import. Spread into
 * `AUDIT_SCHEMAS` (`./schemas.mjs`, whose header says how an entry is read);
 * a file of its own so the registry does not grow past its bound. Plain ESM,
 * for the same two consumers.
 */

export const ANNOTATION_AUDIT_SCHEMAS = /** @type {const} */ ({
  // A person exported a document's Anmerkungen as a Protokoll file
  // (`lib/annotations/export.ts`): office review content leaving the product.
  // What was asked for and how many marks it carried, never a name or a word
  // of the marks, so it needs no `filedIn`.
  'document.annotations.exported': {
    targets: [{ type: 'document' }],
    metadata: {
      format: 'string',
      scope: 'string',
      revision: 'string',
      includeProposals: 'boolean',
      markCount: 'number',
      proposalCount: 'number',
    },
  },
  // A person exported a project's Offene Punkte as one Protokoll across its
  // documents (`lib/annotations/project-export.ts`). The filters and the
  // counts, never a name or a word of the marks; `assignee` says only whether
  // the reader, one person or anyone was asked for (`me`, `person`, `any`).
  'project.annotations.exported': {
    targets: [{ type: 'project' }],
    metadata: {
      format: 'string',
      status: 'string',
      assignee: 'string',
      due: 'string',
      documentCount: 'number',
      markCount: 'number',
      proposalCount: 'number',
    },
  },
  // A person imported a BCF file onto a model (`lib/bim/bcf-import-service.ts`):
  // outside review content entering the office's record. The version, the
  // batch the marks share and the counts, never a name or a word of a topic.
  'document.annotations.imported': {
    targets: [{ type: 'document' }],
    metadata: {
      format: 'string',
      version: 'string',
      batchId: 'string',
      topicCount: 'number',
      importedCount: 'number',
      skippedCount: 'number',
      failedCount: 'number',
      assignedCount: 'number',
    },
  },
})
