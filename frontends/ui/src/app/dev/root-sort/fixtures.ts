/**
 * Fixture for the root-sort review: a three-level architecture folder tree and
 * about forty loose files at its root, with sure and unsure placements, two new
 * folder proposals and a few that stay. Plain data: the preview needs no network.
 */

import type {
  NewFolderProposal,
  RootSortDocument,
  RootSortFolder,
  RootSortPlacement,
} from '@/lib/filing/root-sort-types'

const FOLDERS: Array<[id: string, name: string, path: string, parentId: string | null]> = [
  ['f-entwurf', '01 Entwurf', '01 Entwurf', null],
  ['f-grundrisse', 'Grundrisse', '01 Entwurf/Grundrisse', 'f-entwurf'],
  ['f-schnitte', 'Schnitte', '01 Entwurf/Schnitte', 'f-entwurf'],
  ['f-genehmigung', '02 Genehmigung', '02 Genehmigung', null],
  ['f-fachplaner', '03 Fachplaner', '03 Fachplaner', null],
  ['f-brandschutz', 'Brandschutz', '03 Fachplaner/Brandschutz', 'f-fachplaner'],
  ['f-tragwerk', 'Tragwerk', '03 Fachplaner/Tragwerk', 'f-fachplaner'],
  ['f-ausschreibung', '04 Ausschreibung', '04 Ausschreibung', null],
]

export const fixtureFolders: RootSortFolder[] = FOLDERS.map(([id, name, path, parentId]) => ({
  id,
  name,
  path,
  parentId,
}))

/** [file name, folder id or null, confidence or null (unscored)], in the order the root lists them. */
const FILES: Array<
  [name: string, folderId: string | null, confidence: number | null, reason: string]
> = [
  ['EG_Grundriss_M1-100.pdf', 'f-grundrisse', 0.94, 'Grundriss im Maßstab 1:100, Erdgeschoss'],
  ['OG1_Grundriss_M1-100_Index-B.pdf', 'f-grundrisse', 0.91, 'Grundriss Obergeschoss, Fassung B'],
  ['OG2_Grundriss_M1-100.pdf', 'f-grundrisse', 0.88, 'Grundriss Obergeschoss 2'],
  ['UG_Grundriss_Tiefgarage.dwg', 'f-grundrisse', 0.42, 'Tiefgarage oder Keller? Titel fehlt'],
  ['Schnitt_A-A_M1-50.pdf', 'f-schnitte', 0.93, 'Schnitt A-A, Maßstab 1:50'],
  ['Schnitt_B-B.pdf', 'f-schnitte', 0.9, 'Schnitt B-B'],
  ['Wandaufbau_Detail_17.pdf', 'f-schnitte', 0.58, 'Wandaufbau, Detailschnitt'],
  ['Ansicht_Nord.pdf', 'f-schnitte', 0.37, 'Ansicht oder Schnitt?'],
  ['Baugenehmigung_Bescheid_2026-03.pdf', 'f-genehmigung', 0.97, 'Bescheid der Behörde'],
  ['Lageplan_Stand_2026-02.pdf', 'f-genehmigung', 0.86, 'Lageplan für den Bauantrag'],
  ['Bauantrag_Formular_BA1.pdf', 'f-genehmigung', 0.9, 'Bauantragsformular'],
  ['Nachbarzustimmung_Flurst_212.pdf', 'f-genehmigung', 0.62, 'Zustimmung des Nachbarn'],
  ['Brandschutzkonzept_v3.pdf', 'f-brandschutz', 0.95, 'Brandschutzkonzept'],
  ['Flucht_und_Rettungsplan_EG.pdf', 'f-brandschutz', 0.89, 'Flucht- und Rettungswege'],
  ['Brandschutz_Nachweis_Abschnitte.xlsx', 'f-brandschutz', 0.71, 'Nachweis der Brandabschnitte'],
  ['Statik_Bericht_Decke_EG.pdf', 'f-tragwerk', 0.92, 'Statischer Nachweis der Decke'],
  ['Bewehrungsplan_Bodenplatte.pdf', 'f-tragwerk', 0.84, 'Bewehrungsplan'],
  ['Tragwerk_Berechnung_Rev2.pdf', 'f-tragwerk', 0.46, 'Berechnung, Herkunft unklar'],
  ['LV_Rohbau_Position_01-12.xlsx', 'f-ausschreibung', 0.9, 'Leistungsverzeichnis Rohbau'],
  ['Ausschreibung_Fenster.pdf', 'f-ausschreibung', 0.87, 'Ausschreibung der Fenster'],
  ['Angebot_Elektro_Firma_Lichtwerk.pdf', 'f-ausschreibung', 0.52, 'Angebot, eventuell Vergabe'],
  ['Besprechung_Protokoll_2026-04-08.docx', null, null, ''],
  ['Notiz_Bauherr_Wünsche.txt', null, null, ''],
  ['Fotos_Baustelle_Mai.zip', null, null, ''],
  ['Rechnung_Vermessung_0412.pdf', null, null, ''],
  ['Terminplan_Rohbau_v4.pdf', null, null, ''],
  ['Mail_Export_Statik_Rückfrage.eml', null, null, ''],
  ['Bauschild_Entwurf.png', null, null, ''],
  ['Schallschutz_Gutachten_Auszug.pdf', null, null, ''],
  ['Einreichplan_Index-C_ungeklärt.pdf', null, null, ''],
  ['Kostenschätzung_KG300.xlsx', null, null, ''],
  ['Vermerk_Gespräch_Behörde.pdf', null, null, ''],
  ['Skizze_Dachaufbau.jpg', null, null, ''],
  ['Lieferschein_Ziegel_2026.pdf', null, null, ''],
  ['Projektbeschreibung_kurz.pdf', null, null, ''],
  ['Variante_Fassade_Holz.pdf', null, null, ''],
  ['Datenblatt_Wärmepumpe.pdf', null, null, ''],
  ['Ortsbegehung_Protokoll.pdf', null, null, ''],
]

export const fixtureDocuments: RootSortDocument[] = FILES.map(([name], index) => ({
  id: `doc-${String(index + 1).padStart(2, '0')}`,
  name,
}))

export const fixturePlacements: RootSortPlacement[] = FILES.flatMap(
  ([, folderId, confidence, reason], index) =>
    folderId
      ? [
          {
            documentId: `doc-${String(index + 1).padStart(2, '0')}`,
            folderId,
            newFolderPath: null,
            reason,
            confidence,
          },
        ]
      : []
)

/** Two new folders for leftovers no folder fits; one file is unsure, one is sure. */
export const fixtureNewFolders: NewFolderProposal[] = [
  {
    path: '01 Entwurf/Dachaufbau',
    description: 'Dachaufbau und Dachdetails',
    documentIds: ['doc-33'],
    confidences: { 'doc-33': 0.5 },
  },
  {
    path: '05 Bauherr',
    description: 'Wünsche und Notizen des Bauherrn',
    documentIds: ['doc-23'],
    confidences: { 'doc-23': 0.8 },
  },
]
