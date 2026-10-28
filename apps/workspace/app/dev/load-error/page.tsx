'use client'

/**
 * Dev preview — `LoadError`, the one block for a load that failed where its
 * content should be, and `CountPill`'s cap.
 *
 *  1. **The fallback.** No title from the surface: the generic sentence.
 *  2. **A surface that says what failed.** Its own title and hint, and a retry
 *     whose promise takes 1.5 s, so the busy state (shown after 150 ms, never
 *     disabled, width held) can be seen and pressed twice.
 *  3. **With a further action.** A retry beside „Filter zurücksetzen", the
 *     shape the feedback health card uses.
 *  4. **Counts.** 0, 7, 99, 100 and 12 345 in both tones: from 100 the pill
 *     reads „99+" and the exact figure moves to `title` and the screen reader.
 *
 * Pinned to German (`I18nProvider initialLocale="de" fixedLocale`): the copy
 * under review is the German copy. 404s outside development.
 */

import { notFound } from 'next/navigation'
import { I18nProvider } from '@/i18n'
import { Button } from '@/components/ui/button'
import { CountPill } from '@/components/ui/count-pill'
import { LoadError } from '@/components/ui/load-error'

const slowRetry = () => new Promise<void>((resolve) => window.setTimeout(resolve, 1500))

const COUNTS = [0, 7, 99, 100, 12345]

function Panel({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="flex w-[560px] max-w-full flex-col gap-2">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="text-xs text-muted-foreground">{note}</p>
      <div className="rounded-lg border bg-card p-4">{children}</div>
    </section>
  )
}

export default function LoadErrorPreview() {
  if (process.env.NODE_ENV !== 'development') notFound()

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <div data-testid="load-error-preview" className="flex min-h-screen flex-col items-center gap-10 bg-background p-10">
        <Panel title="Ohne eigenen Titel" note="Der allgemeine Satz, wenn die Fläche nicht sagen kann, was fehlt.">
          <LoadError onRetry={slowRetry} />
        </Panel>

        <Panel
          title="Die Fläche sagt, was nicht geladen hat"
          note="Eigener Titel und Hinweis. Der Knopf bleibt fokussiert und gleich breit, während er lädt, und zeigt „Wird erneut geladen …“ erst nach 150 ms."
        >
          <LoadError
            title="Budgets konnten nicht geladen werden"
            description="Die Verbrauchszahlen sind gerade nicht erreichbar. Die Grenzen selbst sind unverändert."
            onRetry={slowRetry}
          />
        </Panel>

        <Panel title="Mit einer weiteren Aktion" note="Erneut versuchen und eine zweite Möglichkeit daneben.">
          <LoadError
            title="Rückmeldungen konnten nicht geladen werden"
            onRetry={slowRetry}
            actions={
              <Button size="sm" variant="ghost">
                Filter zurücksetzen
              </Button>
            }
          />
        </Panel>

        <Panel
          title="Zählungen mit Obergrenze"
          note="Ab 100 steht „99+“; die genaue Zahl liegt im Tooltip und beim Screenreader. Die Pille wird nie breiter als „99+“."
        >
          <div className="flex flex-col gap-3">
            {(['muted', 'attention'] as const).map((tone) => (
              <div key={tone} className="flex items-center gap-3">
                <span className="w-20 text-xs text-muted-foreground">{tone}</span>
                {COUNTS.map((count) => (
                  <CountPill key={count} tone={tone} count={count} />
                ))}
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </I18nProvider>
  )
}
