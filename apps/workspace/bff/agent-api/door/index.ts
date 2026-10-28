/**
 * What an outside agent can read about Piloti before its first call, and the
 * workflows a person can start from their client: the door's MCP resources and
 * prompts.
 *
 * The four meta-tools answer "how do I do X"; nothing answered "what is here".
 * Agents dogfooding the door spent their first calls learning the workspace by
 * trial: which project a person means, where an id comes from, which reading
 * operation to use. An agent does not search for what it cannot see, so the
 * door says it once, in three resources:
 *
 * - `piloti://guide`: how the workspace fits together and how ids flow;
 * - `piloti://glossary`: the office's German words and the catalog's English ones;
 * - `piloti://catalog`: every operation this caller may run, by domain.
 *
 * And prompts: workflows an architect starts often, and any of the office's own
 * skills by name. A prompt states the goal, the constraints and what a good
 * answer is, never a sequence of calls: the agent finds the operations.
 *
 * The prose lives in the Markdown files beside this module (`guide.md`,
 * `glossary.md`, `prompts/*.md`), embedded by `docs.spec.ts`. The catalog and
 * the search vocabulary are read at request time, so neither can drift.
 */

import { type McpServer, ResourceTemplate, completable, fromJsonSchema } from '@modelcontextprotocol/server'
import { SKILL_SEARCH_MAX } from '@/lib/skills/types'
import vocabulary from '@/lib/text/operation-search-vocabulary.json'
import { readOperationBody } from '../discovery'
import { audienceOf } from '../exposure'
import { PROMPT_ICONS, RESOURCE_ICONS } from '../icons'
import { AGENT_DOMAINS, annotationsOf } from '../operation'
import { doorOfPrincipal, findVisibleOperation, visibleBackendOperations, visibleOperations } from '../policy'
import type { McpCallContext } from '../telemetry'
import { DOOR_DOCS, type DoorDoc } from './docs.generated'

export const GUIDE_URI = 'piloti://guide'
export const GLOSSARY_URI = 'piloti://glossary'
export const CATALOG_URI = 'piloti://catalog'
export const PROJECT_URI_TEMPLATE = 'piloti://project/{projectId}'

/** `{{name}}` in a prompt's Markdown, replaced by the argument of that name. */
const PLACEHOLDER = /\{\{(\w+)\}\}/g

/** The arguments a doc's text asks for, in order of first use. */
export function placeholdersOf(doc: DoorDoc): string[] {
  return [...new Set([...DOOR_DOCS[doc].matchAll(PLACEHOLDER)].map((match) => match[1]))]
}

export function fillDoc(doc: DoorDoc, values: Readonly<Record<string, string | undefined>>): string {
  return DOOR_DOCS[doc].replace(PLACEHOLDER, (_, key: string) => values[key]?.trim() ?? '')
}

/** The glossary: its Markdown, then every term of the search vocabulary (domain data) and the catalog words it finds. */
export function glossaryText(): string {
  const search = Object.entries(vocabulary.terms as Record<string, string[]>)
    .map(([term, meanings]) => `- ${term}: ${meanings.join(', ')}`)
    .join('\n')
  return `${DOOR_DOCS['glossary.md'].trimEnd()}\n\n${search}\n`
}

