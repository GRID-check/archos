/**
 * @vitest-environment node
 */
/**
 * The XML of a BCF file is read without ever resolving anything
 * (`./bcf-xml.ts`): a document type declaration, an external or internal
 * entity, an undefined entity and an oversized or deeply nested part are
 * refused; a BCF markup reads by local name.
 */

import { describe, expect, it } from 'vitest'
import { BcfXmlError, childText, MAX_BCF_XML_CHARS, MAX_BCF_XML_DEPTH, parseBcfXml } from './bcf-xml'

const refused = (source: string) => expect(() => parseBcfXml(source)).toThrow(BcfXmlError)

describe('parseBcfXml', () => {
  it('reads a markup by local name, whatever prefix the writer used', () => {
    const root = parseBcfXml(
      '<?xml version="1.0" encoding="UTF-8"?><bcf:Markup xmlns:bcf="urn:x"><bcf:Topic Guid="g"><bcf:Title>Durchbruch &amp; Sturz</bcf:Title></bcf:Topic></bcf:Markup>'
    )
    expect(root.name).toBe('Markup')
    expect(root.children[0].attributes.Guid).toBe('g')
    expect(childText(root.children[0], 'Title')).toBe('Durchbruch & Sturz')
  })

  it('refuses an external entity (XXE)', () => {
    refused('<?xml version="1.0"?><!DOCTYPE m [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><Markup>&xxe;</Markup>')
  })

  it('refuses a billion laughs', () => {
    refused(
      '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><Markup>&lol2;</Markup>'
    )
  })

  it('refuses any document type declaration, even an empty one', () => {
    refused('<!DOCTYPE Markup><Markup/>')
  })

  it('refuses an entity it does not know, instead of passing its name through', () => {
    refused('<Markup><Title>&nbsp;</Title></Markup>')
  })

  it('refuses a part past its size, its depth, or malformed', () => {
    refused(`<Markup>${'x'.repeat(MAX_BCF_XML_CHARS)}</Markup>`)
    refused(`${'<a>'.repeat(MAX_BCF_XML_DEPTH + 1)}${'</a>'.repeat(MAX_BCF_XML_DEPTH + 1)}`)
    refused('<Markup><Topic></Markup>')
    refused('')
  })
})
