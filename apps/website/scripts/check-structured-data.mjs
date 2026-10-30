#!/usr/bin/env node
/**
 * Every JSON-LD block in the built pages parses, and every node carries the fields its
 * schema.org type needs (the fields Google's rich-result docs require, plus our own rules).
 *
 *   bun run build && bun run check:structured-data
 *
 * Reads dist/client/**\/*.html. Also holds the site's own rules: every indexed inner page
 * has a BreadcrumbList that ends at itself, a page with an FAQ has an FAQPage with the same
 * number of questions, the home page has a SoftwareApplication without price or rating.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../dist/client/', import.meta.url))

/** Required fields per type. A value that is an empty string or array counts as missing. */
const REQUIRED = {
  Organization: ['@id', 'name', 'url', 'logo'],
  WebSite: ['@id', 'name', 'url', 'publisher'],
  SoftwareApplication: ['name', 'description', 'applicationCategory', 'operatingSystem', 'publisher'],
  BreadcrumbList: ['itemListElement'],
  ListItem: ['position', 'name', 'item'],
  FAQPage: ['mainEntity'],
  Question: ['name', 'acceptedAnswer'],
  Answer: ['text'],
  BlogPosting: ['headline', 'datePublished', 'author', 'publisher', 'image', 'mainEntityOfPage'],
  PostalAddress: ['streetAddress', 'postalCode', 'addressLocality', 'addressCountry'],
}

/** Fields that would claim what has no evidence (Belegpflicht). */
const FORBIDDEN = { SoftwareApplication: ['offers', 'aggregateRating', 'review'] }

function htmlFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return htmlFiles(path)
    return name.endsWith('.html') ? [path] : []
  })
}

/** Every object with an `@type` in a parsed block, nested ones included. */
function typedNodes(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => typedNodes(v, out))
  else if (value && typeof value === 'object') {
    if (value['@type']) out.push(value)
    Object.values(value).forEach((v) => typedNodes(v, out))
  }
  return out
}

const missing = (node, field) => {
  const v = node[field]
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
}

const problems = []
let blocks = 0
let nodes = 0
for (const file of htmlFiles(CLIENT)) {
  const page = `/${relative(CLIENT, file)}`.replace(/index\.html$/, '')
  const html = readFileSync(file, 'utf8')
  const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1])
  if (scripts.length === 0) {
    problems.push(`${page}: no JSON-LD`)
    continue
  }
  const all = []
  for (const text of scripts) {
    blocks += 1
    let data
    try {
      data = JSON.parse(text)
    } catch (error) {
      problems.push(`${page}: JSON-LD does not parse (${error.message})`)
      continue
    }
    if (data['@context'] !== 'https://schema.org') problems.push(`${page}: @context is not https://schema.org`)
    all.push(...typedNodes(data))
  }
  nodes += all.length
  for (const node of all) {
    for (const field of REQUIRED[node['@type']] ?? []) if (missing(node, field)) problems.push(`${page}: ${node['@type']} without ${field}`)
    for (const field of FORBIDDEN[node['@type']] ?? []) if (field in node) problems.push(`${page}: ${node['@type']} claims ${field}`)
  }
  const types = all.map((n) => n['@type'])
  const noindex = /<meta name="robots" content="noindex"/.test(html)
  const isHome = page === '/' || page === '/en/'
  if (isHome && !types.includes('SoftwareApplication')) problems.push(`${page}: home without SoftwareApplication`)
  if (!isHome && !noindex) {
    const crumbs = all.find((n) => n['@type'] === 'BreadcrumbList')
    const last = crumbs?.itemListElement?.at(-1)?.item
    if (!crumbs) problems.push(`${page}: inner page without BreadcrumbList`)
    else if (!last || new URL(last).pathname !== page) problems.push(`${page}: breadcrumbs end at ${last}, not at the page`)
  }
  // The FAQ component's questions: the <details> inside the block it marks `data-faq`. Not the
  // `ui-faq` class: the changelog folds its weeks with the same styling and is no FAQ.
  const faqBlock = /<div [^>]*\bdata-faq\b[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? ''
  const questions = (faqBlock.match(/<details/g) ?? []).length
  const faq = all.find((n) => n['@type'] === 'FAQPage')
  if (questions > 0) {
    if (!faq) problems.push(`${page}: renders an FAQ without FAQPage`)
    else if (faq.mainEntity.length !== questions) problems.push(`${page}: FAQPage has ${faq.mainEntity.length} questions, the page ${questions}`)
  }
  if (/^\/(en\/)?blog\/(?!journal\/|bautagebuch\/)[^/]+\/$/.test(page) && !types.includes('BlogPosting')) {
    problems.push(`${page}: blog post without BlogPosting`)
  }
}

if (problems.length > 0) {
  console.error(`structured data: ${problems.length} problem(s)`)
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}
console.log(`structured data holds: ${blocks} JSON-LD blocks, ${nodes} typed nodes, every required field present`)
