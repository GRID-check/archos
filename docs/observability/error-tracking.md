# Error tracking

Exceptions land in **PostHog error tracking** when PostHog is configured
(ADR-0098). It replaces the hand-rolled
err2issue path (ERROR log, OTLP collector, GitHub issue; ADR-0031), which is to
be retired once PostHog has proven itself; until then both see the same error.
LLM traces and scores are a separate matter: they reach PostHog only through
Langfuse's own PostHog integration, never from our code.

Everything here is **off by default**. With no PostHog settings in a runtime,
none of the code below sends anything.

| Runtime | Settings that switch it on | Where the exception is captured |
|---|---|---|
| Browser | `NEXT_PUBLIC_POSTHOG_HOST` + `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`, handed to the page through `AppConfig` | posthog-js autocapture (unhandled errors and rejections), and `capturePosthogException` from the two error boundaries |
| BFF server | the same two variables, read by `posthog-server.ts` | `onRequestError` in `src/instrumentation.ts` |
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

Neither boundary reports an authorization denial (`isAuthzError`: an expected
outcome) or an error with a `digest` (thrown on the server, where
`onRequestError` already reported it with its stack; the client copy is the
redacted "error occurred in the Server Components render"). PostHog starts in
the layout's providers, so a crash before they mount is reported by the server
side only.

## BFF server

Next calls `onRequestError` for every error it catches in a render, route
handler, server action or the proxy. It is a named export, so it runs whether or
not `register()` returned early for want of an OTLP endpoint. The reporting is
`lib/analytics/request-error.ts`:

- Properties: `route_path` (the pattern, `/api/projects/[projectId]/files`),
  `route_type`, `router_kind`, `render_source`, `request_method`, `request_path`
  (query string removed), `digest`, `release` (`GRID_GIT_SHA`), `service`.
- The event is **personless**. The WorkOS user id is only inside the sealed
  session cookie, and decrypting it is a WorkOS call that an error path must not
  start.
- Authorization denials are dropped, and each fingerprint (route, error name,
  message) gets 5 events per 5 minutes.
- On shutdown, `server.js` runs the functions registered on
  `globalThis.__gridShutdownHooks` before it exits, up to 2 s after the drain.
  `instrumentation.ts` registers `shutdownPosthogServer`, which flushes the
  queue.

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
`release` and `environment` as `trace_context` derives them for Langfuse, and,
inside a traced run, the trace id as `$ai_trace_id` and `langfuse_trace_id`.
Langfuse exports that trace to PostHog as `langfuse observation` events, so an
issue links to the trace that produced it. The event is personless.
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
| BFF, per fingerprint | 5 per 5 minutes |
| Both | authorization denials are never counted |

A dropped record is still logged everywhere else; it is only not counted again.

## Not done here

- Source maps are not uploaded, so browser stacks are minified. That needs
  `productionBrowserSourceMaps` or `@posthog/nextjs-config` and a CI step.
- `POSTHOG_RELEASE_ID` (PostHog's release link) is not set; the commit travels as
  the `release` property instead.
- The err2issue collector pipeline and its Pulumi stack are untouched.
