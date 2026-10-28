/**
 * The chosen project folder as a tree, before a byte is sent (ticket 26, step
 * „Ablage"): folders with what they hold, switched in or out as whole
 * subtrees, and what the office's sensitive-data list holds back of what stays
 * in. Confirmed per folder, never per file.
 *
 * Pure. The step draws it; the upload itself is the project's own upload path
 * (`onFiles`), which plans and screens the chosen files again.
 */

import { droppedPath } from '@/features/documents/lib/folder-upload-plan'
import { isSystemFile } from '@/features/documents/lib/system-files'
import { pathSegments } from '@/lib/projects/folders'
import { screenUploadName, type NameMatch } from '@/lib/upload-screening/name-screen'
import type { UploadScreeningPolicy } from '@/lib/upload-screening/policy'
import { exclusionReason, type ExclusionReason } from './default-exclusions'

/** One folder of the chosen tree. The tree's own root is the virtual node with path `''`. */
export interface FolderNode {
  /** From the top of the choice, `Wohnbau Nord/04_Honorare`; `''` for the root. */
  path: string
  name: string
  /** 0 for the root, 1 for a folder at the top of the choice. */
  depth: number
  children: FolderNode[]
  /** Files in it and below. */
  fileCount: number
  /** Bytes in it and below. */
  size: number
  /** Files directly in it. */
  ownFiles: number
}

export interface TreeFile {
  file: File
  /** The file's path in the choice. */
  path: string
  /** The folder it sits in; `''` at the top. */
  folder: string
}

export interface ChosenTree {
  root: FolderNode
  files: TreeFile[]
  /** Every folder by its path, the root included. */
  byPath: ReadonlyMap<string, FolderNode>
}

/** Folder paths switched out. A folder below one of them is out with it. */
export type ExcludedFolders = ReadonlySet<string>

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' })

function emptyNode(path: string, name: string, depth: number): FolderNode {
  return { path, name, depth, children: [], fileCount: 0, size: 0, ownFiles: 0 }
}

function sortTree(node: FolderNode): void {
  node.children.sort((a, b) => collator.compare(a.name, b.name))
  for (const child of node.children) sortTree(child)
}

/**
 * The tree of what was chosen. What the operating system left in a folder
 * (`.DS_Store`, `Thumbs.db`, Office lock files) is not part of it, as it is not
 * part of the upload.
 */
export function buildChosenTree(chosen: readonly File[]): ChosenTree {
  const root = emptyNode('', '', 0)
  const byPath = new Map<string, FolderNode>([['', root]])
  const files: TreeFile[] = []
  for (const file of chosen) {
    if (isSystemFile(file.name)) continue
    const path = droppedPath(file)
    const directories = pathSegments(path).slice(0, -1)
    const chain: FolderNode[] = [root]
    let parent = root
    for (const [index, name] of directories.entries()) {
      const folderPath = directories.slice(0, index + 1).join('/')
      let node = byPath.get(folderPath)
      if (!node) {
        node = emptyNode(folderPath, name, index + 1)
        byPath.set(folderPath, node)
        parent.children.push(node)
      }
      chain.push(node)
      parent = node
    }
    for (const node of chain) {
      node.fileCount += 1
      node.size += file.size
    }
    parent.ownFiles += 1
    files.push({ file, path, folder: parent.path })
  }
  sortTree(root)
  return { root, files, byPath }
}

/** `a/b/c` → `['a', 'a/b']`: the folders above a path, outermost first. */
function ancestorsOf(path: string): string[] {
  const segments = path.split('/').filter(Boolean)
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'))
}

const isBelow = (path: string, folder: string): boolean => folder !== '' && path.startsWith(`${folder}/`)

/** Whether a folder is out: switched out itself, or below one that is. */
export function isFolderExcluded(excluded: ExcludedFolders, path: string): boolean {
  if (path === '') return false
  return excluded.has(path) || ancestorsOf(path).some((ancestor) => excluded.has(ancestor))
}

/** How a folder's switch reads: in, out, or in with something below it out. */
export function folderState(excluded: ExcludedFolders, path: string): 'in' | 'out' | 'partial' {
  if (isFolderExcluded(excluded, path)) return 'out'
  for (const folder of excluded) if (path === '' || isBelow(folder, path)) return 'partial'
  return 'in'
}

/**
 * Switch a whole folder out or back in. Out takes its subtree with it. In
 * brings back the whole subtree, also when it was out only because a folder
 * above it was: that folder is switched in, and its other children stay out,
 * so exactly this folder's subtree returns.
 */
