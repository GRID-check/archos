#!/usr/bin/env node
/**
 * Renders the AuthKit stylesheet WorkOS takes: authkit.css with its photo inlined,
 * because the hosted page cannot load files from our domains.
 *
 *   node packages/brand/authkit/build.mjs   writes packages/brand/dist/authkit.css
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const photo = readFileSync(resolve(here, 'login-photo.webp')).toString('base64')
const css = readFileSync(resolve(here, 'authkit.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//, '')
  .replace("url('./login-photo.webp')", `url('data:image/webp;base64,${photo}')`)
  .trim()
writeFileSync(resolve(here, '../dist/authkit.css'), `${css}\n`)
console.log(`dist/authkit.css: ${css.length} bytes`)
