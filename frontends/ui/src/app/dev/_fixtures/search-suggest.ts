/**
 * The `/dev/search` preview's completions (`POST /api/search/suggest` in the
 * product): what the fixture office's documents hold for each free-text
 * filter, with counts, matched on the start of any word as the server folds
 * it (`foldForSuggest`). Not narrowed by the other filters: the preview shows
 * the field's behaviour, and the integration spec holds the counting.
 */

import type { FacetCount } from '@/lib/search/search-wire'
import { foldForSuggest } from '@/lib/search/suggest-fold'
import type { SuggestQuestion } from '@/features/search/hooks/use-filter-suggestions'

const value = (text: string, count: number, label: string = text): FacetCount => ({
  value: text,
  label,
  count,
})

const PARTIES: Record<string, FacetCount[]> = {
  architect: [value('Atelier Lindner ZT GmbH', 14), value('Atelier Nord Architekten', 2)],
  client: [value('Wohnbau Hernals GmbH', 9), value('Gemeinde Wien MA 56', 3)],
  engineer: [
    value('Haas Tragwerksplanung ZT GmbH', 4),
    value('Ingenieurbüro Süd', 2),
    value('Brandschutz Hofer & Partner', 1),
  ],
  authority: [value('Magistrat Wien MA 37', 2), value('Magistrat Wien MA 64', 1)],
}

const VALUES: Record<Exclude<SuggestQuestion['dimension'], 'party' | 'fact'>, FacetCount[]> = {
  place: [value('Wien', 13), value('Hernalser Hauptstraße 12', 9), value('Wien-Hernals', 4)],
  cites: [
    value('norm:oib-rl 2', 5, 'OIB-RL 2'),
    value('norm:önorm b 1600', 3, 'ÖNORM B 1600'),
    value('norm:önorm b 2110', 1, 'ÖNORM B 2110'),
    value('norm:önorm en 1992-1-1', 1, 'ÖNORM EN 1992-1-1'),
    value('law:§ 33 wbo', 2, '§ 33 WBO'),
    value('plan:ep-05', 2, 'EP-05'),
    value('plan:ep-03', 1, 'EP-03'),
  ],
  scale: [value('1:100', 9), value('1:50', 2), value('1:500', 1)],
  planNumber: [
    value('EP-03', 2),
    value('EP-04', 2),
    value('EP-01', 1),
    value('EP-02', 1),
    value('EP-05', 1),
    value('EP-06', 1),
    value('TW-01', 1),
  ],
  planIndex: [value('A', 6), value('B', 4), value('C', 1)],
}

const FACTS: Record<string, FacetCount[]> = {
  building_class: [value('GK 4', 5), value('GK 3', 1)],
  use: [value('Wohnen', 8), value('Wohnen und Büro', 2), value('Kindergarten', 1)],
  construction_method: [value('Massivbau', 6), value('Holz-Hybridbau', 2)],
  energy_class: [value('A', 3), value('B', 1)],
}

const startsAWord = (text: string, prefix: string): boolean => {
  const start = foldForSuggest(prefix)
  return start === '' || ` ${foldForSuggest(text)}`.includes(` ${start}`)
}

/** The fixture's answer to one completion. */
export function searchFixtureSuggest(question: SuggestQuestion): FacetCount[] {
  const prefix = question.prefix ?? ''
  const pool =
    question.dimension === 'party'
      ? question.role
        ? (PARTIES[question.role] ?? [])
        : Object.values(PARTIES).flat()
      : question.dimension === 'fact'
        ? (FACTS[question.factKey ?? ''] ?? [])
        : VALUES[question.dimension]
  return pool
    .filter((entry) =>
      startsAWord(`${entry.label ?? ''} ${entry.value.slice(entry.value.indexOf(':') + 1)}`, prefix)
    )
    .sort((a, b) => b.count - a.count || (a.label ?? a.value).localeCompare(b.label ?? b.value))
    .slice(0, 10)
}
