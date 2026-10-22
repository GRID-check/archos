/**
 * Layered `describe-operation` for a large input schema.
 *
 * A few operations take a body of thousands of characters (the largest is
 * `project-profile-replace`); describing one whole costs an agent most of a
 * screen to learn what it usually needs one corner of. Past
 * {@link LAYER_THRESHOLD_CHARS} the schema comes back as an outline: every field
 * that is small stays whole, every larger one shrinks to its type, description
 * and field names, with the `field` path to ask for it. `describe-operation`
 * with `field: "<path>"` returns that subtree, itself layered when it is still
 * large. A small schema is returned whole, as before.
 *
 * The threshold comes from measuring the catalog (326 operations): median 333
 * characters, p95 1,040, and only two operations past 3,000 (6,217 and 7,754).
 * 4,000 layers exactly those two and leaves every other operation untouched.
 */

type Node = Record<string, unknown>

export const LAYER_THRESHOLD_CHARS = 4_000
/** A field of a layered schema at most this long stays whole inside its outline. */
const INLINE_FIELD_CHARS = 800
/** Examples ride along in a layered schema only when they are this short. */
const INLINE_EXAMPLES_CHARS = 1_000

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function size(value: unknown): number {
  return JSON.stringify(value).length
}

/** The schema whose `properties` apply at `node`: itself, an array's items, or the one non-null branch of a union. */
function objectOf(node: Node): Node | null {
  if (isNode(node.properties)) return node
  if (isNode(node.items)) return objectOf(node.items)
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = node[key]
    if (!Array.isArray(branches)) continue
    const live = branches.filter((branch): branch is Node => isNode(branch) && branch.type !== 'null')
    if (live.length === 1) return objectOf(live[0] as Node)
  }
  return null
}

function fieldNames(node: Node): string[] {
  const target = objectOf(node)
  return target && isNode(target.properties) ? Object.keys(target.properties) : []
}

export type FieldResolution = { node: Node } | { error: string }

/** The subtree of `root` at the dot path `field`; an array's items are stepped through without naming them. */
export function resolveField(root: Node, field: string): FieldResolution {
  let current = root
  const walked: string[] = []
  for (const step of field.split('.')) {
    const target = objectOf(current)
    const properties = target && isNode(target.properties) ? target.properties : null
    const next = properties?.[step]
    if (!isNode(next)) {
      const where = walked.length > 0 ? ` under "${walked.join('.')}"` : ''
      const known = properties ? Object.keys(properties) : []
      return {
        error:
          `no field "${step}"${where} in this input. ` +
          (known.length > 0 ? `Fields there: ${known.join(', ')}.` : 'That part has no named fields to open.'),
      }
    }
    current = next
    walked.push(step)
  }
  return { node: current }
}

function outline(node: Node, path: string): Node {
  const names = fieldNames(node)
  const shape = node.type === 'array' ? 'array of objects' : undefined
  return {
    ...(node.type === undefined ? {} : { type: node.type }),
    ...(node.description === undefined ? {} : { description: node.description }),
    ...(shape && names.length > 0 ? { items: shape } : {}),
    ...(names.length > 0 ? { fields: names } : {}),
    ...(Array.isArray(node.required) && node.required.length > 0 ? { required: node.required } : {}),
    describe: `Large. Call describe-operation again with field: "${path}" for its full schema.`,
  }
}

export interface LayeredSchema {
  readonly schema: Node
  /** True when `schema` is an outline: some field was shortened. */
  readonly layered: boolean
}

/**
 * `node` whole when it is small; otherwise its top-level fields, each whole when
 * small and an outline when not. `prefix` is the dot path of `node` in the
 * operation's input, so each outline names the `field` that opens it.
 */
export function layerSchema(node: Node, prefix = ''): LayeredSchema {
  if (size(node) <= LAYER_THRESHOLD_CHARS) return { schema: node, layered: false }
  if (!isNode(node.properties) && isNode(node.items)) {
    const items = layerSchema(node.items, prefix)
    return { schema: { ...node, items: items.schema }, layered: items.layered }
  }
  const target = objectOf(node)
  if (!target || target !== node || !isNode(target.properties)) return { schema: node, layered: false }
  const properties = Object.fromEntries(
    Object.entries(target.properties).map(([name, value]) => {
      if (!isNode(value) || size(value) <= INLINE_FIELD_CHARS) return [name, value]
      return [name, outline(value, prefix ? `${prefix}.${name}` : name)]
    }),
  )
  const kept = (key: string) => (node[key] === undefined ? {} : { [key]: node[key] })
  return {
    schema: {
      ...kept('type'),
      ...kept('description'),
      properties,
      ...kept('required'),
      ...kept('additionalProperties'),
      ...(node.examples !== undefined && size(node.examples) <= INLINE_EXAMPLES_CHARS ? { examples: node.examples } : {}),
    },
    layered: true,
  }
}
