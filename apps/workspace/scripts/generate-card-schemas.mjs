/**
 * Generate the frontend Zod schema (`apps/workspace/shared/cards/generated.ts`) from the
 * canonical Grid card JSON Schema (`contracts/cards/schemas.json`).
 *
 * The JSON Schema is itself generated from the Pydantic models, making the
 * Pydantic models the single source of truth across backend and frontend.
 *
 * Run with: `npm run generate:cards`
 *
 * ## Why the `$ref` handling below exists
 *
 * `json-schema-to-zod` has no `$ref` resolution at all: a node carrying a
 * `$ref` matches none of its parsers, falls through to `parseDefault`, and
 * comes out as `z.any()`. Feeding it one `$def` at a time — without the
 * sibling `$defs` that def points into — therefore erased every nested
 * structure in the card models. Two costs, both paid in production:
 *
 *  - `z.any()` accepts anything INCLUDING `undefined`, so 14 card types could
 *    arrive missing a field `models.py` requires and still parse. The card
 *    then reached a renderer that read into it and threw DURING RENDER, and
 *    with no error boundary between the card and the route that unmounted the
 *    whole thread.
 *  - `z.any()` also erases the field's TYPE, so `tsc` could not see a renderer
 *    reading a property that does not exist.
 *
 * The fix resolves refs by NAME rather than by inlining: each `$def` is
 * emitted once as its own exported const, and a `$ref` to it becomes a
 * reference to that const, via the library's `parserOverride` hook. Shared
 * defs — `NormReference` is referenced from 32 places, `DimensionCheck` from
 * 14 — cost one declaration each instead of 32 and 14 inlined copies, which
 * matters because this file ships to the browser.
 *
 * A const must be declared before it is referenced, so the defs are emitted in
 * dependency order; see `topologicallyOrderedDefNames`.
 */

import { jsonSchemaToZod } from 'json-schema-to-zod'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Convert a `$def` name (e.g. `SummaryCard`) to its exported const name. */
export const exportName = (defName) => `${defName[0].toLowerCase()}${defName.slice(1)}Schema`

/** Resolve a local `$ref` like `#/$defs/SummaryCard` to its def name. */
export const refToDefName = (ref) => ref.split('/').pop()

/** Every `$def` name a schema node points at, at any depth. */
export function referencedDefNames(node, found = new Set()) {
  if (Array.isArray(node)) {
    for (const entry of node) referencedDefNames(entry, found)
  } else if (node && typeof node === 'object') {
    if (typeof node.$ref === 'string') found.add(refToDefName(node.$ref))
    for (const value of Object.values(node)) referencedDefNames(value, found)
  }
  return found
}

/**
 * `$def` names in dependency order: a def is emitted after everything it
 * references, because a `$ref` compiles to a reference to another `const` and
 * `const` declarations are not hoisted.
 *
 * A reference cycle has no such order. Zod's answer is `z.lazy()`, but a lazy
 * schema infers as `any` unless every member of the cycle carries a
 * hand-written type annotation — which would reintroduce, by hand, exactly the
 * `any` this generator exists to remove. The card models have no cycles, so a
 * cycle throws with its path rather than emitting a file that dies on import.
 */
export function topologicallyOrderedDefNames(root) {
  const defs = root.$defs ?? root.definitions ?? {}
  const dependencies = new Map(Object.keys(defs).map((name) => [name, referencedDefNames(defs[name])]))
  const ordered = []
  const state = new Map()

  const visit = (name, stack) => {
    if (state.get(name) === 'done') return
    if (state.get(name) === 'visiting') {
      throw new Error(
        `Cyclic $ref among card defs: ${[...stack, name].join(' -> ')}. A cycle cannot be ` +
          'emitted as plain consts; break it in the card models (`packages/agent/src/agent/cards/`), or teach this ' +
          'generator to emit `z.lazy()` with hand-written type annotations for the cycle members.'
      )
    }
    state.set(name, 'visiting')
    for (const dependency of dependencies.get(name) ?? []) {
      if (dependency in defs) visit(dependency, [...stack, name])
    }
    state.set(name, 'done')
    ordered.push(name)
  }

  // Deterministic output: walk the schema's own `oneOf` order first, then any
  // def it does not reach, in `$defs` order.
  for (const entry of root.oneOf ?? []) visit(refToDefName(entry.$ref), [])
  for (const name of Object.keys(defs)) visit(name, [])
  return ordered
}

/**
 * Emit a `$ref` as a reference to the const generated for its target.
 *
 * Returning a string short-circuits `parseSchema` entirely, so the ref site's
 * own `description` has to be re-attached here — the library appends describes
 * only on the path this return skips. `description` is the sole sibling
 * keyword the Pydantic-generated schema places next to a `$ref`; anything else
 * appearing there would be a constraint silently dropped, so it throws.
 */
export const refParserOverride = (node) => {
  if (!node || typeof node !== 'object' || typeof node.$ref !== 'string') return undefined
  const siblings = Object.keys(node).filter((key) => key !== '$ref' && key !== 'description')
  if (siblings.length > 0) {
    throw new Error(
      `$ref to ${node.$ref} carries unsupported sibling keyword(s) ${siblings.join(', ')}: they ` +
        'would be silently dropped. Extend `refParserOverride` to emit them.'
    )
  }
  const target = exportName(refToDefName(node.$ref))
  return node.description ? `${target}.describe(${JSON.stringify(node.description)})` : target
}

