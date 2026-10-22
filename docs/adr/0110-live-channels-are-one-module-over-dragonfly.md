---
status: proposed
date: 2026-10-13
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# Live channels are one module of our own over Dragonfly

## Context and Problem Statement

Piloti has four live mechanisms, and each was built on its own:

| Mechanism | Route | Transport | Re-check |
|---|---|---|---|
| Per-user hints (inbox, sharing, thread activity) | `GET /api/stream` | `lib/events/bus.ts`: one Dragonfly subscriber connection per open stream | none needed: authorized at publish time, per user channel |
| Typing in a shared thread | `POST /api/conversations/:id/typing` → per-user hints | the bus | at publish |
| Spectated turns (watching Piloti answer) | `GET /api/conversations/:id/live` | `lib/events/conversation-frames.ts`, its own subscriber | every 30 s, `stillMayWatchConversation` |
| The document room (presence, pointers, Anmerkungen hints) | `GET`/`POST /api/documents/:id/live` | `lib/annotations/room.ts`, a subscriber per stream, echo dropped by process id | every 30 s, `stillInRoom` |

Each copy carries its own SSE plumbing (retry, heartbeat, idempotent
teardown, the subscribe-in-flight race), its own Redis client options, and its
own answer to "a replica hears its own publish". A tab with a shared thread and
a document open holds three EventSources, and the server holds a Dragonfly
connection for each. The bus also delivers twice on the publishing replica, as
far as the code reads: `publishToUser` publishes to the local emitter and to
Redis, and `subscribeUser` listens to both with no origin check.

The next features (Piloti on the canvas as a participant, live draft regions,
cursor chat) all want a per-resource channel with presence. Copying the room a
fifth time is the path of least resistance and the wrong one. The question is
what carries live channels in this product.

## Decision Drivers

* Self-hosted: the product runs on our cluster (Dragonfly is ADR-0020's cache
  tier), and tenant data, even a pointer on a tenant's drawing, stays there.
* Revocation within one re-check interval: a reader who loses access to a
  document must stop hearing it within 30 s, not when a token expires.
* Nothing live is state (spec RT-4): every channel is company and hints over a
  database that holds the truth. Loss is acceptable; replay is not required.
* Buy, don't build, unless the library's shape does not answer the question.
* Cost per message near zero: pointers run at twelve a second per person.

## Considered Options

* Hosted: Liveblocks, Ably, Pusher
* Centrifugo (self-hosted real-time server)
* Supabase Realtime
* Soketi (self-hosted Pusher protocol)
* Yjs with Hocuspocus
* Socket.IO
* PartyKit
* Electric SQL / Zero (sync engines)
* Our own thin module, `lib/realtime`, over Dragonfly pub/sub: SSE down, POST up

## Decision Outcome

Chosen option: "our own thin module over Dragonfly", because every channel we
have is a few hundred lines of plumbing around one authorization decision, the
plumbing already existed four times, and none of the candidates both runs on our
cluster and re-checks a reader's access while a stream is open.

The module:

- `lib/realtime/hub.ts`: ONE subscriber connection and one publisher per
  process, topics ref-counted (SUBSCRIBE on the first listener, UNSUBSCRIBE on
  the last, a re-SUBSCRIBE waits for an UNSUBSCRIBE in flight), in-process
  loopback always, a process id on every remote message so the publisher drops
  its own echo.
- `lib/realtime/channel.ts` and `registry.ts`: a channel kind is declared once
  (`defineChannel`: key parse, topics, `authorize`, re-authorization interval,
  the vocabulary down, the vocabulary and rate limit up, presence) and listed
  explicitly.
- `lib/realtime/stream.ts`: the single copy of the SSE plumbing.
  `GET /api/realtime?ch=…` carries up to eight channels on one connection,
  frames tagged by `ch`, `revoked{ch}` on a failed re-check, and the stream ends
  after ten minutes so the reconnect resolves the session again.
- `lib/realtime/send.ts`: `POST /api/realtime/send` authorizes (cached for the
  re-check interval), spends the channel's limit, parses, stamps the peer from
  the session and publishes.
- `lib/realtime/roster.ts`: the server's TTL'd, bounded side record of who is
  in a channel, which `roomSnapshot` reads for Piloti.
