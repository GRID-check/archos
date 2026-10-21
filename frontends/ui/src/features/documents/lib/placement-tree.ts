/**
 * A root sort's proposal as a tree, and what the person has changed of it.
 *
 * Pure. The review draws the tree (`placement-tree.tsx`), the dialog applies
 * what it keeps (`keptMoves`), and every rule is held once, here, rather than
 * in the drawing.
 *
 * Where a file goes, in order: the person's own choice (a retarget, which may
 * be the root), then the filing judgement's placement, then a new folder the
 * leftovers were proposed into. A new folder the person switched off sends its
 * files to the root with the rest of what stays. Nothing here moves a file.
 */

import {
  certaintyOf,
  type NewFolderProposal,
  type PlacementCertainty,
  type RootSortDocument,
  type RootSortFolder,
  type RootSortPlacement,
} from '@/lib/filing/root-sort-types'

/** What the person has changed. Every change returns a new state; nothing is mutated. */
export interface PlacementState {
  /** Files the person has unchecked: they stay where they are. */
  excluded: ReadonlySet<string>
  /** New folder paths the person has switched off: they are not created, and their files stay in the root. */
  excludedNewFolders: ReadonlySet<string>
  /** A file's own target, chosen in the tree: a folder id, or null for the root. Wins over the proposal. */
  retargets: ReadonlyMap<string, string | null>
}

export const NO_CHANGES: PlacementState = {
  excluded: new Set(),
  excludedNewFolders: new Set(),
  retargets: new Map(),
}

export interface PlacementInput {
  folders: readonly RootSortFolder[]
  documents: readonly RootSortDocument[]
  placements: readonly RootSortPlacement[]
  newFolders: readonly NewFolderProposal[]
}

/** Where the person chose a file goes: an existing folder, the root, or the proposal as it was. */
export type RetargetChoice =
  { kind: 'folder'; folderId: string } | { kind: 'root' } | { kind: 'proposal' }

export interface FileNode {
  kind: 'file'
  id: string
  name: string
  /** Why the file goes there; empty when the judgement gave no reason or the person chose the target. */
  reason: string
  confidence: number | null
  /** Null for a file that stays in the root. */
  certainty: PlacementCertainty | null
  /** Whether the file is moved when the person applies. */
  included: boolean
  /** The person chose this file's target, rather than the proposal. */
  chosenByPerson: boolean
}

export interface FolderNode {
  kind: 'folder'
  /** The full path from the shelf root: the node's key. */
  path: string
  /** The existing folder's id; null for a new folder. */
  folderId: string | null
  name: string
  /** 1 for a folder at the top, one more for each level below. */
  depth: number
  isNew: boolean
  /** A new folder the person switched off, here or above it: it is not created and its files stay in the root. */
  switchedOff: boolean
  /** Files placed directly in this folder. */
  files: FileNode[]
  children: FolderNode[]
  /** Files placed in this folder and below. */
  placedBelow: number
  /** Of those, the ones the person keeps. */
  includedBelow: number
  /** Of those, the ones Piloti is not sure of. */
  unsureBelow: number
  /** Files proposed in this folder and below that are in the root because a new folder was switched off. */
  heldBack: number
  /** Every file placed in this folder and below: what a folder-level switch changes. */
  documentIds: string[]
}

export interface PlacementSummary {
  /** Proposed placements Piloti is sure of, whether or not the person keeps them. */
  sure: number
  /** Proposed placements Piloti is not sure of. */
  unsure: number
  /** New folders that carry at least one proposed file. */
  newFolders: number
  /** Files that stay in the root. */
  stays: number
  /** Files the person keeps: what applying moves. */
  included: number
}

export interface PlacementTree {
  /** The folders with something placed in them or held back by them, top level first. */
  folders: FolderNode[]
  /** Files with no target, sorted by name. */
  stays: FileNode[]
  summary: PlacementSummary
}

export interface KeptMove {
  documentId: string
  folderId: string | null
  newFolderPath: string | null
}

export interface KeptMoves {
  /** Every new folder some kept move lands in, each to be created once. */
  newFolderPaths: string[]
  moves: KeptMove[]
}

type Destination = { folderId: string } | { newPath: string }

interface Resolved {
  documentId: string
  name: string
  /** Where the file goes after the person's switches; null when it stays in the root. */
  destination: Destination | null
  /** The new folder the file was proposed into, when a switched-off new folder sent it to the root. */
  heldPath: string | null
  reason: string
  confidence: number | null
  certainty: PlacementCertainty | null
  included: boolean
  chosenByPerson: boolean
}

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' })

/** Trimmed segments joined with single slashes: the one spelling a path is compared by. */
export function normalizePath(path: string): string {
  return path
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('/')
}