/** Every operation `ctx`'s caller may run, by domain: its name, whether it reads or writes, and its summary. */
export function catalogText(ctx: McpCallContext): string {
  const rows = [
    ...visibleOperations(ctx.principal).map((op) => ({ name: op.name, domain: op.domain, summary: op.summary, read: annotationsOf(op).readOnlyHint === true })),
    ...visibleBackendOperations(ctx.principal).map((op) => ({ name: op.name, domain: op.domain, summary: op.summary, read: op.annotations.readOnlyHint === true })),
  ]
  const domains = [...new Set<string>([...AGENT_DOMAINS, ...rows.map((row) => row.domain)])]
  const sections = domains.flatMap((domain) => {
    const ops = rows.filter((row) => row.domain === domain).sort((a, b) => a.name.localeCompare(b.name))
    if (ops.length === 0) return []
    return [`## ${domain}\n\n${ops.map((op) => `- \`${op.name}\` (${op.read ? 'read' : 'write'}): ${op.summary}`).join('\n')}\n`]
  })
  return `# Operations you can run\n\nRun one with call-operation; describe-operation shows its input.\n\n${sections.join('\n')}`
}

/** A workflow a person starts from their client. Its text is `prompts/<name>.md`; its arguments, the placeholders there. */
interface DoorPrompt {
  name: string
  title: string
  description: string
  /** What to put in each placeholder of its Markdown. */
  args: Readonly<Record<string, string>>
}

const PROJECT = 'The project: its name, the name people call it, or its id.'

export const DOOR_PROMPTS: readonly DoorPrompt[] = [
  {
    name: 'project-briefing',
    title: 'Brief me on a project',
    description: 'Where a project stands: what is decided, what is open, and who it waits on.',
    args: { project: PROJECT },
  },
  {
    name: 'building-law-check',
    title: 'Check a question against building law',
    description: 'What the OIB guidelines and Austrian law require of a project, quoted at the clause.',
    args: { project: PROJECT, question: 'What to check, in the words the person would use, e.g. "escape routes".' },
  },
  {
    name: 'my-day',
    title: 'What is on my plate',
    description: 'What waits for the signed-in person across projects: decisions first, then news.',
    args: {},
  },
]

export const promptDoc = (name: string): DoorDoc => `prompts/${name}.md` as DoorDoc

/** Values an argument may take, for the client's autocomplete; at most {@link COMPLETION_LIMIT}. */
type Completer = (value: string) => Promise<string[]>

export const COMPLETION_LIMIT = 20

interface ListedProject {
  id: string
  name: string
  projectName?: string | null
  status?: string
  siteAddress?: string | null
}

/** The projects `ctx`'s caller may open whose name or profile name contains `value`, as project-list answers. */
async function projectsMatching(ctx: McpCallContext, value: string): Promise<ListedProject[]> {
  const query = value.trim() ? { nameContains: value.trim() } : {}
  const read = await readOperationBody(ctx, 'project-list', { query })
  return 'refusal' in read || !Array.isArray(read.body) ? [] : (read.body as ListedProject[])
}

/** Completers by argument name: a project by the name people use, a skill by its name. */
function completersFor(ctx: McpCallContext): Readonly<Record<string, Completer>> {
  return {
    project: async (value) =>
      [...new Set((await projectsMatching(ctx, value)).map((project) => project.projectName ?? project.name))].slice(0, COMPLETION_LIMIT),
    skill: async (value) => {
      const wanted = value.trim().toLowerCase()
      return (await skillNames(ctx)).filter((name) => name.toLowerCase().includes(wanted)).slice(0, COMPLETION_LIMIT)
    },
  }
}

/**
 * Prompt arguments as the SDK takes them: each a required string with its
 * description, completed where a completer knows its values.
 *
 * The SDK lists arguments from the schema's JSON Schema and finds a completer
 * on the schema's `shape`, as a Zod 4 object has it. The repo is on Zod 3, whose
 * bundled v4 lacks the JSON Schema the listing needs, so the schema is
 * `fromJsonSchema` and `shape` carries only the completers. `index.spec.ts`
 * completes an argument through the SDK, so a change in that lookup fails there.
 */
function argsSchema(args: Readonly<Record<string, string>>, completers: Readonly<Record<string, Completer>>) {
  const properties = Object.fromEntries(Object.entries(args).map(([key, description]) => [key, { type: 'string', description }]))
  const schema = fromJsonSchema({ type: 'object', properties, required: Object.keys(args), additionalProperties: false } as Parameters<typeof fromJsonSchema>[0])
  const shape = Object.fromEntries(
    Object.keys(args).flatMap((key) => {
      const complete = completers[key]
      return complete ? [[key, completable(fromJsonSchema({ type: 'string' }), (value) => complete(String(value ?? '')))]] : []
    }),
  )
  return Object.assign(schema, { shape })
}

const userMessage = (text: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] })

/** The names of the office's enabled skills, as skill-search lists them for an empty query. */
async function skillNames(ctx: McpCallContext): Promise<string[]> {
  const read = await readOperationBody(ctx, 'skill-search', { query: { limit: SKILL_SEARCH_MAX } })
  if ('refusal' in read) return []
  return ((read.body as { skills?: { name: string }[] } | null)?.skills ?? []).map((skill) => skill.name)
}

/** The text of the `office-skill` prompt for `name`, read through the door as the person with skill-get. */
async function officeSkillText(ctx: McpCallContext, name: string): Promise<string> {
  const read = await readOperationBody(ctx, 'skill-get', { params: { name: name.trim() } })
  const skill = 'refusal' in read ? null : (read.body as { skill?: { name: string; body: string } } | null)?.skill
  if (skill?.body) return fillDoc('prompts/office-skill.md', { skill: skill.name, body: skill.body })
  const names = (await skillNames(ctx)).join(', ')
  return `No enabled skill is named "${name}". The office's skills: ${names || 'none'}.`
}

/** Whether `ctx`'s caller is offered the door's resources and prompts at all. */
export function offersDoorGuide(ctx: McpCallContext): boolean {
  return doorOfPrincipal(ctx.principal) === 'office' && audienceOf(ctx.principal) === 'external'
}

/** Whether `ctx`'s caller is offered `piloti://project/{projectId}`: the one resource that changes, so the only one to listen to. */
export function offersProjectResource(ctx: McpCallContext): boolean {
  return offersDoorGuide(ctx) && findVisibleOperation(ctx.principal, 'project-overview-get') !== undefined
}

/** At most this many URIs per listen request; the rest are not honored. Each is one read of an overview. */
export const MAX_RESOURCE_SUBSCRIPTIONS = 50

const PROJECT_URI = /^piloti:\/\/project\/([A-Za-z0-9_-]{1,120})$/

