/**
 * One Anmerkung viewpoint as a BCF 3.0 `.bcfv` (`VisualizationInfo`), written
 * against buildingSMART's `visinfo.xsd` of release_3_0.
 *
 * ## Order is part of the format
 *
 * The 3.0 documentation says the elements "must appear in the order given in
 * the schemas", and the schema is a `sequence`: Components, then ONE camera,
 * then Lines, ClippingPlanes, Bitmaps. Inside Components: Selection,
 * Visibility, Coloring. A reader that validates, or reads positionally, rejects
 * a viewpoint written in any other order.
 *
 * ## What the stored view maps to
 *
 * Everything is already in IFC world coordinates, Z-up, metres (F1 stores it so
 * and the viewer converts at its edge), which is the BCF frame, so nothing is
 * converted here. `ViewToWorldScale` is the view's visible VERTICAL size in
 * metres (the 3.0 `visinfo.xsd` annotation), which is what the viewpoint
 * stores: F1 writes `2 * getOrthoSize()`, the full height, never the half.
 * `FieldOfView` is the entire vertical angle in degrees, as stored.
 *
 * Elements are named by `IfcGuid` only. The viewpoint holds nothing else, and
 * an `AuthoringToolId` we do not have would be invented.
 *
 * Not written: `Lines` and `Bitmaps` (a viewpoint has no markup), and the
 * viewpoint's `pin`: BCF 3.0 has no pin, and a Line of zero length is the one
 * place the spec lets a point live, which a reader would draw as a dot nobody
 * placed.
 */

import { text } from './bcf'
import type { ClippingPlane, Vec3, ViewpointCamera, ViewpointComponents } from '@/lib/annotations/viewpoint-types'

export interface Bcf3ViewpointContent {
  /** The viewpoint's id: its `Guid`, already lowercase. */
  id: string
  camera: ViewpointCamera
  clippingPlanes: readonly ClippingPlane[]
  components: ViewpointComponents
}

/** An `xs:double`: no `-0`, no exponent surprises for a finite number. */
const num = (value: number): string => (Object.is(value, -0) ? '0' : String(value))

const point = (tag: string, indent: string, v: Vec3): string[] => [
  `${indent}<${tag}>`,
  `${indent}  <X>${num(v.x)}</X>`,
  `${indent}  <Y>${num(v.y)}</Y>`,
  `${indent}  <Z>${num(v.z)}</Z>`,
  `${indent}</${tag}>`,
]

const component = (indent: string, globalId: string): string => `${indent}<Component IfcGuid="${text(globalId)}" />`

function cameraLines(camera: ViewpointCamera): string[] {
  const shared = [
    ...point('CameraViewPoint', '    ', camera.position),
    ...point('CameraDirection', '    ', camera.direction),
    ...point('CameraUpVector', '    ', camera.up),
  ]
  const aspect = `    <AspectRatio>${num(camera.aspectRatio)}</AspectRatio>`
  if (camera.type === 'orthographic') {
    return [
      '  <OrthogonalCamera>',
      ...shared,
      `    <ViewToWorldScale>${num(camera.viewToWorldScale)}</ViewToWorldScale>`,
      aspect,
      '  </OrthogonalCamera>',
    ]
  }
  return ['  <PerspectiveCamera>', ...shared, `    <FieldOfView>${num(camera.fieldOfView)}</FieldOfView>`, aspect, '  </PerspectiveCamera>']
}

function componentLines({ selection, visibility, coloring }: ViewpointComponents): string[] {
  const lines = ['  <Components>']
  if (selection.globalIds.length > 0) {
    lines.push('    <Selection>', ...selection.globalIds.map((id) => component('      ', id)), '    </Selection>')
  }
  // Written always, with its attribute: the schema's default for DefaultVisibility is `false`,
  // so leaving it out would hide the whole model from a reader that trusts the default.
  const open = `    <Visibility DefaultVisibility="${visibility.defaultVisibility ? 'true' : 'false'}"`
  if (visibility.exceptions.length > 0) {
    lines.push(
      `${open}>`,
      '      <Exceptions>',
      ...visibility.exceptions.map((id) => component('        ', id)),
      '      </Exceptions>',
      '    </Visibility>'
    )
  } else {
    lines.push(`${open} />`)
  }
  // A Color needs at least one Component: an empty group is not written.
  const colors = coloring.filter((entry) => entry.globalIds.length > 0)
  if (colors.length > 0) {
    lines.push('    <Coloring>')
    for (const entry of colors) {
      lines.push(
        `      <Color Color="${text(entry.color.toUpperCase())}">`,
        '        <Components>',
        ...entry.globalIds.map((id) => component('          ', id)),
        '        </Components>',
        '      </Color>'
      )
    }
    lines.push('    </Coloring>')
  }
  lines.push('  </Components>')
  return lines
}

function clippingLines(planes: readonly ClippingPlane[]): string[] {
  if (planes.length === 0) return []
  return [
    '  <ClippingPlanes>',
    ...planes.flatMap((plane) => [
      '    <ClippingPlane>',
      ...point('Location', '      ', plane.location),
      ...point('Direction', '      ', plane.direction),
      '    </ClippingPlane>',
    ]),
    '  </ClippingPlanes>',
  ]
}

/** The `.bcfv` file. */
export function bcf3ViewpointXml(viewpoint: Bcf3ViewpointContent): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<VisualizationInfo Guid="${viewpoint.id}">`,
    ...componentLines(viewpoint.components),
    ...cameraLines(viewpoint.camera),
    ...clippingLines(viewpoint.clippingPlanes),
    '</VisualizationInfo>',
    '',
  ].join('\n')
}