/** Whether `path` is `folder` or lies below it. */
export function isUnder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`)
}

/** Whether a new folder is switched off by itself or by one above it. */
function isSwitchedOff(excludedNewFolders: ReadonlySet<string>, path: string): boolean {
  for (const excluded of excludedNewFolders) if (isUnder(path, excluded)) return true
  return false
}

/**
 * The folder id the ensure route answered for a path. The route answers the
 * path as it sent it; a key that differs only in case or outer spaces is the
 * same folder, so the lookup falls back to that before it gives up.
 */
export function folderIdFor(
  path: string,
  ensured: Readonly<Record<string, string>>
): string | null {
  const exact = ensured[path]
  if (exact !== undefined) return exact
  const wanted = normalizePath(path).toLocaleLowerCase()
  for (const [key, id] of Object.entries(ensured)) {
    if (normalizePath(key).toLocaleLowerCase() === wanted) return id
  }
  return null
}

function resolveAll(input: PlacementInput, state: PlacementState): Resolved[] {
  const folderById = new Map(input.folders.map((folder) => [folder.id, folder]))
  const folderIdByPath = new Map(
    input.folders.map((folder) => [normalizePath(folder.path), folder.id])
  )
  const placementById = new Map<string, RootSortPlacement>()
  for (const placement of input.placements) {
    if (!placementById.has(placement.documentId)) placementById.set(placement.documentId, placement)
  }
  const proposalById = new Map<string, NewFolderProposal>()
  for (const proposal of input.newFolders) {
    for (const documentId of proposal.documentIds) {
      if (!proposalById.has(documentId)) proposalById.set(documentId, proposal)
    }
  }

  /** A path that names an existing folder is that folder; anything else is a new folder. */
  const destinationAt = (path: string): Destination => {
    const folderId = folderIdByPath.get(path)
    return folderId ? { folderId } : { newPath: path }
  }

  return input.documents.map((document): Resolved => {
    const placement = placementById.get(document.id)
    const proposal = proposalById.get(document.id)
    const placedPath = placement?.newFolderPath ? normalizePath(placement.newFolderPath) : ''
    const proposedPath = proposal ? normalizePath(proposal.path) : ''

    // The judgement's own placement first, then a new folder it was proposed into.
    const base: { destination: Destination; reason: string; confidence: number | null } | null =
      placement?.folderId && folderById.has(placement.folderId)
        ? {
            destination: { folderId: placement.folderId },
            reason: placement.reason,
            confidence: placement.confidence,
          }
        : placement && placedPath
          ? {
              destination: destinationAt(placedPath),
              reason: placement.reason,
              confidence: placement.confidence,
            }
          : proposal && proposedPath
            ? {
                destination: destinationAt(proposedPath),
                reason: proposal.description ?? '',
                confidence: proposal.confidences[document.id] ?? null,
              }
            : null

    const retargeted = state.retargets.has(document.id)
    const chosen: Destination | null = retargeted
      ? (() => {
          const folderId = state.retargets.get(document.id) ?? null
          return folderId && folderById.has(folderId) ? { folderId } : null
        })()
      : (base?.destination ?? null)

    const switchedOff =
      chosen !== null &&
      'newPath' in chosen &&
      isSwitchedOff(state.excludedNewFolders, chosen.newPath)
    const destination = switchedOff ? null : chosen
    const certainty: PlacementCertainty | null = destination
      ? retargeted
        ? 'sure'
        : certaintyOf(base?.confidence ?? null)
      : null

    return {
      documentId: document.id,
      name: document.name,
      destination,
      heldPath: switchedOff && chosen && 'newPath' in chosen ? chosen.newPath : null,
      // A reason explains the folder Piloti chose; once the person chooses another, it explains nothing.
      reason: retargeted ? '' : (base?.reason ?? ''),
      confidence: base?.confidence ?? null,
      certainty,
      included: destination !== null && !state.excluded.has(document.id),
      chosenByPerson: retargeted,
    }
  })
}

/** A mutable node while the tree is assembled; `finish` turns it into the immutable `FolderNode`. */
interface Draft {
  path: string
  folderId: string | null
  name: string
  isNew: boolean
  switchedOff: boolean
  parentPath: string | null
  files: FileNode[]
  children: Draft[]
}

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** The nearest folder above `path` that the tree has a node for; null puts it at the top. */
function nearestAncestor(path: string, drafts: ReadonlyMap<string, Draft>): string | null {
  const segments = path.split('/')
  for (let length = segments.length - 1; length > 0; length -= 1) {
    const ancestor = segments.slice(0, length).join('/')
    if (drafts.has(ancestor)) return ancestor
  }
  return null
}

function buildDrafts(
  input: PlacementInput,
  resolved: readonly Resolved[],
  state: PlacementState
): Map<string, Draft> {
  const drafts = new Map<string, Draft>()
  const folderPathById = new Map(
    input.folders.map((folder) => [folder.id, normalizePath(folder.path)])
  )
  for (const folder of input.folders) {
    const path = normalizePath(folder.path)
    drafts.set(path, {
      path,
      folderId: folder.id,
      name: folder.name,
      isNew: false,
      switchedOff: false,
      parentPath: null,
      files: [],
      children: [],
    })
  }

  const newDraft = (path: string, switchedOff: boolean): void => {
    if (drafts.has(path)) return
    drafts.set(path, {
      path,
      folderId: null,
      name: lastSegment(path),
      isNew: true,
      switchedOff,
      parentPath: null,
      files: [],
      children: [],
    })
  }
  for (const row of resolved) {
    if (row.destination && 'newPath' in row.destination) newDraft(row.destination.newPath, false)
    if (row.heldPath) newDraft(row.heldPath, true)
  }
  for (const path of state.excludedNewFolders) {
    const held = resolved.some((row) => row.heldPath !== null && isUnder(row.heldPath, path))
    if (held) newDraft(normalizePath(path), true)
  }

  for (const draft of drafts.values()) {
    if (draft.isNew) {
      draft.parentPath = nearestAncestor(draft.path, drafts)
    } else {
      const folder = input.folders.find((candidate) => candidate.id === draft.folderId)
      const parent = folder?.parentId ? folderPathById.get(folder.parentId) : undefined
      draft.parentPath = parent && drafts.has(parent) ? parent : null
    }
  }
  for (const draft of drafts.values()) {
    if (draft.parentPath === null) continue
    drafts.get(draft.parentPath)?.children.push(draft)
  }

  for (const row of resolved) {
    if (!row.destination) continue
    const destination = row.destination
    const path =
      'newPath' in destination
        ? destination.newPath
        : normalizePath(
            input.folders.find((folder) => folder.id === destination.folderId)?.path ?? ''
          )
    drafts.get(path)?.files.push(toFileNode(row))
  }
  return drafts
}

function toFileNode(row: Resolved): FileNode {
  return {
    kind: 'file',
    id: row.documentId,
    name: row.name,
    reason: row.reason,
    confidence: row.confidence,
    certainty: row.certainty,
    included: row.included,
    chosenByPerson: row.chosenByPerson,
  }
}

interface Counts {
  placed: number
  included: number
  unsure: number
  held: number
  documentIds: string[]
}

/** Turns the drafts into the nodes the tree shows, bottom-up, keeping a folder only when it places or holds back a file. */
function finish(
  draft: Draft,
  depth: number,
  drafts: ReadonlyMap<string, Draft>,
  held: readonly Resolved[]
): { node: FolderNode; counts: Counts } | null {
  const below = draft.children
    .map((child) => finish(child, depth + 1, drafts, held))
    .filter((entry): entry is { node: FolderNode; counts: Counts } => entry !== null)
  const ownHeld = held.filter(
    (row) => row.heldPath !== null && isUnder(row.heldPath, draft.path)
  ).length
  const counts: Counts = {
    placed: draft.files.length,
    included: draft.files.filter((file) => file.included).length,
    unsure: draft.files.filter((file) => file.certainty === 'unsure').length,
    held: ownHeld,
    documentIds: draft.files.map((file) => file.id),
  }
  for (const { counts: child } of below) {
    counts.placed += child.placed
    counts.included += child.included
    counts.unsure += child.unsure
    counts.documentIds.push(...child.documentIds)
  }
  if (counts.placed === 0 && counts.held === 0) return null
  const node: FolderNode = {
    kind: 'folder',
    path: draft.path,
    folderId: draft.folderId,
    name: draft.name,
    depth,
    isNew: draft.isNew,
    switchedOff: draft.switchedOff,
    files: [...draft.files].sort((a, b) => collator.compare(a.name, b.name)),
    children: below
      .map(({ node: child }) => child)
      .sort((a, b) => collator.compare(a.name, b.name)),
    placedBelow: counts.placed,
    includedBelow: counts.included,
    unsureBelow: counts.unsure,
    heldBack: counts.held,
    documentIds: counts.documentIds,
  }
  void drafts
  return { node, counts }
}

/** The tree the review draws: the proposal with the person's changes applied. */
export function buildPlacementTree(input: PlacementInput, state: PlacementState): PlacementTree {
  const resolved = resolveAll(input, state)
  const drafts = buildDrafts(input, resolved, state)
  const held = resolved.filter((row) => row.heldPath !== null)
  const tops = [...drafts.values()].filter((draft) => draft.parentPath === null)
  const folders = tops
    .map((draft) => finish(draft, 1, drafts, held))
    .filter((entry): entry is { node: FolderNode; counts: Counts } => entry !== null)
    .map(({ node }) => node)
    .sort((a, b) => collator.compare(a.name, b.name))
  const stays = resolved
    .filter((row) => row.destination === null)
    .map(toFileNode)
    .sort((a, b) => collator.compare(a.name, b.name))

  const newFolders = countNewFolders(folders)
  const summary: PlacementSummary = {
    sure: resolved.filter((row) => row.destination && row.certainty === 'sure').length,
    unsure: resolved.filter((row) => row.destination && row.certainty === 'unsure').length,
    newFolders,
    stays: stays.length,
    included: resolved.filter((row) => row.included).length,
  }
  return { folders, stays, summary }
}

function countNewFolders(nodes: readonly FolderNode[]): number {
  return nodes.reduce(
    (total, node) =>
      total +
      (node.isNew && !node.switchedOff && node.placedBelow > 0 ? 1 : 0) +
      countNewFolders(node.children),
    0
  )
}

/** What applying the person's choices moves: kept files only, and the new folders they land in. */
export function keptMoves(input: PlacementInput, state: PlacementState): KeptMoves {
  const moves: KeptMove[] = []
  for (const row of resolveAll(input, state)) {
    if (!row.included || !row.destination) continue
    moves.push(
      'folderId' in row.destination
        ? { documentId: row.documentId, folderId: row.destination.folderId, newFolderPath: null }
        : { documentId: row.documentId, folderId: null, newFolderPath: row.destination.newPath }
    )
  }
  const newFolderPaths = [
    ...new Set(moves.flatMap((move) => (move.newFolderPath ? [move.newFolderPath] : []))),
  ]
  return { newFolderPaths, moves }
}

/** The tree for a run that only asks about unsure placements: a folder stays if an unsure file sits below it. */
export function unsureOnly(tree: PlacementTree): PlacementTree {
  return {
    folders: tree.folders.flatMap(keepUnsure),
    stays: [],
    summary: tree.summary,
  }
}

function keepUnsure(node: FolderNode): FolderNode[] {
  if (node.unsureBelow === 0) return []
  return [
    {
      ...node,
      files: node.files.filter((file) => file.certainty === 'unsure'),
      children: node.children.flatMap(keepUnsure),
    },
  ]
}

/** A folder checkbox's state: whether everything below it is kept, some of it, or none. */
export function folderKept(node: FolderNode): boolean | 'indeterminate' {
  if (node.switchedOff || node.includedBelow === 0) return false
  return node.includedBelow === node.placedBelow ? true : 'indeterminate'
}

/** Keep or drop one file. Keeping it again also clears a retarget to the root, so the box says what will move. */
export function setFileKept(
  state: PlacementState,
  documentId: string,
  kept: boolean
): PlacementState {
  const excluded = new Set(state.excluded)
  if (kept) excluded.delete(documentId)
  else excluded.add(documentId)
  return { ...state, excluded }
}

/**
 * Keep or drop a folder and everything placed below it. A new folder is
 * switched off as a whole (its files go to the root); an existing folder's
 * files are unchecked one by one, so the subtree's own choices are kept
 * when it is switched back on only where they were not changed in between.
 */
export function setFolderKept(
  state: PlacementState,
  node: FolderNode,
  kept: boolean
): PlacementState {
  if (node.isNew) {
    const excludedNewFolders = new Set(state.excludedNewFolders)
    if (kept) {
      for (const path of state.excludedNewFolders)
        if (isUnder(path, node.path)) excludedNewFolders.delete(path)
      const excluded = new Set(state.excluded)
      for (const id of node.documentIds) excluded.delete(id)
      return { ...state, excluded, excludedNewFolders }
    }
    excludedNewFolders.add(node.path)
    return { ...state, excludedNewFolders }
  }
  const excluded = new Set(state.excluded)
  for (const id of node.documentIds) {
    if (kept) excluded.delete(id)
    else excluded.add(id)
  }
  return { ...state, excluded }
}

/** Send one file to a folder, the root, or back to the proposal. A folder or the root is a choice, so the file is kept again. */
export function retarget(
  state: PlacementState,
  documentId: string,
  choice: RetargetChoice
): PlacementState {
  const retargets = new Map(state.retargets)
  if (choice.kind === 'proposal') {
    retargets.delete(documentId)
    return { ...state, retargets }
  }
  retargets.set(documentId, choice.kind === 'folder' ? choice.folderId : null)
  const excluded = new Set(state.excluded)
  if (choice.kind === 'folder') excluded.delete(documentId)
  return { ...state, excluded, retargets }
}
