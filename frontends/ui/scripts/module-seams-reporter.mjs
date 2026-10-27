// dependency-cruiser reporter for `task fe:lint`: its own `err` report, plus
// the one seam dependency-cruiser cannot express, a cycle between FEATURES.
//
// dependency-cruiser finds cycles between modules or between leaf folders, and
// keys each one by the path it happened to walk. A feature is a folder tree
// (`features/chat/components/…`, `features/chat/lib/…`), and a cycle path
// shifts whenever an unrelated edge inside a feature moves, so a baseline of
// those paths would break on edits that changed no seam. This collapses the
// graph to one node per feature and keys a cycle by its feature-to-feature
// edges, which only move when a seam does.
//
// The known edges live in `.dependency-cruiser-known-feature-cycles.json` and
// may only shrink: a new edge inside a cycle fails, and so does a listed edge
// that no longer closes one. `UPDATE_FEATURE_CYCLES=1` drops the stale entries
// and never adds one.
import fs from 'node:fs'
import path from 'node:path'

// dependency-cruiser calls a reporter plugin synchronously, and its public
// `format` is async, so the built-in `err` reporter is imported by path. The
// version is pinned exactly in package.json; if the path moves, this import
// fails loudly rather than passing.
const { default: errReporter } = await import(
  new URL('../node_modules/dependency-cruiser/src/report/error.mjs', import.meta.url).href
)

const KNOWN_FILE = path.join(import.meta.dirname, '..', '.dependency-cruiser-known-feature-cycles.json')
const FEATURE = /^src\/features\/([^/]+)\//

/** @param {import('dependency-cruiser').IModule[]} modules */
function featureEdges(modules) {
  /** @type {Map<string, Map<string, string>>} feature → (feature → one module edge as evidence) */
  const edges = new Map()
  for (const module of modules) {
    const from = FEATURE.exec(module.source)?.[1]
    if (!from) continue
    for (const dependency of module.dependencies) {
      const to = FEATURE.exec(dependency.resolved)?.[1]
      if (!to || to === from) continue
      if (!edges.has(from)) edges.set(from, new Map())
      const targets = /** @type {Map<string, string>} */ (edges.get(from))
      if (!targets.has(to)) targets.set(to, `${module.source} → ${dependency.resolved}`)
    }
  }
  return edges
}

/**
 * Tarjan's strongly connected components; a component of two or more
 * features is a cycle.
 * @param {Map<string, Map<string, string>>} edges
 */
function featureOfComponent(edges) {
  /** @type {Map<string, number>} */ const component = new Map()
  /** @type {Map<string, number>} */ const index = new Map()
  /** @type {Map<string, number>} */ const low = new Map()
  /** @type {string[]} */ const stack = []
  const onStack = new Set()
  let counter = 0
  let components = 0
  /** @param {string} node */
  const visit = (node) => {
    index.set(node, counter)
    low.set(node, counter++)
    stack.push(node)
    onStack.add(node)
    for (const next of edges.get(node)?.keys() ?? []) {
      if (!index.has(next)) {
        visit(next)
        low.set(node, Math.min(/** @type {number} */ (low.get(node)), /** @type {number} */ (low.get(next))))
      } else if (onStack.has(next)) {
        low.set(node, Math.min(/** @type {number} */ (low.get(node)), /** @type {number} */ (index.get(next))))
      }
    }
    if (low.get(node) !== index.get(node)) return
    let member
    do {
      member = /** @type {string} */ (stack.pop())
      onStack.delete(member)
      component.set(member, components)
    } while (member !== node)
    components++
  }
  for (const node of [...edges.keys()].sort()) if (!index.has(node)) visit(node)
  return component
}

/**
 * Every feature-to-feature edge that lies on a cycle, with one module edge
 * that makes it.
 * @param {import('dependency-cruiser').IModule[]} modules
 */
export function cycleEdges(modules) {
  const edges = featureEdges(modules)
  const component = featureOfComponent(edges)
  /** @type {Map<string, string>} "a → b" → evidence */
  const inCycle = new Map()
  for (const [from, targets] of edges) {
    for (const [to, evidence] of targets) {
      if (component.get(from) === component.get(to)) inCycle.set(`${from} → ${to}`, evidence)
    }
  }
  return inCycle
}

/** @returns {string[]} */
function readKnown() {
  try {
    return JSON.parse(fs.readFileSync(KNOWN_FILE, 'utf8'))
  } catch {
    return []
  }
}

/**
 * The cycle edges the baseline does not list, and the listed ones that no
 * longer close a cycle.
 * @param {import('dependency-cruiser').IModule[]} modules
 * @param {string[]} known
 */
export function featureCycleFindings(modules, known) {
  const current = cycleEdges(modules)
  const knownSet = new Set(known)
  return {
    current,
    added: [...current.keys()].filter((edge) => !knownSet.has(edge)).sort(),
    stale: known.filter((edge) => !current.has(edge)),
  }
}

/** @param {import('dependency-cruiser').ICruiseResult} result */
export default function moduleSeamsReporter(result) {
  const base = errReporter(result, result.summary.optionsUsed?.reporterOptions?.err ?? {})
  // dependency-cruiser validates a plugin by calling it on an empty graph.
  if (result.modules.length === 0) return base

  const known = readKnown()
  const { current, added, stale } = featureCycleFindings(result.modules, known)
  const updating = process.env.UPDATE_FEATURE_CYCLES === '1'

  if (updating && stale.length > 0) {
    fs.writeFileSync(KNOWN_FILE, `${JSON.stringify(known.filter((edge) => current.has(edge)), null, 2)}\n`)
  }
  const lines = []
  for (const edge of added) {
    lines.push(`  error feature-cycle: ${edge} closes a cycle between features (${current.get(edge)})`)
  }
  if (added.length > 0) {
    lines.push(
      '',
      `x ${added.length} new feature-to-feature cycle edge(s). Two features that import each other are one feature`,
      '  with two names: move the shared piece into lib/ or components/, or import through an index that breaks the loop.',
    )
  }
  if (stale.length > 0 && !updating) {
    lines.push(
      '',
      `x ${stale.length} entries in .dependency-cruiser-known-feature-cycles.json no longer close a cycle:`,
      ...stale.map((edge) => `    ${edge}`),
      '  Remove them with `bun run lint:seams:baseline`, so the fixed edge cannot come back.',
    )
  }
  const failed = added.length + (updating ? 0 : stale.length)
  return {
    output: `${base.output}${lines.length > 0 ? `${lines.join('\n')}\n` : ''}`,
    exitCode: base.exitCode + failed,
  }
}