/**
 * Emit a tagged union of defs — Pydantic's `Annotated[A | B, Field(discriminator=…)]`,
 * which it writes as `oneOf` of `$ref`s beside a `discriminator` — as
 * `z.discriminatedUnion`.
 *
 * Left to the library, such a node becomes `z.any().superRefine(…)`, which
 * checks "exactly one branch matches" by hand and erases the field's type to
 * `any`; `z.discriminatedUnion` picks the branch by its tag and keeps the type.
 * Only the shape Pydantic emits is taken (every branch a `$ref`); anything else
 * returns undefined and goes to the library as before.
 */
export const discriminatedOneOfOverride = (node) => {
  if (!node || typeof node !== 'object' || !Array.isArray(node.oneOf)) return undefined
  const property = node.discriminator?.propertyName
  if (typeof property !== 'string' || !node.oneOf.every((entry) => typeof entry?.$ref === 'string')) return undefined
  const members = node.oneOf.map((entry) => exportName(refToDefName(entry.$ref))).join(', ')
  const union = `z.discriminatedUnion(${JSON.stringify(property)}, [${members}])`
  return node.description ? `${union}.describe(${JSON.stringify(node.description)})` : union
}

/** Append the `description` and `default` a node carries, as the library would on its own path. */
const withDescribeAndDefault = (expression, node) => {
  const described = node.description ? `${expression}.describe(${JSON.stringify(node.description)})` : expression
  return 'default' in node ? `${described}.default(${JSON.stringify(node['default'])})` : described
}

/** Keywords that say nothing about a value's shape. */
const ANNOTATION_KEYWORDS = new Set(['title', 'description', 'default', 'examples'])

/**
 * Emit a value the Pydantic model types as `Any` as `z.unknown()`, never `z.any()`.
 *
 * Pydantic writes `Any` as a schema with no shape keyword at all, and
 * `dict[str, Any]` as an object whose `additionalProperties` is `true`; the
 * library turns both into `z.any()`. The wire carries the same JSON either
 * way, but `any` switches the type checker off for every reader of the field,
 * while `unknown` makes the reader narrow before it uses the value.
 */
export const unknownValueOverride = (node) => {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined
  if (Object.keys(node).every((key) => ANNOTATION_KEYWORDS.has(key))) {
    return withDescribeAndDefault('z.unknown()', node)
  }
  const onlyOpenObject =
    node.type === 'object' &&
    node.additionalProperties === true &&
    Object.keys(node).every((key) => key === 'type' || key === 'additionalProperties' || ANNOTATION_KEYWORDS.has(key))
  return onlyOpenObject ? withDescribeAndDefault('z.record(z.string(), z.unknown())', node) : undefined
}

/** Every override the generator applies, first match wins. */
export const cardParserOverride = (node, refs) =>
  refParserOverride(node, refs) ?? discriminatedOneOfOverride(node, refs) ?? unknownValueOverride(node, refs)

/** The whole `generated.ts` module, as text. Pure — no file system. */
export function buildCardSchemaModule(root) {
  const defs = root.$defs ?? root.definitions ?? {}

  const orderedDefNames = topologicallyOrderedDefNames(root)
  const declarations = orderedDefNames.map((defName) => {
    const zodExpr = jsonSchemaToZod(defs[defName], { module: false, zodVersion: 4, parserOverride: cardParserOverride })
    return `export const ${exportName(defName)} = ${zodExpr}`
  })

  // The discriminated union must contain ONLY the card members (the schema's
  // `oneOf`), never nested sub-structure defs (NormReference, DimensionCheck, …)
  // which have no `type` discriminator. Sub-structure schemas are still emitted
  // as standalone consts above; they just don't belong in the union.
  const cardDefNames = (root.oneOf ?? []).map((entry) => refToDefName(entry.$ref))
  const unionMembers = (cardDefNames.length ? cardDefNames : Object.keys(defs))
    .map((defName) => exportName(defName))
    .join(',\n  ')

  const anyAt = declarations.find((declaration) => declaration.includes('z.any()'))
  if (anyAt) {
    throw new Error(
      `The generator emitted z.any() in \`${anyAt.split(' =')[0]}\`: it erases the field's type for every ` +
        'reader. Teach `cardParserOverride` the schema shape that produced it.'
    )
  }

  // One type per def, so a renderer names the shape it reads instead of
  // declaring a copy of it. The INPUT type: a field with a default stays
  // optional, so the type takes both a parsed card and the operands a renderer
  // builds itself (`lib/formulas.ts`).
  const types = orderedDefNames.map(
    (defName) => `export type ${defName}Data = z.input<typeof ${exportName(defName)}>`
  )

  const discriminator = root.discriminator?.propertyName ?? 'type'
  const banner =
    '// AUTO-GENERATED from contracts/cards/schemas.json — do not edit; run `npm run generate:cards`'

  return `${banner}

import { z } from 'zod'

${declarations.join('\n\n')}

export const gridCardSchema = z.discriminatedUnion('${discriminator}', [
  ${unionMembers},
])

${types.join('\n')}
`
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
// scripts -> workspace -> apps -> repo root
export const schemaPath = resolve(scriptDir, '../../../contracts/cards/schemas.json')
export const outPath = resolve(scriptDir, '../shared/cards/generated.ts')

// Importing this module (the spec does) must not write the generated file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = JSON.parse(readFileSync(schemaPath, 'utf-8'))
  writeFileSync(outPath, buildCardSchemaModule(root), { encoding: 'utf-8' })
  console.log(`Wrote Grid card Zod schema to ${outPath}`)
}
