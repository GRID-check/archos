---
status: proposed
date: 2026-10-15
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# Web Push for the inbox: VAPID and `web-push`, a worker that caches nothing, minimal encrypted payloads

## Context and Problem Statement

The inbox (Postfach, ADR-0035) says what needs a person, but only to a person
who has Piloti open. A request that waits on a Ziviltechniker's decision, a
question from Piloti on a mark, a finished research run: each matters most when
the person is somewhere else. The inbox declared an email channel and built no
sender. A system notification on the phone or desktop is the channel people
already trust for "someone needs me", and every platform we serve has it:
desktop browsers, Android, and iPhone and iPad since iOS 16.4 for an app on the
Home Screen.

It has to be opt-in per device, respect what a person wants, never show one
office's data to another, and disappear where the platform cannot do it.

## Decision Drivers

* Piloti serves several offices from one origin. Nothing tenant-scoped may sit
  where another session could read it, and a notification already on a lock
  screen cannot be revoked the way an inbox row can (IB-13).
* No third-party push service: the payload would leave our control, and the
  vendor would hold a subscriber list of architects.
* The request that writes an inbox item must not wait on a push service.
* Buy, do not build: encryption and signing are what we would get subtly wrong.

## Considered Options

* A vendor service (OneSignal, Firebase Cloud Messaging SDK, Novu).
* Standard Web Push (RFC 8030, VAPID RFC 8292, message encryption RFC 8291),
  sending ourselves with the `web-push` library.
* Email only, as ADR-0035 sketched.

## Decision Outcome

Chosen option: **standard Web Push with VAPID**, sent by the `bff-jobs` pool with
the `web-push` library.

* **VAPID and `web-push`.** The browsers' own push services (Google, Mozilla,
  Apple, Microsoft) deliver; we hold one key pair per environment and sign with
  it. `web-push` (MPL-2.0, used unmodified as a dependency) does the VAPID JWT
  and the `aes128gcm` encryption; `sender.spec.ts` decrypts what it produces
  with `http_ece` as the oracle. The three `GRID_WEB_PUSH_*` variables are all
  or nothing; with none the feature is off and the UI says nothing about it.
* **A service worker that caches nothing.** `public/sw.js` handles `push`,
  `notificationclick` and `pushsubscriptionchange`, and has **no `fetch` handler**
  and no Cache Storage use. Offline support is not the goal here, and a worker
  that answered requests from a cache could answer one person with what another
  person's session fetched. `service-worker.spec.ts` holds that as a fact about
  the file. It is served `no-cache` so a fix reaches devices, is outside the auth
  redirect so a signed-out browser's update check is not read as a failure, and
  is registered only from the signed-in shell.
* **Privacy of the payload.** The payload is encrypted for one browser, minimal
  (the row's title, one line, the item's address, a tag) and never the excerpt,
  which the inbox may later withhold. A person-level switch replaces the content
  with "Neue Nachricht in Piloti" for the lock screen. The Topic header, which the
  push service sees, is a digest of the group key, not the key.
* **Coupled to the inbox at its one write path.** `emitInboxItems` queues an
  `inbox_push` job for each stored row whose recipient holds a device. The job
  carries ids and a stamp, and decides again when it runs: the person is still a
  member, the item is unread and not resolved, archived or inert, nothing newer
  superseded it, the person's category is on, and the person could see the item
  in the inbox right now (`viewInboxItemAs`, the read path's own steps, as the
  recipient). Not visible means nothing is sent, never a vaguer notification.
  The registry names a category and urgency per type; five categories are the
  person's switches, on for what is addressed to them and off for ambient
  activity.
* **One device, one person.** The subscription endpoint is unique across
  tenants. Registering claims it, removing another person's row, and signing out
  removes the device, so a shared computer does not show the previous person's
  inbox. Endpoints must be on a known push service's host, so the sender cannot
  be pointed at an internal address. The host must be plain DNS labels and read
  the same by WHATWG `URL` (the check) and Node's `url.parse` (what `web-push`
  requests); the sender re-checks before each send, and the table's CHECK holds
  the shape.
* **Failure.** 404 and 410 remove the device; final refusals count against it
  and drop it after five; transient failures retry through the queue's backoff.
  A tag and Topic per group make a retry or a burst one notification.

### Consequences

* Good: a person with the app closed learns of a request when it lands, on every
  platform that has Web Push, with no vendor in the path.
* Good: revocation is honoured to the last moment before sending.
* Bad: iOS delivers only to an installed app, and nothing we do changes that;
  the settings say how to install. Cross-device closing of a read item is not
  built (a silent push to close would show a placeholder notification on
  Chrome and iOS); a device closes its own notifications when the item is read
  there.
* Bad: a person in several offices gets notifications for the office they last
  registered the browser in.
* Neutral: rotating the VAPID pair invalidates every subscription; the browser
  re-subscribes on the next click, so it is done once per environment.

### Confirmation

`inbox-push-job.spec.ts` (each re-check, 410 pruning, retry),
`routes.spec.ts` (through the typed client), `repository.integration.spec.ts`
(`task db:test:rls`: isolation and the claim), `service-worker.spec.ts`,
`sender.spec.ts` (real encryption), `endpoint.spec.ts`.

## More Information

[`../deployment/environment-variables.md`](../deployment/environment-variables.md),
[`../database/schema.md`](../database/schema.md) (`push_subscriptions`).
