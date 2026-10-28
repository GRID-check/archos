/**
 * Whose a model is, said once.
 *
 * A project's model list deliberately spans two shelves: the project's own
 * uploads and the office's Büroablage, which every project of the office sees
 * (`listBimModels`, `includeOfficeShelf`). A reader of that list, a person or
 * an outside agent, must be able to tell them apart, or a sample building from
 * the shelf is reported as the client's. An office-shelf model has no project;
 * a project model always has one.
 */

import type { BimModelHeader } from './repository'

export type BimModelShelf = 'office' | 'project'

export function modelShelf(model: Pick<BimModelHeader, 'projectId'>): BimModelShelf {
  return model.projectId === null ? 'office' : 'project'
}

/** The model with its provenance stated, for any list an agent reads. */
export function withShelf<T extends Pick<BimModelHeader, 'projectId'>>(model: T): T & { shelf: BimModelShelf } {
  return { ...model, shelf: modelShelf(model) }
}
