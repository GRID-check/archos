'use client'

/**
 * Dev preview — the Aufgaben list, in the states a project's delegated work
 * actually arrives in.
 *
 *  1. **A mixed list.** What a project that uses Piloti looks like after a
 *     fortnight: something running, something waiting for a person, something
 *     that was sent back with words, something that failed. What the shot is
 *     for is the CARD — the status swatch on the title line (the same rounded
 *     square the timetable's legend uses), the compact run line under the
 *     title (the block's own glyph, word and tallies, on the running, the
 *     finished and the failed card alike), the unreviewed dot, the recency
 *     headings that group the column, the filter row with its counts, and the
 *     one result link on the tray that is the only thing inside the card that
 *     is not the card's own click target.
 *  2. **A card that changes place.** Two buttons stand in for a poll: a new
 *     run arrives at the top, or midnight moves a card from „Heute" to
 *     „Gestern". The card that moved glides there on `springGlide` and the
 *     cards around it make room; pressing a filter still only fades. Record it
 *     slowed down (`Animation.setPlaybackRate`) to judge the glide.
 *  3. **Nothing yet.** The state most projects are in on day one, and the one
 *     that has to read as an invitation rather than as a list that failed to
 *     load — the distinction the error panel underneath it depends on.
 *
 * Pinned to German (`I18nProvider initialLocale="de" fixedLocale`): the copy
 * under review is the German copy. 404s outside development.
 */

import { useState } from 'react'
import { notFound } from 'next/navigation'
import { I18nProvider } from '@/i18n'
import { Button } from '@/components/ui/button'
import { TaskList } from '@/features/tasks/components/task-list'
import type { TaskFilter, TaskRunView } from '@/features/tasks/lib/task-view'

const row = (overrides: Partial<TaskRunView>): TaskRunView => ({
  id: 'task-0',
  kind: 'document',
  title: 'Aktenvermerk',
  goal: null,
  status: 'succeeded',
  review: null,
  reviewReason: null,
  filedDocumentId: null,
  conversationId: null,
  runMessageId: null,
  taskId: null,
  trigger: 'delegated',
  requesterUserId: 'user_anna',
  requesterName: 'Anna Berger',
  createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  finishedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  error: null,
  ...overrides,
})

const TASKS: TaskRunView[] = [
  row({
    id: 'task-1',
    kind: 'revision',
    title: 'Brandschutzkonzept — Fluchtwege, zweite Fassung',
    goal: 'Die Fluchtweglänge im Atrium stimmt nicht; OIB 2.3 gilt hier, nicht 2.',
    status: 'running',
    requesterName: 'Maria Huber',
    runSummary: { status: 'running', rounds: 3, docs: 9 },
  }),
  row({
    id: 'task-1b',
    kind: 'deep-research',
    title: 'Wöchentlicher OIB-Brandschutz-Scan',
    goal: null,
    trigger: 'schedule',
    requesterName: null,
  }),
  row({
    id: 'task-2',
    kind: 'document',
    title: 'Aktenvermerk Stellplatzverpflichtung',
    goal: 'Fasse zusammen, was für die Einreichung an Stellplätzen nachzuweisen ist',
    filedDocumentId: 'doc-9',
    review: 'accepted',
    conversationId: 'conv-2',
    runMessageId: 'msg-2',
    runSummary: { status: 'done', rounds: 4, docs: 11 },
  }),
  row({
    id: 'task-3',
    kind: 'submission_check',
    title: 'Einreichcheck vor Abgabe',
    goal: 'Was fehlt noch für die Einreichung am 30.9.?',
    review: 'rejected',
    reviewReason:
      'Der Nachweis für die Barrierefreiheit ist übersehen worden — bitte mit OIB 4 gegenprüfen.',
    conversationId: 'conv-3',
    createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
  }),
  row({
    id: 'task-4',
    kind: 'compliance_check',
    title: 'Normprüfung Bestandsplan',
    status: 'failed',
    error: 'Das Budget war aufgebraucht, bevor die Prüfung fertig war.',
    requesterName: null,
    createdAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
    finishedAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000 + 20 * 60 * 1000).toISOString(),
    conversationId: 'conv-4',
    runMessageId: 'msg-4',
    runSummary: { status: 'failed', rounds: 2, docs: 5 },
  }),
]

/**
 * The filter row is stateful, and a preview that pinned it to `all` would be
 * evidence of a control nobody can press. One holder per panel, so each panel
 * filters independently.
 */
