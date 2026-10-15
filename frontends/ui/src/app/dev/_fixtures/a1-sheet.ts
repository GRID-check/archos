/**
 * An A1 plan sheet at 1:100, as real PDF bytes, for the drawing viewer's
 * previews.
 *
 * The viewer's hardest job is a phone on site: open the latest Fassung of a
 * Grundriss plotted on A1, zoom into a detail until its 2.5 mm lettering is
 * readable, and compare it with the previous Fassung. A Bescheid on A4 says
 * nothing about that — its fit is already legible, its canvas is small — so
 * this sheet is the one the zoom ceiling, the canvas budget and the detail
 * raster are judged against. It is deliberately heavy: an axis grid, walls,
 * openings, a hatched core, dimension chains and some two thousand lines of
 * hatching, the kind of vector load a real Einreichplan carries.
 *
 * Two Fassungen: `C` and `D`. D moves the wall between Top 2 and Top 3 by one
 * grid field and swings the stair door the other way, so a comparison has
 * something to find.
 *
 * Every string stays below U+0100 (see `sample-pdf.ts`): indices are offsets.
 */

import { assemblePdf, pdfString } from './sample-pdf'

/** A1 landscape in PDF points: 841 x 594 mm. */
export const A1_WIDTH = 2384
export const A1_HEIGHT = 1684

/** 2.5 mm, the lettering of a 1:100 Grundriss, in points. */
const LETTERING = 7.09
/** 3.5 mm, room names. */
const ROOM_NAME = 9.92
/** 5 mm, the plan title. */
const TITLE = 14.17

export type A1Revision = 'C' | 'D'

