/**
 * @vitest-environment node
 */
/**
 * What the reader takes from a BCF file's views and topics (`./bcf-read.ts`):
 * both cameras, clamped where they stray, visibility in every form XML Schema
 * allows, cuts to F1's bounds, pictures judged by bytes and declared size, the
 * 2.0 fixed names, both colouring layouts, and dates read as UTC when they
 * carry no offset.
 */

import { strToU8, zipSync, type Zippable } from 'fflate'
import { describe, expect, it } from 'vitest'
import { MAX_SNAPSHOT_BYTES, MAX_VISIBILITY_EXCEPTIONS } from '@/lib/annotations/viewpoint-types'
import { openBcfArchive } from './bcf-archive'
import { instant, readBcf, xsBoolean, type BcfTopicRead } from './bcf-read'

const WALL = '2O2Fr$t4X7Zf8NOew3FLOH'
const BEAM = '3pGKgn9xH4$PdVA0l_Bk8z'
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const FOLDER = '5b1a2c3d-0000-4000-8000-000000000001'

const markup = (viewpoints = '<Viewpoints Guid="v"><Viewpoint>v.bcfv</Viewpoint><Snapshot>v.png</Snapshot></Viewpoints>', extra = '') =>
  `<Markup><Topic Guid="${FOLDER}" TopicType="Issue" TopicStatus="Open"><Title>Sturz</Title>${extra}</Topic>${viewpoints}</Markup>`

const perspective = (inner = '<FieldOfView>60</FieldOfView>') => `<PerspectiveCamera>
  <CameraViewPoint><X>1</X><Y>2</Y><Z>3</Z></CameraViewPoint>
  <CameraDirection><X>0</X><Y>1</Y><Z>0</Z></CameraDirection>
  <CameraUpVector><X>0</X><Y>0</Y><Z>1</Z></CameraUpVector>${inner}</PerspectiveCamera>`

const view = (components: string, camera = perspective()) => `<VisualizationInfo><Components>${components}</Components>${camera}</VisualizationInfo>`

function topicOf(files: Zippable): BcfTopicRead {
  const read = readBcf(openBcfArchive(zipSync(files)))
  expect(read.topics).toHaveLength(1)
  return read.topics[0]
}

const withView = (bcfv: string, extra: Zippable = {}) =>
  topicOf({ [`${FOLDER}/markup.bcf`]: strToU8(markup()), [`${FOLDER}/v.bcfv`]: strToU8(bcfv), ...extra })

describe('cameras', () => {
  it('reads an orthographic camera with its view height', () => {
    const camera = `<OrthogonalCamera>
      <CameraViewPoint><X>10</X><Y>-5</Y><Z>20</Z></CameraViewPoint>
      <CameraDirection><X>0</X><Y>0</Y><Z>-1</Z></CameraDirection>
      <CameraUpVector><X>0</X><Y>1</Y><Z>0</Z></CameraUpVector>
      <ViewToWorldScale>12.5</ViewToWorldScale><AspectRatio>1.25</AspectRatio></OrthogonalCamera>`
    const topic = withView(view('', camera))
    expect(topic.view?.viewpoint.camera).toEqual({
      type: 'orthographic',
      position: { x: 10, y: -5, z: 20 },
      direction: { x: 0, y: 0, z: -1 },
      up: { x: 0, y: 1, z: 0 },
      viewToWorldScale: 12.5,
      aspectRatio: 1.25,
    })
    expect(topic.view?.cuts.camera).toBe(false)
  })

  it('clamps an aspect ratio or field of view past what a view stores, and says so, instead of dropping the view', () => {
    const wide = withView(view('', perspective('<FieldOfView>0.5</FieldOfView><AspectRatio>20</AspectRatio>')))
    expect(wide.view?.viewpoint.camera).toMatchObject({ fieldOfView: 1, aspectRatio: 10 })
    expect(wide.view?.cuts.camera).toBe(true)
    const flat = withView(view('', perspective('<FieldOfView>180</FieldOfView><AspectRatio>0.01</AspectRatio>')))
    expect(flat.view?.viewpoint.camera).toMatchObject({ fieldOfView: 179, aspectRatio: 0.1 })
  })

  it('has no view for a camera that looks nowhere', () => {
    const blind = perspective().replace('<CameraDirection><X>0</X><Y>1</Y>', '<CameraDirection><X>0</X><Y>0</Y>')
    expect(withView(view('', blind)).view).toBeNull()
  })
})

