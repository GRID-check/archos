/**
 * What the projects-home search matches against.
 *
 * An architect on site does not remember a project by its registered name: they
 * remember the street, the town, the client. The name alone left "Linz" or
 * "Gemeinde Klosterneuburg" with no result for a project they open every week.
 * Everything below is already on the client (the page ships whole `Project`
 * rows), so widening the match costs no request.
 *
 * Pure on purpose: the rules (which fields count, how a multi-word query
 * behaves) are what is worth testing, and the grid only calls this.
 */
import type { Project } from '@/lib/db/schema/projects'

/** The fields of a project the search reads. */
export type SearchableProject = Pick<Project, 'name'> & Partial<Pick<Project, 'profile' | 'profileDisplay'>>

/** A fact value this short ("ja", "5") would match half the list on a substring. */
const MIN_FACT_TEXT = 3

function factTexts(project: SearchableProject): string[] {
  const facts = project.profile?.facts
  if (!facts) return []
  const texts: string[] = []
  for (const fact of Object.values(facts)) {
    const value = fact?.value
    if (typeof value === 'string') texts.push(value)
    else if (Array.isArray(value)) texts.push(...value)
  }
  return texts.filter((text) => text.trim().length >= MIN_FACT_TEXT)
}

/**
 * The lower-cased haystack for one project: name, the brief's summary and key
 * facts (address, Gemeinde, client as the brief states them), and the string
 * facts of the profile itself.
 */
export function projectSearchText(project: SearchableProject): string {
  const display = project.profileDisplay
  return [
    project.name,
    display?.summary,
    ...(display?.keyFacts ?? []).map((fact) => fact.value),
    ...factTexts(project),
  ]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('\n')
    .toLowerCase()
}

/** Whitespace-separated words of a query, lower-cased; empty for a blank query. */
export function searchTokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

/**
 * Every word of the query appears somewhere in the project, in any order, so
 * "wohnbau wien" finds a Wohnbau in Wien and "wien wohnbau" finds the same one.
 */
export function projectMatchesQuery(project: SearchableProject, query: string): boolean {
  const tokens = searchTokens(query)
  if (tokens.length === 0) return true
  const haystack = projectSearchText(project)
  return tokens.every((token) => haystack.includes(token))
}
