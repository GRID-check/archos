// Pins the brand rules in check_brand_rules.mjs. Run: node --test scripts/check_brand_rules.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IDENTITY, aiTagFindings, copyFindings, cssFindings, definedProperties, headingFinding, stringLeaves } from './check_brand_rules.mjs'

test('German copy may not shout; English may', () => {
  assert.equal(copyFindings('Jetzt testen!', 'de').length, 1)
  assert.deepEqual(copyFindings('Try it!', 'en'), [])
})

test('emoji are refused, the typographic glyphs are not', () => {
  assert.equal(copyFindings('Schnell 🚀', 'de').length, 1)
  assert.deepEqual(copyFindings('Demo anfragen → · × © 2026 – Wien', 'de'), [])
})

test('the name is {name}, never typed, and carries no ™', () => {
  assert.deepEqual(copyFindings('{name} prüft das Modell.', 'de'), [])
  const typed = IDENTITY.name[0] + IDENTITY.name.slice(1).toLowerCase()
  assert.equal(copyFindings(`${typed} prüft das Modell.`, 'de').length, 1)
  assert.equal(copyFindings('{name}™ prüft.', 'de').length, 1)
  assert.deepEqual(copyFindings(IDENTITY.email, 'de'), [])
  assert.deepEqual(copyFindings(`${IDENTITY.name} – Startseite`, 'de', { filled: true }), [])
})

test('banned product nouns and jargon', () => {
  for (const text of ['Ihr KI-Copilot', 'Der KI-Workspace für Büros', 'Mit LLMs und Reasoning-Modellen', 'revolutioniert die Planung', 'nahtlos integriert', 'Wir nehmen Planer:innen alles ab.', 'Kein generatives Design']) {
    assert.ok(copyFindings(text, 'de').length > 0, text)
  }
  assert.deepEqual(copyFindings('Planer:innen entwerfen. {name} sucht, vergleicht und prüft.', 'de'), [])
})

test('statement headings end with a stop; page names and item labels do not have to', () => {
  assert.equal(headingFinding(['knowledge', 'title'], 'Das Wissen Ihres Büros wird nutzbar'), 'statement heading without a closing full stop (Überschriften enden mit Punkt)')
  assert.equal(headingFinding(['knowledge', 'title'], 'Noch Fragen?'), null)
  assert.equal(headingFinding(['title'], 'Datensicherheit'), null)
  assert.equal(headingFinding(['items', '0', 'title'], 'Hosting in Wien'), null)
  assert.equal(headingFinding(['meta', 'title'], 'Kontakt – {name}'), null)
  assert.equal(headingFinding(['hero', 'text'], 'no stop'), null)
})

test('stringLeaves walks objects and arrays', () => {
  assert.deepEqual(stringLeaves({ a: { b: ['x', 'y'] }, n: 3 }).map((l) => l.path.join('.')), ['a.b.0', 'a.b.1'])
})

test('CSS: colour literals, shadows, app tokens and unknown tokens', () => {
  const defined = definedProperties(':root { --radius-md: 4px; --space-4: 16px; --focus-ring: 0 0 0 2px; }')
  assert.deepEqual(cssFindings('.a { color: var(--ink); border-radius: var(--radius-md); padding: var(--space-4); box-shadow: var(--focus-ring); }', defined), [])
  assert.equal(cssFindings('.a { color: #a6a39e; }', defined).length, 1)
  assert.equal(cssFindings('.a { background: rgba(0, 0, 0, 0.1); }', defined).length, 1)
  assert.deepEqual(cssFindings('/* #fff in a comment */ .a { box-shadow: none; }', defined), [])
  assert.equal(cssFindings('.a { box-shadow: 0 1px 2px var(--line); }', defined).length, 1)
  assert.ok(cssFindings('.a { border-radius: var(--radius-control); }', defined).some((m) => m.includes('app-only')))
  assert.ok(cssFindings('.a { padding: var(--space-5); }', defined).some((m) => m.includes('not a token')))
})

test('an AI-generated image needs the AI tag in its own frame', () => {
  const ok = '<div class="ui-duo-card"><img src="/media/planner-design-photo.webp" alt=""><div class="ui-duo-text"><h3>t</h3></div><span class="ui-ai-tag">AI</span></div>'
  const missing = '<div class="ui-duo-card"><img src="/media/planner-design-photo.webp" alt=""><div class="ui-duo-text"><h3>t</h3></div></div><span class="ui-ai-tag">AI</span>'
  assert.deepEqual(aiTagFindings(ok), [])
  assert.equal(aiTagFindings(missing).length, 1)
  assert.deepEqual(aiTagFindings('<div><img src="/media/product-model-check.webp"></div>'), [])
})
