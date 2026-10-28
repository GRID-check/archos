import type { Instrumentation } from "next";

/**
 * The list `server.js` drains before it exits (it is CommonJS and cannot import
 * this module, and this one is bundled by Next, so a global is the one thing
 * both can see). Same key as `SHUTDOWN_HOOKS_KEY` in `server.js`.
 */
const SHUTDOWN_HOOKS_KEY = "__appShutdownHooks";

const registerShutdownHook = (hook: () => Promise<void>): void => {
  const holder = globalThis as Record<string, unknown>;
  const hooks = (holder[SHUTDOWN_HOOKS_KEY] ??= []) as Array<() => Promise<void>>;
  hooks.push(hook);
};

/**
 * Server errors Next.js catches (render, route handler, server action, proxy)
 * go to PostHog error tracking, replacing the console-to-OTLP-to-err2issue path
 * (ADR-0031, ADR-0100). A named export, not a registration: Next calls it
 * whether or not `register()` returned early, so a deployment without an OTLP
 * collector still reports. Node only: the configuration imports server code
 * (the scrubber, the authz check) that the Edge bundle must not pull in.
 * The capture is `@posthog/next`'s `createOnRequestError`; our configuration of
 * it (settings, scrubber, what is skipped): `lib/analytics/request-error`.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { requestErrorHandler } = await import("./bff/analytics/request-error");
    await requestErrorHandler()?.(error, request, context);
  } catch (failure) {
    // Reporting an error must never raise a second one on the request's path.
    console.error("[posthog] could not report a request error:", failure);
  }
};

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // What this process is, before anything else it does (ledger item 1). The
  // gateway (`server.js`) prints the same line, but only in the deployment
  // where it fronts Next; `next start` and `next dev` never load it, and this
  // hook runs in every one of them. Two lines in the compose deployment is the
  // right trade for never having a deployment that prints none. Rationale and
  // the shared format: `lib/boot.ts`.
  try {
    const { bootLine } = await import("./bff/boot");
    // This line IS the deliverable: it has to reach stdout at info level,
    // where a container log collector picks it up. `console.warn` would file a
    // normal boot as a problem, and routing it through a logger would make the
    // first line of the process depend on the logger having booted.
    // eslint-disable-next-line no-console
    console.log(bootLine());
  } catch (error) {
    console.error("[boot] could not read the boot identity:", error);
  }

  // Provision the fleet's default model if this deployment has none, BEFORE the
  // observability block: it must run whether or not a collector is configured,
  // and the early return below would otherwise skip it. Awaited so the defaults
  // are in place before the first request resolves an org's models, but it never
  // rejects — an empty table just means the workflow config stays in charge,
  // which is the pre-existing behaviour. See lib/model-config/bootstrap-defaults.
  try {
    const { bootstrapPlatformModelDefaults } = await import(
      "./bff/model-config/bootstrap-defaults"
    );
    await bootstrapPlatformModelDefaults();
  } catch (error) {
    console.error("[Model Config] Could not run the platform default bootstrap:", error);
  }

  // PostHog error tracking (ADR-0100) does not depend on the OTLP collector, so
  // its shutdown flush is registered here, before the early return below: a
  // deployment with PostHog and no collector must still deliver the exceptions
  // queued when a pod is replaced. `server.js` runs every hook on this list
  // before it exits (`__appShutdownHooks`); the client queues nothing, and the
  // hook does nothing, while PostHog is off.
  registerShutdownHook(async () => {
    const { shutdownPosthogServer } = await import("./bff/analytics/posthog-server");
    await shutdownPosthogServer();
  });

  // Capability derived from the dependency: no collector endpoint configured
  // (local dev, compose without observability) → no-op, zero overhead.
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;

  // Logs only. The BFF registers no trace provider: one trace per HTTP request
  // (health probes, RSC navigations, BFF POSTs) flooded Langfuse, so ADR-0029
  // Amendment 5 dropped every root span at creation, which left a provider that
  // recorded nothing. The operation a request forwards appears as a richer span
  // in the agent tier's own trace, and errors reach PostHog through
  // `onRequestError` above and the log bridge below.
  //
  // Bridge console.* to OTLP log records, which the collector forwards to
  // PostHog Logs. Shared with the scheduler/purger workers; no-ops without the
  // endpoint.
  const { initOtelLogs } = await import("./observability/otel-logs.js");
  initOtelLogs();
}