/**
 * The URIs among `uris` that `ctx`'s caller may listen to: a project they can
 * read, decided by the read `resources/read` makes (project-overview-get, whose
 * route checks the person's access). The SDK filters a listen stream by the URIs
 * the client names and checks nothing, so a URI that fails here is dropped before
 * the SDK sees it, and the acknowledgement shows only what was honored.
 */
export async function readableProjectUris(ctx: McpCallContext, uris: readonly string[]): Promise<string[]> {
  if (!offersProjectResource(ctx)) return []
  const candidates = [...new Set(uris)].filter((uri) => PROJECT_URI.test(uri)).slice(0, MAX_RESOURCE_SUBSCRIPTIONS)
  const readable = await Promise.all(
    candidates.map(async (uri) => {
      const id = PROJECT_URI.exec(uri)?.[1] ?? ''
      const read = await readOperationBody(ctx, 'project-overview-get', { params: { id } })
      return 'refusal' in read ? null : uri
    }),
  )
  return readable.filter((uri): uri is string => uri !== null)
}

/**
 * Registers the door's resources and prompts for an outside agent's client.
 * Piloti's own client reads neither (the guide names operations its door leaves
 * to its native tools); the platform door is a different workspace.
 */
export function registerDoorGuide(server: McpServer, ctx: McpCallContext): void {
  if (!offersDoorGuide(ctx)) return
  const markdown = (uri: string, text: string) => ({ contents: [{ uri, mimeType: 'text/markdown', text }] })
  const completers = completersFor(ctx)
  server.registerResource(
    'guide',
    GUIDE_URI,
    { title: 'Working in Piloti', description: 'How the workspace fits together, how ids flow, and which operation reads what.', mimeType: 'text/markdown', icons: RESOURCE_ICONS.guide },
    async () => markdown(GUIDE_URI, DOOR_DOCS['guide.md']),
  )
  server.registerResource(
    'glossary',
    GLOSSARY_URI,
    { title: 'Piloti glossary', description: 'The office’s German words and the catalog’s English ones.', mimeType: 'text/markdown', icons: RESOURCE_ICONS.glossary },
    async () => markdown(GLOSSARY_URI, glossaryText()),
  )
  server.registerResource(
    'catalog',
    CATALOG_URI,
    { title: 'Operations you can run', description: 'Every operation this connection may run, by domain, and whether it reads or writes.', mimeType: 'text/markdown', icons: RESOURCE_ICONS.catalog },
    async () => markdown(CATALOG_URI, catalogText(ctx)),
  )
  if (findVisibleOperation(ctx.principal, 'project-overview-get')) registerProjectResource(server, ctx)
  for (const prompt of DOOR_PROMPTS) {
    const doc = promptDoc(prompt.name)
    const config = { title: prompt.title, description: prompt.description, icons: PROMPT_ICONS[prompt.name as keyof typeof PROMPT_ICONS] }
    if (Object.keys(prompt.args).length === 0) {
      server.registerPrompt(prompt.name, config, () => userMessage(fillDoc(doc, {})))
    } else {
      server.registerPrompt(prompt.name, { ...config, argsSchema: argsSchema(prompt.args, completers) }, (args) =>
        userMessage(fillDoc(doc, args as Record<string, string | undefined>)),
      )
    }
  }
  if (findVisibleOperation(ctx.principal, 'skill-get')) {
    server.registerPrompt(
      'office-skill',
      {
        title: 'Use one of the office’s skills',
        description: 'Follow one of the office’s own written procedures, by its name.',
        icons: PROMPT_ICONS['office-skill'],
        argsSchema: argsSchema({ skill: 'The skill’s name, as the skills page in Piloti shows it.' }, completers),
      },
      async (args) => userMessage(await officeSkillText(ctx, String((args as { skill?: unknown }).skill ?? ''))),
    )
  }
}

/**
 * `piloti://project/{projectId}`: a project a person can attach to their
 * conversation in the client, listed by the name people use. Reading it answers
 * the project's overview (project-overview-get), read as the person.
 */
function registerProjectResource(server: McpServer, ctx: McpCallContext): void {
  const template = new ResourceTemplate(PROJECT_URI_TEMPLATE, {
    list: async () => ({
      resources: (await projectsMatching(ctx, '')).map((project) => ({
        uri: `piloti://project/${project.id}`,
        name: project.projectName ?? project.name,
        description: [project.name, project.status, project.siteAddress].filter(Boolean).join(' · '),
        mimeType: 'application/json',
      })),
    }),
    complete: {
      projectId: async (value) =>
        (await projectsMatching(ctx, '')).map((project) => project.id).filter((id) => id.startsWith(value)).slice(0, COMPLETION_LIMIT),
    },
  })
  server.registerResource(
    'project',
    template,
    { title: 'A project', description: 'One project’s overview: its profile summary, counts and latest activity.', mimeType: 'application/json', icons: RESOURCE_ICONS.project },
    async (uri, variables) => {
      const id = String(variables.projectId ?? '')
      const read = await readOperationBody(ctx, 'project-overview-get', { params: { id } })
      const text = 'refusal' in read ? JSON.stringify({ error: read.refusal }) : JSON.stringify(read.body)
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text }] }
    },
  )
}
