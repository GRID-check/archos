/**
 * The browser keys that lost the product's name (ADR-0145 rule 5), moved once
 * per browser before anything reads them.
 *
 * Every key a surface keeps in localStorage or sessionStorage is named by what
 * it holds (`sidebar.collapsed`, `layout`), never by the brand. A browser that
 * stored a value under the old name keeps it: the script below runs while the
 * browser parses `<head>`, ahead of the theme script and every bundle, and for
 * each pair copies the old value to the new key when the new key is empty, then
 * deletes the old one. A second load finds nothing to move. A key with a
 * per-item suffix moves by its prefix.
 *
 * The next release deletes this file: by then every browser that loaded the
 * app has moved its values, and one that has not loads its defaults, which is
 * what a cleared storage does too.
 */

/** Old key → new key, for exact keys in either storage. */
export const RENAMED_STORAGE_KEYS: Readonly<Record<string, string>> = {
  'grid-layout': 'layout',
  'grid:chunk-reload-ts': 'chunk-reload-ts',
  'grid.sidebar.collapsed': 'sidebar.collapsed',
  'grid.sidebar.width': 'sidebar.width',
  'grid.project.recent': 'project.recent',
  'grid.project.last-section': 'project.last-section',
  'grid.viewerActions.auto': 'viewerActions.auto',
  'grid.files.brief.collapsed': 'files.brief.collapsed',
  'grid.files.view': 'files.view',
  'grid.filePeek.width': 'filePeek.width',
  'grid.search.recent': 'search.recent',
  'grid.keyboard-shortcuts.enabled': 'keyboard-shortcuts.enabled',
  'grid.return-trail': 'return-trail',
  'piloti-chat-effort': 'chat-effort',
  'piloti.usage-notice.dismissed': 'usage-notice.dismissed',
  'piloti.review.toolsIntroSeen': 'review.toolsIntroSeen',
  'piloti.push-offer.shown': 'push-offer.shown',
  'piloti.push-prompt.dismissed': 'push-prompt.dismissed',
}

/** Old prefix → new prefix, for keys that end in an item's id. */
export const RENAMED_STORAGE_PREFIXES: Readonly<Record<string, string>> = {
  'piloti.mailImport.file.': 'mailImport.file.',
}

/**
 * Plain ES5, shipped as a string into `<head>`, like `THEME_BOOT_SCRIPT`: it
 * runs before any polyfill or bundle, every storage access is guarded (a
 * private window throws), and nothing is built into it at runtime. The two
 * maps are written into the literal; `storage-rename-boot.spec.ts` holds the
 * literal to them and runs it.
 */
export const STORAGE_RENAME_BOOT_SCRIPT =
  '(function(){var k={"grid-layout":"layout","grid:chunk-reload-ts":"chunk-reload-ts","grid.sidebar.collapsed":"sidebar.collapsed","grid.sidebar.width":"sidebar.width","grid.project.recent":"project.recent","grid.project.last-section":"project.last-section","grid.viewerActions.auto":"viewerActions.auto","grid.files.brief.collapsed":"files.brief.collapsed","grid.files.view":"files.view","grid.filePeek.width":"filePeek.width","grid.search.recent":"search.recent","grid.keyboard-shortcuts.enabled":"keyboard-shortcuts.enabled","grid.return-trail":"return-trail","piloti-chat-effort":"chat-effort","piloti.usage-notice.dismissed":"usage-notice.dismissed","piloti.review.toolsIntroSeen":"review.toolsIntroSeen","piloti.push-offer.shown":"push-offer.shown","piloti.push-prompt.dismissed":"push-prompt.dismissed"};var p={"piloti.mailImport.file.":"mailImport.file."};function move(s,from,to){var v=s.getItem(from);if(v===null)return;if(s.getItem(to)===null)s.setItem(to,v);s.removeItem(from)}function run(s){var o,i,n,names=[];for(o in k)if(Object.prototype.hasOwnProperty.call(k,o))move(s,o,k[o]);for(i=0;i<s.length;i++)names.push(s.key(i));for(i=0;i<names.length;i++)for(o in p)if(Object.prototype.hasOwnProperty.call(p,o)&&names[i]&&names[i].indexOf(o)===0){n=p[o]+names[i].slice(o.length);move(s,names[i],n)}}try{run(window.localStorage)}catch(e){}try{run(window.sessionStorage)}catch(e){}})()'