describe('visibility', () => {
  it.each([
    ['<Visibility DefaultVisibility="true" />', true],
    ['<Visibility DefaultVisibility="1" />', true],
    ['<Visibility DefaultVisibility="false" />', false],
    ['<Visibility DefaultVisibility="0" />', false],
    // The schema's default for the attribute is false.
    ['<Visibility />', false],
    // No element: nothing was hidden.
    ['', true],
  ])('reads %j as default visibility %s', (element, expected) => {
    expect(withView(view(element)).view?.viewpoint.components.visibility.defaultVisibility).toBe(expected)
  })

  it('shows the whole model when the exceptions are more than a view holds, and says so', () => {
    const ids = Array.from({ length: MAX_VISIBILITY_EXCEPTIONS + 1 }, (_, index) => `${String(index).padStart(4, '0')}${WALL.slice(4)}`)
    const element = `<Visibility DefaultVisibility="false"><Exceptions>${ids.map((id) => `<Component IfcGuid="${id}"/>`).join('')}</Exceptions></Visibility>`
    const topic = withView(view(element))
    expect(topic.view?.viewpoint.components.visibility).toEqual({ defaultVisibility: true, exceptions: [] })
    expect(topic.view?.cuts.visibility).toBe(true)
  })
})

describe('colouring', () => {
  it('reads 2.1 (Color/Component) and 3.0 (Color/Components/Component) alike, and drops an invalid colour', () => {
    const coloring = `<Coloring>
      <Color Color="FF0000"><Component IfcGuid="${WALL}"/></Color>
      <Color Color="80FF0000"><Components><Component IfcGuid="${BEAM}"/></Components></Color>
      <Color Color="red"><Component IfcGuid="${BEAM}"/></Color>
    </Coloring>`
    expect(withView(view(coloring)).view?.viewpoint.components.coloring).toEqual([
      { color: 'FF0000', globalIds: [WALL] },
      { color: '80FF0000', globalIds: [BEAM] },
    ])
  })
})

describe('snapshots', () => {
  it('takes a real PNG, whatever the file is called', () => {
    expect(withView(view(''), { [`${FOLDER}/v.png`]: PNG }).view?.snapshot).toEqual({ contentType: 'image/png', bytes: PNG })
  })

  it('says why a picture did not come along: not an image, missing, or declaring more than a snapshot holds', () => {
    expect(withView(view(''), { [`${FOLDER}/v.png`]: strToU8('GIF89a') }).view?.cuts.snapshot).toBe('not_an_image')
    expect(withView(view('')).view?.cuts.snapshot).toBe('missing')
    const big = new Uint8Array(MAX_SNAPSHOT_BYTES + 1)
    big.set(PNG)
    const topic = withView(view(''), { [`${FOLDER}/v.png`]: big })
    expect(topic.view?.cuts.snapshot).toBe('too_large')
    expect(topic.view?.snapshot).toBeNull()
  })

  it('falls back to 2.0’s fixed names when the markup lists no view, with or without its picture', () => {
    const files = { [`${FOLDER}/markup.bcf`]: strToU8(markup('')), [`${FOLDER}/viewpoint.bcfv`]: strToU8(view('')) }
    const bare = topicOf(files)
    expect(bare.view?.snapshot).toBeNull()
    expect(bare.view?.cuts.snapshot).toBeNull()
    expect(topicOf({ ...files, [`${FOLDER}/snapshot.png`]: PNG }).view?.snapshot?.contentType).toBe('image/png')
  })
})

describe('topics', () => {
  it('drops a Guid’s braces, and reads dates without an offset as UTC', () => {
    const topic = topicOf({
      [`${FOLDER}/markup.bcf`]: strToU8(
        markup('', '<CreationDate>2026-10-27T14:03:00</CreationDate>').replace(`Guid="${FOLDER}"`, `Guid="{${FOLDER.toUpperCase()}}"`)
      ),
    })
    expect(topic.guid).toBe(FOLDER.toUpperCase())
    expect(topic.creationDate?.toISOString()).toBe('2026-10-27T14:03:00.000Z')
  })
})

describe('instant and xsBoolean', () => {
  it('reads an offset as written and no offset as UTC, and nothing that is no dateTime', () => {
    expect(instant('2026-10-27T14:03:00+01:00')?.toISOString()).toBe('2026-10-27T13:03:00.000Z')
    expect(instant('2026-10-27T14:03:00')?.toISOString()).toBe('2026-10-27T14:03:00.000Z')
    expect(instant('yesterday')).toBeNull()
    expect(instant('2026-10-27')).toBeNull()
  })

  it('reads the four lexical forms and falls back on anything else', () => {
    expect([xsBoolean('true', false), xsBoolean('1', false), xsBoolean('false', true), xsBoolean('0', true)]).toEqual([true, true, false, false])
    expect([xsBoolean(undefined, true), xsBoolean('yes', false)]).toEqual([true, false])
  })
})
