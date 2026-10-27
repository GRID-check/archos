import type { en } from '../en'

/** Die Wörter der Planliste, die eine Suche exportiert (`lib/search/plan-list-export.ts`). */
export const searchExport: typeof en.searchExport = {
  fileName: 'Planliste {date}',
  sheet: 'Planliste',
  columns: {
    planNumber: 'Plannummer',
    planIndex: 'Index',
    planDate: 'Planstand',
    scale: 'Maßstab',
    name: 'Name',
    title: 'Titel',
    documentType: 'Dokumentart',
    project: 'Projekt',
    folder: 'Ordner',
    documentDate: 'Dokumentdatum',
    uploadedAt: 'Hochgeladen',
    uploadedBy: 'Hochgeladen von',
    pages: 'Seiten',
    current: 'Aktuelle Fassung',
    status: 'Status',
  },
  yes: 'ja',
  no: 'nein',
  officeShelf: 'Büroablage',
}
