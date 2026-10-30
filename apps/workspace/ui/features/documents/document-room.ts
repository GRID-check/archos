/**
 * The document's live room, for another feature that joins it (a Skizze's
 * editor, `features/diagrams/sketch/use-sketch-room.ts`). A top-level module
 * rather than the index: the index re-exports the review's components too, and
 * a hook reached through it put every spec rendering the sketch editor below
 * the review's whole subtree (`task workspace:blast-radius`).
 */
export {
  documentRoomChannel,
  useDocumentRoom,
  type DocumentRoom,
  type RoomPeerState,
  type RoomTransport,
} from './hooks/use-document-room'
