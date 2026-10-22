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

import { type McpServer, fromJsonSchema } from '@modelcontextprotocol/server'
import vocabulary from '@/lib/text/operation-search-vocabulary.json'
import { readOperationBody } from '../discovery'
import { audienceOf } from '../exposure'
import { AGENT_DOMAINS, annotationsOf } from '../operation'
import { doorOfPrincipal, findVisibleOperation, visibleBackendOperations, visibleOperations } from '../policy'
import type { McpCallContext } from '../telemetry'
import { DOOR_DOCS, type DoorDoc } from './docs.generated'

export const GUIDE_URI = 'piloti://guide'
export const GLOSSARY_URI = 'piloti://glossary'
export const CATALOG_URI = 'piloti://catalog'

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

/** Prompt arguments as the SDK takes them: each a required string with its description. */
function argsSchema(args: Readonly<Record<string, string>>) {
  const properties = Object.fromEntries(Object.entries(args).map(([key, description]) => [key, { type: 'string', description }]))
  return fromJsonSchema({ type: 'object', properties, required: Object.keys(args), additionalProperties: false } as Parameters<typeof fromJsonSchema>[0])
}

const userMessage = (text: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] })

interface ListedSkill {
  name: string
  body?: string
  enabled?: boolean
}

/** The text of the `office-skill` prompt for `name`, read through the door as the person. */
async function officeSkillText(ctx: McpCallContext, name: string): Promise<string> {
  const read = await readOperationBody(ctx, 'skill-list', {})
  if ('refusal' in read) return read.refusal
  const skills = ((read.body as { skills?: ListedSkill[] } | null)?.skills ?? []).filter((skill) => skill.enabled !== false)
  const skill = skills.find((s) => s.name.toLowerCase() === name.trim().toLowerCase())
  if (skill?.body) return fillDoc('prompts/office-skill.md', { skill: skill.name, body: skill.body })
  const names = skills.map((s) => s.name).slice(0, 40).join(', ')
  return `No enabled skill is named "${name}". The office's skills: ${names || 'none'}.`
}

/**
 * Registers the door's resources and prompts for an outside agent's client.
 * Piloti's own client reads neither (the guide names operations its door leaves
 * to its native tools); the platform door is a different workspace.
 */
export function registerDoorGuide(server: McpServer, ctx: McpCallContext): void {
  if (doorOfPrincipal(ctx.principal) !== 'office' || audienceOf(ctx.principal) !== 'external') return
  const markdown = (uri: string, text: string) => ({ contents: [{ uri, mimeType: 'text/markdown', text }] })
  server.registerResource(
    'guide',
    GUIDE_URI,
    { title: 'Working in Piloti', description: 'How the workspace fits together, how ids flow, and which operation reads what.', mimeType: 'text/markdown' },
    async () => markdown(GUIDE_URI, DOOR_DOCS['guide.md']),
  )
  server.registerResource(
    'glossary',
    GLOSSARY_URI,
    { title: 'Piloti glossary', description: 'The office’s German words and the catalog’s English ones.', mimeType: 'text/markdown' },
    async () => markdown(GLOSSARY_URI, glossaryText()),
  )
  server.registerResource(
    'catalog',
    CATALOG_URI,
    { title: 'Operations you can run', description: 'Every operation this connection may run, by domain, and whether it reads or writes.', mimeType: 'text/markdown' },
    async () => markdown(CATALOG_URI, catalogText(ctx)),
  )
  for (const prompt of DOOR_PROMPTS) {
    const doc = promptDoc(prompt.name)
    const config = { title: prompt.title, description: prompt.description }
    if (Object.keys(prompt.args).length === 0) {
      server.registerPrompt(prompt.name, config, () => userMessage(fillDoc(doc, {})))
    } else {
      server.registerPrompt(prompt.name, { ...config, argsSchema: argsSchema(prompt.args) }, (args) =>
        userMessage(fillDoc(doc, args as Record<string, string | undefined>)),
      )
    }
  }
  if (findVisibleOperation(ctx.principal, 'skill-list')) {
    server.registerPrompt(
      'office-skill',
      {
        title: 'Use one of the office’s skills',
        description: 'Follow one of the office’s own written procedures, by its name.',
        argsSchema: argsSchema({ skill: 'The skill’s name, as the skills page in Piloti shows it.' }),
      },
      async (args) => userMessage(await officeSkillText(ctx, String((args as { skill?: unknown }).skill ?? ''))),
    )
  }
}
