/**
 * Where a turn-context build's time went, as a W3C `Server-Timing` header.
 *
 * The agent records the header on its `setup.project_context` phase in Langfuse
 * (`agent/turn/context_client.py`), so a slow turn names the read that made
 * it slow instead of showing one opaque second. The phases are the service's
 * own reads; `memory` carries the dense channel's outcome as its description,
 * because whether the query embed was waited for is what decides its cost.
 */

/** Phase name to milliseconds, plus a description per phase where one says more. */
export class TurnContextTiming {
  private readonly startedAt = performance.now()
  private readonly phases = new Map<string, { ms: number; desc?: string }>()

  /** Await `load`, recording its duration under `name` whether it resolves or throws. */
  async time<T>(name: string, load: () => Promise<T>): Promise<T> {
    const started = performance.now()
    try {
      return await load()
    } finally {
      this.phases.set(name, { ms: performance.now() - started, desc: this.phases.get(name)?.desc })
    }
  }

  /** Attach a description (a short token, never content) to the phase `name`. */
  describe(name: string, desc: string): void {
    const phase = this.phases.get(name)
    this.phases.set(name, { ms: phase?.ms ?? 0, desc })
  }

  /** `name;dur=12.3[;desc="…"]`, in recording order, closed by `total`. */
  header(): string {
    const dur = (ms: number) => Math.round(ms * 10) / 10
    const entries = [...this.phases].map(([name, { ms, desc }]) =>
      desc ? `${name};dur=${dur(ms)};desc="${desc}"` : `${name};dur=${dur(ms)}`,
    )
    return [...entries, `total;dur=${dur(performance.now() - this.startedAt)}`].join(', ')
  }
}
