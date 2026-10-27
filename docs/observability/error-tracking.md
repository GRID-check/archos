# Error tracking

Exceptions land in **PostHog error tracking** when PostHog is configured
(ADR-0100). It replaces the hand-rolled
err2issue path (ERROR log, OTLP collector, GitHub issue; ADR-0031), which is to
be retired once PostHog has proven itself; until then both see the same error.
LLM traces and scores are a separate matter: they reach PostHog only through
Langfuse's own PostHog integration, never from our code.

Everything here is **off by default**. With no PostHog settings in a runtime,
none of the code below sends anything.

| Runtime | Settings that switch it on | Where the exception is captured |
|---|---|---|
| Browser | `NEXT_PUBLIC_POSTHOG_HOST` + `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`, handed to the page through `AppConfig` | posthog-js autocapture (unhandled errors and rejections), and `capturePosthogException` from the two error boundaries |
| BFF server | the same two variables, read by `posthog-server.ts` | `onRequestError` in `src/instrumentation.ts`, and `captureUpstreamError` for a 502 the BFF answers itself |
| Python (agent and API) | `POSTHOG_HOST` + `POSTHOG_PROJECT_TOKEN` | a logging handler on the root logger, `observability/posthog_exceptions.py` |

## Browser

`lib/analytics/posthog.ts` keeps exception autocapture on. A React error
boundary swallows the error before `window.onerror` sees it, so the boundaries
report it themselves with `capturePosthogException(error, properties)` (a no-op
while disabled):

- `app/error.tsx`, the route boundary, keeps its `console.error`.
- `app/global-error.tsx` is the boundary above the root layout. Next replaces the
  whole document while it shows, so it renders its own `<html><body>`, imports
  `globals.css` and the theme boot script again, reads the locale from the
  `grid-locale` cookie (no provider exists) and reuses `errors.appError` for its
  copy, German and English. The prop is `retry` (stable since Next 16.3).

Next's control flow (`redirect()`, `notFound()`, `forbidden()`: a throw the
framework catches and turns into navigation) is never an exception.
`lib/analytics/control-flow-error.ts` recognises it by `digest` or by the bare
`NEXT_REDIRECT` message a server action's rejected promise carries, and three
places drop it: `capturePosthogException`, the browser `before_send`
(`scrubEvent`, for the unhandled-rejection autocapture) and the server
`beforeCapture`.

Neither boundary reports an authorization denial (an expected outcome, told by
its message, since a server-thrown class does not survive the RSC boundary) or an error with a `digest` (thrown on the server, where
`onRequestError` already reported it with its stack; the client copy is the
redacted "error occurred in the Server Components render"). PostHog starts in
the layout's providers, so a crash before they mount is reported by the server
side only.

## BFF server

Next calls `onRequestError` for every error it catches in a render, route
handler, server action or the proxy. It is a named export, so it runs whether or
not `register()` returned early for want of an OTLP endpoint. The capture is
`@posthog/next`'s `createOnRequestError` (pre-release, pinned to an exact
version); `lib/analytics/request-error.ts` builds it with our configuration:

- The host and token `posthog-server.ts` reads, at runtime, and a client with
  `scrubServerEvent` as its `before_send` and no GeoIP. The package builds its
  own posthog-node client and sends each exception immediately, so nothing is
  left queued at shutdown.
- Properties, set by the package: `$pathname` (query string removed),
  `$http_method`, `nextjs_route_path` (the pattern,
  `/api/projects/[projectId]/files`), `nextjs_route_type`, `nextjs_router_kind`,
  `nextjs_render_source`, `nextjs_error_digest`. Ours, from `beforeCapture`:
  `source`, `release` (`GRID_GIT_SHA`), `service`.
- The person is the visitor's: the package reads the PostHog cookie the browser
  writes (`localStorage+cookie` persistence) for the distinct id, the session id
  and the device id, so a server error sits on the same person and replay as
  the browser's events. Without the cookie the event is personless. The package
  skips a visitor whose opt-out is in a cookie, but the browser keeps the
  profile page's opt-out in localStorage (posthog-js's default), so a server
  error of an opted-out visitor is still reported under their distinct id.
  Moving the opt-out to a cookie (`opt_out_capturing_persistence_type`) would
  forget every opt-out already stored, so it is left as an open decision.
