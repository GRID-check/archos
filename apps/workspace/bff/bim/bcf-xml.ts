/**
 * The XML of a BCF file someone else wrote, read into a small element tree.
 *
 * The bytes are untrusted, so the parser is one that never resolves anything:
 * `saxes` is a strict, non-validating XML 1.0 parser that knows the five
 * predefined entities and nothing else, never reads a DTD's internal subset,
 * never fetches an external one and has no entity expansion to blow up. On top
 * of that a document type declaration is refused outright: BCF's schemas
 * declare none, so a `<!DOCTYPE` in a BCF file is either a mistake or an
 * attempt (an XML external entity, a billion laughs), and either way not read.
 * An undefined entity reference fails the parse (saxes: "undefined entity").
 *
 * Bounded three ways before and while it parses: the text's size
 * ({@link MAX_BCF_XML_CHARS}), the number of elements
 * ({@link MAX_BCF_XML_ELEMENTS}) and the nesting depth
 * ({@link MAX_BCF_XML_DEPTH}). Namespaces are not resolved: a BCF element is
 * matched on its local name, so a writer that adds a default namespace or a
 * prefix still reads.
 *
 * Pure: no `server-only`, no I/O.
 */

import { SaxesParser } from 'saxes'

/** Characters of one XML part: a markup with a long thread, or a viewpoint naming thousands of elements. */
export const MAX_BCF_XML_CHARS = 4 * 1024 * 1024
/** Elements of one XML part: a viewpoint of 2000 exceptions is about 2,100. */
export const MAX_BCF_XML_ELEMENTS = 100_000
/** BCF nests five deep at most (Color, Components, Component); 32 leaves room for any writer's wrapping. */
export const MAX_BCF_XML_DEPTH = 32

export interface XmlElement {
  /** The local name: `Topic`, never `bcf:Topic`. */
  name: string
  attributes: Readonly<Record<string, string>>
  children: XmlElement[]
  /** The element's own text, concatenated, untrimmed. */
  text: string
}

/** Why a part could not be read; the message is for logs, the archive reader reports `bad_xml`. */
export class BcfXmlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BcfXmlError'
  }
}

const localName = (name: string): string => name.slice(name.indexOf(':') + 1)

/** Parse one XML part into its root element, or throw {@link BcfXmlError}. */
export function parseBcfXml(source: string): XmlElement {
  if (source.length > MAX_BCF_XML_CHARS) throw new BcfXmlError('XML part is too large')
  const parser = new SaxesParser({ xmlns: false })
  const stack: XmlElement[] = []
  let root: XmlElement | null = null
  let elements = 0
  parser.on('error', (error) => {
    throw new BcfXmlError(error.message)
  })
  parser.on('doctype', () => {
    throw new BcfXmlError('a document type declaration is not read')
  })
  parser.on('opentag', (tag) => {
    elements += 1
    if (elements > MAX_BCF_XML_ELEMENTS) throw new BcfXmlError('XML part has too many elements')
    if (stack.length >= MAX_BCF_XML_DEPTH) throw new BcfXmlError('XML part nests too deep')
    const attributes: Record<string, string> = {}
    for (const [name, value] of Object.entries(tag.attributes)) {
      if (typeof value === 'string') attributes[localName(name)] = value
    }
    const element: XmlElement = { name: localName(tag.name), attributes, children: [], text: '' }
    const parent = stack.at(-1)
    if (parent) parent.children.push(element)
    else root = element
    stack.push(element)
  })
  const onText = (text: string): void => {
    const current = stack.at(-1)
    if (current) current.text += text
  }
  parser.on('text', onText)
  parser.on('cdata', onText)
  parser.on('closetag', () => {
    stack.pop()
  })
  try {
    parser.write(source).close()
  } catch (error) {
    if (error instanceof BcfXmlError) throw error
    throw new BcfXmlError(error instanceof Error ? error.message : 'not well-formed XML')
  }
  if (!root) throw new BcfXmlError('XML part has no root element')
  return root
}

/** The direct children called `name`. */
export const childrenNamed = (element: XmlElement | null | undefined, name: string): XmlElement[] =>
  element ? element.children.filter((child) => child.name === name) : []

/** The first direct child called `name`, or null. */
export const childNamed = (element: XmlElement | null | undefined, name: string): XmlElement | null =>
  element?.children.find((child) => child.name === name) ?? null

/** The trimmed text of the first direct child called `name`, or null when it is absent or blank. */
export function childText(element: XmlElement | null | undefined, name: string): string | null {
  const text = childNamed(element, name)?.text.trim()
  return text ? text : null
}

/** Every descendant called `name`, in document order. Bounded by the element cap of the parse. */
export function descendantsNamed(element: XmlElement | null | undefined, name: string): XmlElement[] {
  if (!element) return []
  const found: XmlElement[] = []
  const walk = (node: XmlElement): void => {
    for (const child of node.children) {
      if (child.name === name) found.push(child)
      walk(child)
    }
  }
  walk(element)
  return found
}