export function toggleFolder(tree: ChosenTree, excluded: ExcludedFolders, path: string): Set<string> {
  const next = new Set(excluded)
  if (path === '') return next
  if (!isFolderExcluded(excluded, path)) {
    for (const folder of excluded) if (isBelow(folder, path)) next.delete(folder)
    next.add(path)
    return next
  }
  next.delete(path)
  for (const folder of excluded) if (isBelow(folder, path)) next.delete(folder)
  const chain = ancestorsOf(path)
  const outerOut = chain.findIndex((ancestor) => excluded.has(ancestor))
  if (outerOut < 0) return next
  // From the outermost folder that is out down to this one's parent: switch
  // the folder on the way in, and keep its other children out.
  const way = [...chain.slice(outerOut), path]
  for (let index = 0; index < way.length - 1; index += 1) {
    const folder = way[index] as string
    next.delete(folder)
    const node = tree.byPath.get(folder)
    for (const child of node?.children ?? []) if (child.path !== way[index + 1]) next.add(child.path)
  }
  return next
}

/** The folders Piloti proposes to leave out, with why: the outermost match on each path only. */
export function proposedExclusions(tree: ChosenTree): Map<string, ExclusionReason> {
  const proposed = new Map<string, ExclusionReason>()
  const visit = (node: FolderNode): void => {
    for (const child of node.children) {
      const reason = exclusionReason(child.name)
      if (reason) proposed.set(child.path, reason)
      else visit(child)
    }
  }
  visit(tree.root)
  return proposed
}

/** The files the folder choice keeps. */
export function chosenFiles(tree: ChosenTree, excluded: ExcludedFolders): TreeFile[] {
  return tree.files.filter((entry) => !isFolderExcluded(excluded, entry.folder))
}

export interface ChoiceSummary {
  files: number
  size: number
  /** Files of the choice in all. */
  totalFiles: number
  totalSize: number
}

export function summarizeChoice(tree: ChosenTree, excluded: ExcludedFolders): ChoiceSummary {
  const kept = chosenFiles(tree, excluded)
  return {
    files: kept.length,
    size: kept.reduce((sum, entry) => sum + entry.file.size, 0),
    totalFiles: tree.root.fileCount,
    totalSize: tree.root.size,
  }
}

/** One term of the list and what it holds back of the choice. */
export interface HeldBackTerm {
  term: string
  files: number
  /** Where, as folder paths outermost first; `''` for files at the top of the choice. */
  folders: string[]
}

export interface ScreeningPreview {
  /** Files the list holds back, among those the folder choice keeps. */
  held: Array<TreeFile & { matches: NameMatch[] }>
  /** Per term, most files first. */
  byTerm: HeldBackTerm[]
  /** Files held back in each folder and below, by folder path. */
  heldIn: ReadonlyMap<string, number>
}

/**
 * What the office's list (with the project's changes) would hold back of what
 * the folder choice keeps, screened exactly as the upload screens it: the file
 * name and every folder on its path, filed at the project's top level.
 */
export function previewScreening(
  tree: ChosenTree,
  excluded: ExcludedFolders,
  policy: UploadScreeningPolicy
): ScreeningPreview {
  const held: ScreeningPreview['held'] = []
  const heldIn = new Map<string, number>()
  const terms = new Map<string, { files: number; folders: Set<string> }>()
  for (const entry of chosenFiles(tree, excluded)) {
    const folderPath = entry.folder || null
    const verdict = screenUploadName(policy, { filename: entry.file.name, originPath: entry.path, folderPath })
    if (!verdict.blocked) continue
    held.push({ ...entry, matches: verdict.matches })
    const on = entry.folder ? [...ancestorsOf(entry.folder), entry.folder] : []
    for (const folder of ['', ...on]) heldIn.set(folder, (heldIn.get(folder) ?? 0) + 1)
    for (const term of new Set(verdict.matches.map((match) => match.term))) {
      const tally = terms.get(term) ?? { files: 0, folders: new Set<string>() }
      tally.files += 1
      tally.folders.add(entry.folder)
      terms.set(term, tally)
    }
  }
  const byTerm = [...terms.entries()]
    .map(([term, tally]) => ({ term, files: tally.files, folders: [...tally.folders].sort(collator.compare) }))
    .sort((a, b) => b.files - a.files || collator.compare(a.term, b.term))
  return { held, byTerm, heldIn }
}

/**
 * The folders whose access is worth a look: the top of the project folder. A
 * choice that is one folder (the project folder from the office server)
 * answers its subfolders, `Wohnbau Nord/04_Honorare`; a choice of several
 * answers those.
 */
export function accessFolders(tree: ChosenTree): FolderNode[] {
  const [only] = tree.root.children
  if (tree.root.children.length === 1 && only && tree.root.ownFiles === 0 && only.children.length > 0) {
    return only.children
  }
  return tree.root.children
}