- Authorization denials (`isAuthzRefusal`: an `ApiError` with status 401, 403
  or 404, thrown in a page render or a server action) are dropped, and each fingerprint (route, error name,
  message) gets 5 events per 5 minutes, through `@posthog/core`'s
  `BucketedRateLimiter`.

`onRequestError` never sees an `ApiError`: `errorResponse` (`lib/api/handler.ts`)
answers it, so it is not an error Next caught. Most of them are answers about
the request (404, 409, 507) and belong nowhere. An `UpstreamError` (502) is a
dependency down: object storage, the agent backend, the knowledge layer. Until
2026-10-20 it left no trace, and SeaweedFS refusing every new organization's
first upload was noticed only because a user read „Object storage is
unavailable“. `errorResponse` now logs one `[upstream] <message> operation=…
code=… requestId=…` line (no path, so one outage is one fingerprint) and hands
the error to `captureUpstreamError` (`lib/analytics/upstream-error.ts`): a
personless `$exception` with `source: bff-upstream-error`, `request_id`, and the
thrower's `operation` and `code` when its details carry them. Same scrubber and
super properties as every BFF event, and the same 5-per-5-minutes budget, keyed
on message and code. An alert in PostHog on `source = bff-upstream-error` is
what turns it into a page; that is configured in PostHog, not here.

## Python

Grid catches and logs its exceptions (`logger.exception` in the job worker, the
job runner, the stage runner), so they never reach `sys.excepthook`, which is
all the SDK's own autocapture sees. `PosthogExceptionHandler` is attached to the
root logger once per process, by `posthog_exceptions.install()`, from the
`otelcollector_logs` logging method (every NAT process, before its no-collector
early return) and from the API plugin's `add_routes` (both roles). It is
idempotent.

It reports an `ERROR` or above record that carries `exc_info`, with the logger
name, the formatted message (presigned URLs scrubbed), the log call site,
`release` as `trace_context` derives it for Langfuse, and,
inside a traced run, the trace id as `$ai_trace_id` and `langfuse_trace_id`.
Langfuse exports that trace to PostHog as `langfuse observation` events, so an
issue links to the trace that produced it. The event is personless.
`environment` and `service` are super properties of the client, so every
Python event carries them, and frames under `aiq_agent` and `aiq_api` are
marked in-app. posthog-python has no `logging` integration (it ships Django,
Flask, Celery and ASGI ones), which is why this handler is ours. The release
is `$release_id`, which the SDK reads from `POSTHOG_RELEASE_ID`; the staging
deploy resolves it ([`ci.md`](../contributing/ci.md#posthog-releases-and-source-maps)).
`posthog_client` scrubs presigned URLs from every event's text on the way out,
because `str(httpx.HTTPStatusError)` embeds the request URL.

Records from the `posthog` logger and from `aiq_agent.observability.posthog*` are
skipped, so a failure of the reporter cannot report itself.

## Staying inside the free tier

PostHog's free tier is 100,000 exceptions a month. Three limits keep a hot loop
from spending it:

| Where | Limit |
|---|---|
| Python, per fingerprint (exception type, logger, innermost frame) | burst of 3, then 1 per 5 minutes (about 9K a month at the very worst) |
| Python, per process | burst of 20, then 1 per minute |
| BFF, per fingerprint (route, error name, message) | 5 per 5 minutes |
| Both | authorization denials are never counted |

A dropped record is still logged everywhere else; it is only not counted again.
The Python buckets are posthog-python's `BucketedRateLimiter`, the algorithm
posthog-js and posthog-node share.

## Not done here

- Source maps are uploaded by the frontend image build only
  ([`ci.md`](../contributing/ci.md#posthog-releases-and-source-maps)); a local or
  pull-request build ships minified stacks.
- err2issue is gone from the Pulumi program (the sink, its collector pipeline, its
  NetworkPolicy and image pin); a stack's leftover `err2issue*` keys are ignored.