/** The sheet's content stream. Geometry in points, PDF's bottom-left origin. */
function sheetContent(revision: A1Revision): string {
  const ops: string[] = ['0 0 0 RG 0 0 0 rg']
  const line = (x1: number, y1: number, x2: number, y2: number, width: number) =>
    ops.push(`${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`)
  const rect = (x: number, y: number, w: number, h: number, width: number) =>
    ops.push(`${width} w ${x} ${y} ${w} ${h} re S`)
  const fill = (x: number, y: number, w: number, h: number) => ops.push(`${x} ${y} ${w} ${h} re f`)
  const text = (x: number, y: number, size: number, value: string, bold = false) =>
    ops.push(
      `BT /${bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${pdfString(value)}) Tj ET`
    )

  // Sheet frame and the 20 mm binding margin.
  rect(28, 28, A1_WIDTH - 56, A1_HEIGHT - 56, 1.2)
  rect(57, 28, A1_WIDTH - 85, A1_HEIGHT - 56, 0.35)

  // The building: 16 grid fields of 5.40 m at 1:100 (5.4 m = 153 pt).
  const field = 153
  const left = 200
  const bottom = 260
  const fields = 11
  const rows = 6
  const width = field * fields
  const height = field * rows

  // Axis grid, dash-dot, with the axis bubbles' letters at 2.5 mm.
  ops.push('[18 4 2 4] 0 d')
  for (let index = 0; index <= fields; index += 1) {
    const x = left + index * field
    line(x, bottom - 70, x, bottom + height + 70, 0.25)
  }
  for (let index = 0; index <= rows; index += 1) {
    const y = bottom + index * field
    line(left - 70, y, left + width + 70, y, 0.25)
  }
  ops.push('[] 0 d')
  for (let index = 0; index <= fields; index += 1) {
    const x = left + index * field
    text(x - 3, bottom + height + 82, LETTERING, String(index + 1))
    text(x - 3, bottom - 92, LETTERING, String(index + 1))
  }
  for (let index = 0; index <= rows; index += 1) {
    text(left - 96, bottom + index * field - 2.5, LETTERING, String.fromCharCode(65 + index))
  }

  // Outer walls, 30 cm at 1:100 = 8.5 pt, drawn as a double line.
  rect(left, bottom, width, height, 1.4)
  rect(left + 8.5, bottom + 8.5, width - 17, height - 17, 0.7)

  // The corridor and the dwelling partitions.
  const corridor = bottom + field * 3
  line(left, corridor, left + width, corridor, 1)
  line(left, corridor + 50, left + width, corridor + 50, 1)
  const partitions = revision === 'C' ? [2, 4, 7, 9] : [2, 5, 7, 9]
  for (const index of partitions) {
    const x = left + index * field
    line(x, bottom + 8.5, x, corridor, 0.9)
    line(x, corridor + 50, x, bottom + height - 8.5, 0.9)
  }

  // The stair and lift core, hatched at 45 degrees: the hatching is the load.
  const coreX = left + field * 5.25
  const coreY = corridor + 50
  const coreW = field * 1.5
  const coreH = field * 1.6
  rect(coreX, coreY, coreW, coreH, 1.1)
  for (let offset = -coreH; offset < coreW; offset += 3) {
    const x1 = Math.max(coreX, coreX + offset)
    const y1 = coreY + Math.max(0, -offset)
    const run = Math.min(coreX + coreW - x1, coreY + coreH - y1)
    if (run > 0) line(x1, y1, x1 + run, y1 + run, 0.12)
  }
  // Stair treads, and the door into the core; Fassung D swings it the other way.
  for (let step = 0; step < 18; step += 1)
    line(coreX + 10, coreY + 12 + step * 6.4, coreX + coreW / 2 - 6, coreY + 12 + step * 6.4, 0.25)
  const doorX = coreX + coreW / 2
  if (revision === 'C')
    ops.push(
      `0.3 w ${doorX} ${coreY} m ${doorX} ${coreY + 25} l ${doorX + 25} ${coreY} m ${doorX} ${coreY + 25} ${doorX + 25} ${coreY + 25} ${doorX + 25} ${coreY} c S`
    )
  else
    ops.push(
      `0.3 w ${doorX + 25} ${coreY} m ${doorX + 25} ${coreY + 25} l ${doorX} ${coreY} m ${doorX + 25} ${coreY + 25} ${doorX} ${coreY + 25} ${doorX} ${coreY} c S`
    )

  // Windows in the outer wall: three lines across it, every field.
  for (let index = 0; index < fields; index += 1) {
    const x = left + index * field + 40
    for (const y of [bottom, bottom + height - 8.5]) {
      for (let pane = 0; pane <= 2; pane += 1)
        line(x, y + pane * 4.25, x + 70, y + pane * 4.25, 0.3)
    }
  }

  // Floor finish hatching in the wet rooms: a fine grid per dwelling.
  for (let unit = 0; unit < 5; unit += 1) {
    const x0 = left + unit * field * 2 + 20
    const y0 = bottom + 20
    for (let tile = 0; tile <= 22; tile += 1) {
      line(x0 + tile * 4, y0, x0 + tile * 4, y0 + 88, 0.08)
      line(x0, y0 + tile * 4, x0 + 88, y0 + tile * 4, 0.08)
    }
  }

  // Rooms: name at 3.5 mm, area and finish at 2.5 mm.
  const rooms: Array<[number, number, string, string]> = [
    [0.4, 1.6, 'Top 1  Wohnen / Essen', '38,42 m²  ·  Parkett Eiche'],
    [
      2.4,
      1.6,
      'Top 2  Wohnen / Essen',
      revision === 'C' ? '34,91 m²  ·  Parkett Eiche' : '43,18 m²  ·  Parkett Eiche',
    ],
    [
      4.4,
      1.6,
      'Top 3  Zimmer',
      revision === 'C' ? '24,60 m²  ·  Parkett Eiche' : '16,33 m²  ·  Parkett Eiche',
    ],
    [7.4, 1.6, 'Top 4  Wohnen / Essen', '29,70 m²  ·  Parkett Eiche'],
    [9.4, 1.6, 'Top 5  Zimmer', '12,10 m²  ·  Parkett Eiche'],
    [0.4, 4.6, 'Top 6  Wohnen / Essen', '38,42 m²  ·  Parkett Eiche'],
    [2.4, 4.6, 'Top 7  Zimmer', '11,62 m²  ·  Parkett Eiche'],
    [7.4, 4.6, 'Top 8  Wohnen / Essen', '34,91 m²  ·  Parkett Eiche'],
    [9.4, 4.6, 'Top 9  Zimmer', '10,80 m²  ·  Parkett Eiche'],
  ]
  for (const [fx, fy, name, detail] of rooms) {
    const x = left + fx * field
    const y = bottom + fy * field
    text(x, y, ROOM_NAME, name, true)
    text(x, y - 11, LETTERING, detail)
    text(x, y - 21, LETTERING, 'RH 2,60 m  ·  FBOK +3,24')
  }
  text(left + field * 4.3, corridor + 20, ROOM_NAME, 'Laubengang', true)
  text(
    left + field * 4.3,
    corridor + 9,
    LETTERING,
    'Fluchtweg 34,0 m < 40,0 m  ·  OIB-RL 2, Pkt. 5.1.1'
  )
  text(
    coreX + 6,
    coreY + coreH + 8,
    LETTERING,
    'Sicherheitstreppenhaus  ·  REI 90  ·  Tür EI2 30-C'
  )

  // A dimension chain along the bottom: ticks and 2.5 mm figures.
  const chainY = bottom - 40
  line(left, chainY, left + width, chainY, 0.25)
  for (let index = 0; index <= fields; index += 1) {
    const x = left + index * field
    line(x - 4, chainY - 4, x + 4, chainY + 4, 0.5)
    if (index < fields) text(x + field / 2 - 9, chainY + 4, LETTERING, '5,40')
  }
  text(left + width / 2 - 18, chainY - 16, LETTERING, '59,40')

  // Title block, bottom right.
  const tbX = A1_WIDTH - 28 - 520
  const tbY = 28
  rect(tbX, tbY, 520, 210, 0.8)
  for (const y of [60, 92, 124, 156]) line(tbX, tbY + y, tbX + 520, tbY + y, 0.35)
  text(tbX + 12, tbY + 170, TITLE, 'Wohnbau Nord, Linz  ·  Grundriss 1. Obergeschoss', true)
  text(
    tbX + 12,
    tbY + 134,
    LETTERING,
    'Einreichplanung  ·  M 1:100  ·  Plangröße A1 (841 x 594 mm)'
  )
  text(
    tbX + 12,
    tbY + 102,
    LETTERING,
    `Index ${revision}  ·  ${revision === 'C' ? '14.09.2026' : '02.10.2026'}  ·  gez. MH  ·  gepr. AB`
  )
  text(
    tbX + 12,
    tbY + 70,
    LETTERING,
    revision === 'C'
      ? 'Änderung: Fluchtweg Laubengang ergänzt'
      : 'Änderung: Trennwand Top 2 / Top 3 verschoben, Tür Kern umgeschlagen'
  )
  text(tbX + 12, tbY + 38, LETTERING, 'Arch. DI Huber ZT GmbH  ·  Landstraße 12, 4020 Linz')
  fill(tbX + 440, tbY + 160, 64, 36)

  return ops.join('\n') + '\n'
}

/** One A1 sheet of the given Fassung, as PDF bytes. */
export function a1SheetPdf(revision: A1Revision = 'C'): Uint8Array<ArrayBuffer> {
  const content = sheetContent(revision)
  return assemblePdf([
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${A1_WIDTH} ${A1_HEIGHT}]/Resources<</Font<</F1 5 0 R/F2 6 0 R>>>>/Contents 4 0 R>>`,
    `<</Length ${content.length}>>\nstream\n${content}endstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold/Encoding/WinAnsiEncoding>>',
  ])
}
