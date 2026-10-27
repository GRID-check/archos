/**
 * `searchExport` namespace — the words inside the Planliste a search exports
 * (`lib/search/plan-list-export.ts`). The file leaves the product, so every
 * header and sheet name is written down here rather than in the builder.
 */
export const searchExport = {
  fileName: 'Plan list {date}',
  sheet: 'Plan list',
  columns: {
    planNumber: 'Drawing no.',
    planIndex: 'Revision',
    planDate: 'Plan date',
    scale: 'Scale',
    name: 'Name',
    title: 'Title',
    documentType: 'Document type',
    project: 'Project',
    folder: 'Folder',
    documentDate: 'Document date',
    uploadedAt: 'Uploaded',
    uploadedBy: 'Uploaded by',
    author: 'Author',
    pages: 'Pages',
    current: 'Current revision',
    status: 'Status',
  },
  yes: 'yes',
  no: 'no',
  officeShelf: 'Office shelf',
}