- `features/realtime`: one EventSource per tab with a ref-counted channel set,
  the presence gossip roster, and `useChannel`.

The document room is its first channel (`doc:<id>`). Piloti speaks in it from
the server (`publishAsAgent`), as a peer the browser cannot impersonate.

### Consequences

* Good, because a new live surface is a `defineChannel` and a registry line,
  and authorization, re-checks, limits and identity stamping are not rewritten.
* Good, because a tab holds one connection and a replica one subscriber,
  however many channels and viewers.
* Good, because the seams (`EventTransport`, `ChannelLink`, the roster backend)
  keep it testable without Redis, and one spec runs against a real
  `redis-server`.
* Bad, because SSE is one-way: every pointer is an HTTP POST. At twelve a
  second per person that is the dominant cost, bounded by `ROOM_LIMIT` and by
  not streaming motion while a person is alone.
* Bad, because we own the code. The exits below say when that stops paying.

### Confirmation

* `src/lib/realtime/*.spec.ts`: ref-counting, echo, teardown, revoke on
  re-check, the channel cap, rate limit and identity stamp, the roster.
  `hub.redis.spec.ts` runs against a real server when `REALTIME_REDIS_URL` is set.
* `src/features/realtime/*.spec.ts` and `use-document-room.spec.tsx`: one
  EventSource, debounced reconnect, demultiplexing, cursor motion suppressed
  while alone.
* `authz-coverage.spec.ts` sees both routes declare `authz`.
* Review: a new channel kind appears in `registry.ts` or it does not exist.

## Pros and Cons of the Options

### Hosted: Liveblocks, Ably, Pusher

* Good, because presence, history and SDKs are done.
* Bad, because none self-hosts: tenant pointers and Anmerkungen hints leave our cluster.
* Bad, because revocation is token expiry, not a re-check while the stream is open.
* Bad, because pricing is per message or per connection-minute, and pointers are most of our messages.

### Centrifugo

* Good, because it self-hosts, speaks Redis, and does WebSocket, SSE, presence and history.
* Bad, because it is a second server to deploy, and its proxy hooks re-implement the authorization this module calls directly.
* **Named exit.** Move to Centrifugo when any of these holds: more than about
  2,000 concurrent streams per pod, the POST upstream cost is material in the
  BFF's CPU or request budget, or a channel needs history and recovery. The
  `defineChannel` contract maps onto its channel namespaces and proxy hooks.

### Supabase Realtime

* Bad, because it is shaped around Postgres replication and its own auth; adopting it means adopting Supabase.

### Soketi

* Good, because it self-hosts the Pusher protocol.
* Bad, because its authorization is a signed subscribe, with no re-check while open, and the project is quiet.

### Yjs with Hocuspocus

* Good, because it is the right answer for real co-editing of one structure.
* Bad, because nothing here co-edits: Anmerkungen are rows written through the API. Revisit only for real co-editing.

### Socket.IO

* Good, because it gives a WebSocket upstream and a Redis adapter.
* Bad, because the chat socket already runs through `server.js`, and a second socket server is a second upgrade path to secure. It is the candidate if the POST upstream becomes the cost, behind the same channel seam.

### PartyKit

* Bad, because it runs on Cloudflare only.

### Electric SQL / Zero

* Bad, because they sync database state; our live traffic is deliberately not state.

## More Information

Migration, in phases:

1. **This change.** The document room moves onto `lib/realtime` (`doc:<id>`);
   `lib/annotations/room.ts`, `room-service.ts` and
   `/api/documents/:id/live` are deleted. Piloti gets `publishAsAgent` and
   `roomSnapshot`.
2. **Per-user hints (done, 2026-10-22).** `/api/stream` and `lib/events/bus.ts` onto the hub: one
   subscriber per process instead of one per stream, and the origin rule ends
   the likely double delivery on the publishing replica. A `user:<id>` channel
   whose `authorize` is "the session is that user".
3. **Typing** onto presence in a `conv:<id>` channel, and **spectator frames**
   onto a `turn` topic that the same channel listens to; then
   `/api/conversations/:id/live` and its plumbing go.

Not migrated in phase 1: `/api/stream` (phase 2, since done), typing and the conversation live route.
