/**
 * One namespace of copy, in every locale.
 *
 * A caller names the namespace it translates by importing its module from
 * `@/i18n/namespaces/`, never by a string looked up in the whole dictionary.
 * That keeps its import graph down to the two files of that namespace: a spec
 * reaches `en/chat.ts` only if something it renders reads chat copy, so a copy
 * change re-runs the specs that show the copy, not every spec that translates
 * anything (docs/audit/blast-radius-2026-10.md §7.1). The aggregate in
 * `dictionaries/index.ts` is left for the checks that need every key at once.
 */

import type { Locale } from './config'
import { createTranslator, type Translator } from './translate'

/** A namespace's name, the key it sits under in the aggregate dictionary, and its copy per locale. */
export interface Namespace<Messages extends object = object> {
  readonly name: string
  readonly messages: Readonly<Record<Locale, Messages>>
}

/** Declare a namespace module's export. */
export function defineNamespace<const Name extends string, Messages extends object>(
  name: Name,
  messages: Record<Locale, Messages>,
): Namespace<Messages> & { readonly name: Name } {
  return { name, messages }
}

/**
 * The namespace's copy under its own name, the shape of a slice of the
 * aggregate dictionary, for code that probes keys with `getByPath`.
 */
export function namespaceRoot(namespace: Namespace, locale: Locale): Record<string, object> {
  return { [namespace.name]: namespace.messages[locale] }
}

/**
 * A translator over one namespace, optionally narrowed to a `scope` inside it
 * (`translatorFor(searchCopy, 'de', 'filters')` reads `search.filters.*`). A
 * missing key comes back as its full dot path, as `createTranslator` does.
 */
export function translatorFor(namespace: Namespace, locale: Locale, scope?: string): Translator {
  const path = scope ? `${namespace.name}.${scope}` : namespace.name
  return createTranslator(namespaceRoot(namespace, locale), path)
}
