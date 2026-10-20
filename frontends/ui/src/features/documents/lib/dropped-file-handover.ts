/**
 * Files dropped somewhere in a project that is not Dateien, held for Dateien.
 *
 * A drop on Einstellungen, Mitglieder or Automatisierung used to do nothing, or
 * worse, let the browser open the file in place of the app. Uploading from
 * there would need a second upload path: the version question for a name the
 * project already holds, the folder plan for a dropped tree, the tray. Dateien
 * already has all of it, so the drop is handed to Dateien instead, which takes
 * it on mount and runs it through `handleUpload` like any drop of its own.
 *
 * Module state, not a store: it lives for one client-side navigation, and a
 * reload that loses it loses a drop the reader can repeat.
 */

let held: { projectId: string; files: File[] } | null = null

/** Hold a drop; a second drop into the same project before Dateien takes them joins the first. */
export function handOverDroppedFiles(projectId: string, files: File[]): void {
  held = {
    projectId,
    files: held?.projectId === projectId ? [...held.files, ...files] : [...files],
  }
}

/** The files held for this project, once: a second call returns none. */
export function takeDroppedFiles(projectId: string): File[] {
  if (!held || held.projectId !== projectId) return []
  const { files } = held
  held = null
  return files
}

/**
 * The key a drop onto the create-project dialog is held under. The project does
 * not exist yet, so the dialog makes a key of its own, sends it with the
 * creation, and the redirect hands it to that project's setup page
 * (`/setup?drop=<key>`), which takes the drop (`IntakeUpload`). The dialog
 * discards it when it closes without creating anything.
 *
 * One key per dialog, never a shared one: under the fixed key this replaced,
 * a drop the first project's setup page did not take (left too early, a failed
 * folder load, a create that threw) was taken by the NEXT project waiting for
 * documents, and filed there (pilot onboarding, 2026-10-19).
 */
export function newProjectDropKey(): string {
  return `${NEW_PROJECT_DROP_PREFIX}${crypto.randomUUID()}`
}

const NEW_PROJECT_DROP_PREFIX = 'new-project:'
const NEW_PROJECT_DROP_KEY_PATTERN = /^new-project:[0-9a-f-]{36}$/

/** Whether a value is a key {@link newProjectDropKey} made: what the action and the setup page accept. */
export function isNewProjectDropKey(value: unknown): value is string {
  return typeof value === 'string' && NEW_PROJECT_DROP_KEY_PATTERN.test(value)
}

/** Forget what is held for this project (a dialog closed, a drop taken back). */
export function discardDroppedFiles(projectId: string): void {
  if (held?.projectId === projectId) held = null
}