function FilterableList({
  tasks,
  loading,
  failed,
}: {
  tasks: TaskRunView[]
  loading?: boolean
  failed?: boolean
}) {
  const [filter, setFilter] = useState<TaskFilter>('all')
  return (
    <TaskList
      projectId="preview"
      tasks={tasks}
      loading={loading}
      failed={failed}
      filter={filter}
      onFilterChange={setFilter}
      onSelectTask={() => {}}
    />
  )
}

const ARRIVING = row({
  id: 'task-new',
  kind: 'deep-research',
  title: 'Recherche Lärmschutz Innenhof',
  goal: 'Welche Grenzwerte gelten für den Innenhof zur Nachbarliegenschaft?',
  status: 'running',
  createdAt: new Date().toISOString(),
  finishedAt: null,
  runSummary: { status: 'running', rounds: 1, docs: 2 },
})

/**
 * The poll, by hand. Each press changes what a poll would change and nothing
 * else, so the only motion on screen is the card that moved and the cards that
 * make room for it.
 */
function GlidingList() {
  const [tasks, setTasks] = useState<TaskRunView[]>(TASKS)
  const arrived = tasks.some((task) => task.id === ARRIVING.id)
  const aged = tasks.some((task) => task.id === 'task-2' && task.createdAt !== TASKS[2]?.createdAt)

  const toggleArrival = () =>
    setTasks((current) => (arrived ? current.filter((task) => task.id !== ARRIVING.id) : [ARRIVING, ...current]))
  const toggleMidnight = () =>
    setTasks((current) =>
      current.map((task) =>
        task.id === 'task-2'
          ? {
              ...task,
              createdAt: aged
                ? (TASKS[2]?.createdAt ?? task.createdAt)
                : new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
            }
          : task
      )
    )

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap gap-2 border-b p-3">
        <Button size="sm" variant="outline" onClick={toggleArrival} data-testid="glide-arrival">
          {arrived ? 'Neuen Lauf wieder entfernen' : 'Ein neuer Lauf kommt an'}
        </Button>
        <Button size="sm" variant="outline" onClick={toggleMidnight} data-testid="glide-midnight">
          {aged ? 'Zurück auf heute' : 'Mitternacht vergeht'}
        </Button>
      </div>
      <FilterableList tasks={tasks} />
    </div>
  )
}

function Panel({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="flex w-[720px] max-w-full flex-col gap-2">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="text-xs text-muted-foreground">{note}</p>
      <div className="rounded-lg border bg-card">{children}</div>
    </section>
  )
}

export default function TaskListPreview() {
  if (process.env.NODE_ENV !== 'development') notFound()

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <div
        data-testid="task-list-preview"
        className="flex min-h-screen flex-col items-center gap-10 bg-background p-10"
      >
        <Panel
          title="Was gerade läuft, und was schon beurteilt ist"
          note="Fünf Karten, fünf verschiedene Antworten auf „was ist daraus geworden“. Zu beurteilen: ob das Farbquadrat vor dem Titel beim Überfliegen einer Spalte trägt, ohne lauter zu sein als der Titel selbst; ob der Punkt rechts als „noch ungeprüft“ liest; ob „Zurückgeschickt“ und die Begründung darunter zusammengehören; und ob der eine Link in der Fußzeile als Ort liest — er ist das Einzige in der Karte, das nicht die Karte selbst anklickt."
        >
          <FilterableList tasks={TASKS} />
        </Panel>

        <Panel
          title="Eine Karte wechselt ihren Platz"
          note="Die zwei Knöpfe tun, was eine Abfrage täte. Zu beurteilen: ob die Karte, die sich bewegt hat, dorthin gleitet und die übrigen Platz machen, ohne zu springen; und ob ein Druck auf einen Filter weiterhin nur überblendet und nichts fliegen lässt."
        >
          <GlidingList />
        </Panel>

        <Panel
          title="Noch nichts übergeben"
          note="Der Zustand am ersten Tag. Er muss als Einladung lesen, nicht als Liste, die nicht geladen hat — genau diesen Unterschied trägt der Fehlerzustand darunter."
        >
          <FilterableList tasks={[]} />
        </Panel>

        <Panel
          title="Die Liste konnte nicht geladen werden"
          note="Der Unterschied zum Zustand darüber ist die eine Lüge, auf die jemand hin handeln würde."
        >
          <FilterableList tasks={[]} failed />
        </Panel>
      </div>
    </I18nProvider>
  )
}
