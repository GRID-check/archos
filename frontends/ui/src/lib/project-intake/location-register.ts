/**
 * The location register (ticket 26: „Der Standort bestimmt den
 * Informationsbedarf – nach Bundesland, Gemeinde, Stichtag und Vorhaben"):
 * which location determinants matter for this project, and which document to
 * ask for when a determinant's value is missing, each with its reason and its
 * source. Pure; `view.ts` hands its result to step 4, Rückfragen.
 *
 * The register is DATA ({@link LOCATION_REGISTER}). Each entry names the
 * profile keys it settles (the wizard's own, so an answer, a document's value
 * and „nicht bekannt" all settle it), when it applies (Vorhaben, Nutzungen, a
 * Bestand), the document, the reason, and per Bundesland or Gemeinde only what
 * differs there. Austria only: the catalogue is Austria's.
 *
 * Law is cited by its title. A section number from memory is marked
 * `needsReview` and the entry stays conservative: it asks for the document
 * rather than concluding anything from its absence. What is not modelled: the
 * Stichtag (editions of the law per date are corpus work, deferred by the
 * ticket), Standortdienste (BEV, Landes-GIS, HORA), and Gemeinde-level plans
 * beyond the two Altstadt laws below.
 */

import { BUNDESLAND_TOKENS, FOUND_IN } from '@/lib/project-profile/intake-definition'
import type { ProjectPrimitiveValue, ProjectProfile } from '@/lib/project-profile/types'
import type {
  DocumentRequest,
  IntakeMode,
  LocationDeterminant,
  LocationRegisterView,
  Need,
  RegisterSource,
} from './types'

/** The Bundesländer, by the wizard's `A2_land` tokens. */
export type Bundesland =
  | 'wien'
  | 'niederoesterreich'
  | 'oberoesterreich'
  | 'steiermark'
  | 'kaernten'
  | 'salzburg'
  | 'tirol'
  | 'vorarlberg'
  | 'burgenland'

/**
 * When an entry applies. Each clause means „includes any of"; an input not
 * known yet counts as applying, so the register asks rather than misses.
 */
export interface AppliesWhen {
  /** `vorhabensart` (A5). */
  vorhaben?: readonly string[]
  /** `nutzungen@bwN` (D0), of any Bauwerk. */
  nutzungen?: readonly string[]
  /** Only when a Bauwerk is a Bestand (`errichtungsstatus@bwN = bestand`); its keys are then per such Bauwerk. */
  bestand?: true
}

/** What differs in one Bundesland: the document's name there, the reason there, the law there. */
export interface RegisterVariant {
  document?: string
  reason?: string
  sources: readonly RegisterSource[]
}

/** A Gemeinde with law of its own on top of the Land's: a sentence added to the reason. */
export interface GemeindeAddition {
  bundesland: Bundesland
  /** The Gemeinde's name as the geocoder gives it („Graz"). */
  gemeinde: string
  addition: string
  sources: readonly RegisterSource[]
}

export interface RegisterEntry {
  determinant: LocationDeterminant
  label: string
  /** Profile keys, without scope; per Bestand-Bauwerk (`key@bwN`) when `appliesWhen.bestand`. */
  keys: readonly string[]
  appliesWhen: AppliesWhen
  document: string
  reason: string
  sources: readonly RegisterSource[]
  byBundesland?: Partial<Record<Bundesland, RegisterVariant>>
  byGemeinde?: readonly GemeindeAddition[]
}

const raumordnung = (title: string): RegisterVariant => ({
  sources: [{ title, reference: 'örtliche Raumplanung: Flächenwidmungsplan, Bebauungsplan', needsReview: true }],
})

/** The register, in the order step 4 lists its requests. */
export const LOCATION_REGISTER: readonly RegisterEntry[] = [
  {
    determinant: 'grundstueck',
    label: 'Grundstück, Fläche und Einlagezahl',
    keys: ['grundstueck_ez', 'grundstuecksflaeche'],
    appliesWhen: {},
    document: FOUND_IN.grundbuch,
    reason:
      'Der Grundbuchauszug nennt Einlagezahl und Katastralgemeinde, die Grundstücke mit ihrer Fläche, die Eigentümer und Lasten wie Dienstbarkeiten.',
    sources: [{ title: 'Allgemeines Grundbuchsgesetz 1955 (GBG 1955)', needsReview: true }],
  },
  {
    determinant: 'widmung',
    label: 'Widmung und Bebauungsbestimmungen',
    keys: ['flaechenwidmung', 'bebauungsplan'],
    appliesWhen: { vorhaben: ['neubau', 'zubau', 'umbau', 'nutzungsaenderung'] },
    document: 'Auszug aus Flächenwidmungs- und Bebauungsplan',
    reason:
      'Die Gemeinde legt im Flächenwidmungsplan fest, wofür das Grundstück genutzt werden darf, und im Bebauungsplan, wie hoch, wie dicht und wo gebaut werden darf. Nicht für jedes Grundstück gibt es einen Bebauungsplan.',
    sources: [{ title: 'Raumordnungsgesetz des Bundeslandes', needsReview: true }],
    byBundesland: {
      wien: {
        document: 'Plandokument (Flächenwidmungs- und Bebauungsplan)',
        reason:
          'In Wien legt ein Plandokument Widmung und Bebauungsbestimmungen gemeinsam fest: Widmung, Bauklasse, Bauweise, Fluchtlinien und Schutzzonen.',
        sources: [
          {
            title: 'Bauordnung für Wien (BO für Wien)',
            reference: '§§ 1–5 (Flächenwidmungs- und Bebauungspläne), § 7 (Schutzzonen)',
            needsReview: true,
          },
        ],
      },
      niederoesterreich: raumordnung('NÖ Raumordnungsgesetz 2014 (NÖ ROG 2014)'),
      oberoesterreich: raumordnung('Oö. Raumordnungsgesetz 1994 (Oö. ROG 1994)'),
      steiermark: raumordnung('Steiermärkisches Raumordnungsgesetz 2010 (StROG)'),
      kaernten: raumordnung('Kärntner Raumordnungsgesetz 2021 (K-ROG 2021)'),
      salzburg: raumordnung('Salzburger Raumordnungsgesetz 2009 (ROG 2009)'),
      tirol: raumordnung('Tiroler Raumordnungsgesetz 2022 (TROG 2022)'),
      vorarlberg: raumordnung('Vorarlberger Raumplanungsgesetz (RPG)'),
      burgenland: raumordnung('Burgenländisches Raumplanungsgesetz 2019 (Bgld. RPG 2019)'),
    },
    byGemeinde: [
      {
        bundesland: 'steiermark',
        gemeinde: 'Graz',
        addition: 'In der Grazer Altstadt kann zusätzlich eine Schutzzone nach dem Grazer Altstadterhaltungsgesetz gelten.',
        sources: [{ title: 'Grazer Altstadterhaltungsgesetz 2008 (GAEG 2008)', needsReview: true }],
      },
      {
        bundesland: 'salzburg',
        gemeinde: 'Salzburg',
        addition: 'In der Salzburger Altstadt gilt zusätzlich das Salzburger Altstadterhaltungsgesetz.',
        sources: [{ title: 'Salzburger Altstadterhaltungsgesetz 1980', needsReview: true }],
      },
    ],
  },
  {
    determinant: 'denkmalschutz',
    label: 'Denkmal- und Ortsbildschutz',
    keys: ['denkmalschutz'],
    appliesWhen: { bestand: true },
    document: 'Auszug aus der Denkmalliste oder Unterschutzstellungsbescheid',
    reason:
      'Ein Gebäude unter Denkmalschutz darf nur mit Bewilligung des Bundesdenkmalamts verändert werden. Ob es geschützt ist, steht in der Denkmalliste des Bundesdenkmalamts oder in einem Bescheid.',
    sources: [{ title: 'Denkmalschutzgesetz (DMSG)', needsReview: false }],
  },
  {
    determinant: 'standortrisiken',
    label: 'Naturgefahren und Altlasten',
    keys: ['gefahrenzonen'],
    appliesWhen: { vorhaben: ['neubau', 'zubau', 'abbruch'] },
    document: 'Auszug aus dem Gefahrenzonenplan, Auskunft aus dem Verdachtsflächenkataster',
    reason:
      'Gefahrenzonen der Wildbach- und Lawinenverbauung und Hochwasserabflussbereiche können Bauverbote oder Auflagen bedeuten; meist sind sie im Flächenwidmungsplan ersichtlich gemacht. Eine Altlast oder Verdachtsfläche betrifft Aushub, Abbruch und Gründung.',
    sources: [
      { title: 'Forstgesetz 1975', reference: '§ 11 (Gefahrenzonenpläne)', needsReview: true },
      { title: 'Wasserrechtsgesetz 1959 (WRG 1959)', reference: '§ 42a (Gefahrenzonenplanungen)', needsReview: true },
      {
        title: 'Altlastensanierungsgesetz (ALSAG)',
        reference: 'Verdachtsflächenkataster und Altlastenatlas des Umweltbundesamts',
        needsReview: true,
      },
    ],
  },
  {
    determinant: 'laerm',
    label: 'Lärm',
    keys: ['laermsituation'],
    appliesWhen: {
      vorhaben: ['neubau', 'zubau', 'umbau', 'sanierung', 'nutzungsaenderung'],
      nutzungen: ['wohnen', 'beherbergung', 'bildung', 'gesundheit', 'buero'],
    },
    document: 'Lärmgutachten oder Auszug aus der Lärmkarte',
    reason:
      'Der Außenlärm am Standort bestimmt, wie gut Fenster und Außenbauteile dämmen müssen. Die strategischen Lärmkarten für Straße, Bahn, Flugverkehr und Industrie zeigt lärminfo.at.',
    sources: [
      {
        title: 'OIB-Richtlinie 5, Schallschutz (Ausgabe 2023)',
        reference: 'Anforderungen an Außenbauteile nach dem maßgeblichen Außenlärmpegel',
        needsReview: true,
      },
      { title: 'Bundes-Umgebungslärmschutzgesetz (Bundes-LärmG)', reference: 'strategische Lärmkarten', needsReview: true },
    ],
  },
]

/** The register's own inputs: asked on step 4 while open, because they decide what else is asked. */
const REGISTER_INPUTS: Record<IntakeMode, readonly string[]> = {
  active: ['bundesland', 'vorhabensart'],
  // A past project: the Bundesland decides which law applied; nothing is requested.
  closing: ['bundesland'],
}

export interface LocationRegisterInput {
  profile: ProjectProfile
  /** The geocoder's result at creation (`project_intakes.location`), or null for a typed address. */
  location: { bundesland: string | null; gemeinde: string | null } | null
  mode: IntakeMode
  /** The project's needs (`computeNeeds`): a request carries the open ones among its keys. */
  needs: readonly Need[]
}

/** What the register reads off the profile. */
interface Situation {
  bundesland: Bundesland | null
  /** Country or Bundesland says the project is not in Austria: the register has nothing to say. */
  abroad: boolean
  gemeinde: string | null
  vorhaben: readonly string[] | null
  nutzungen: readonly string[] | null
  /** The Bauwerke described as Bestand (`bw1`, …). */
  bestand: readonly string[]
}

/** A key's value: the confirmed one, else the suggestion. */
function valueOf(profile: ProjectProfile, key: string): ProjectPrimitiveValue | undefined {
  return profile.facts[key]?.value ?? profile.assumptions[key]?.value
}

/** Every value under a base key, in any scope (`nutzungen@bw1`, `nutzungen@bw2`). */
function scopedValues(profile: ProjectProfile, baseKey: string): Array<{ key: string; value: ProjectPrimitiveValue }> {
  const keys = new Set([...Object.keys(profile.facts), ...Object.keys(profile.assumptions)])
  return [...keys]
    .filter((key) => key.split('@')[0] === baseKey)
    .map((key) => ({ key, value: valueOf(profile, key) }))
    .filter((entry): entry is { key: string; value: ProjectPrimitiveValue } => entry.value !== undefined)
}

const asList = (value: ProjectPrimitiveValue | undefined): string[] | null => {
  if (Array.isArray(value)) return value.length > 0 ? value : null
  return typeof value === 'string' && value ? [value] : null
}

function isBundesland(value: unknown): value is Bundesland {
  return typeof value === 'string' && value !== 'ausserhalb_oesterreichs' && BUNDESLAND_TOKENS.includes(value)
}

function situationOf(input: LocationRegisterInput): Situation {
  const { profile, location } = input
  const stated = valueOf(profile, 'bundesland')
  const country = valueOf(profile, 'country')
  const located = location?.bundesland
  const bundesland = isBundesland(stated) ? stated : isBundesland(located) ? located : null
  const uses = scopedValues(profile, 'nutzungen').flatMap(({ value }) => asList(value) ?? [])
  return {
    bundesland,
    abroad: stated === 'ausserhalb_oesterreichs' || (typeof country === 'string' && country !== 'at'),
    gemeinde: location?.gemeinde ?? (bundesland === 'wien' ? 'Wien' : null),
    vorhaben: asList(valueOf(profile, 'vorhabensart')),
    nutzungen: uses.length > 0 ? [...new Set(uses)] : null,
    bestand: scopedValues(profile, 'errichtungsstatus')
      .filter(({ key, value }) => value === 'bestand' && key.includes('@'))
      .map(({ key }) => key.split('@')[1]),
  }
}

const meets = (known: readonly string[] | null, wanted: readonly string[] | undefined): boolean =>
  !wanted || known === null || known.some((value) => wanted.includes(value))

/** Whether an entry applies to the situation; unknown inputs count as applying. */
export function entryApplies(entry: RegisterEntry, situation: Pick<Situation, 'vorhaben' | 'nutzungen' | 'bestand'>): boolean {
  if (entry.appliesWhen.bestand && situation.bestand.length === 0) return false
  return meets(situation.vorhaben, entry.appliesWhen.vorhaben) && meets(situation.nutzungen, entry.appliesWhen.nutzungen)
}

function keysOf(entry: RegisterEntry, situation: Situation): string[] {
  if (!entry.appliesWhen.bestand) return [...entry.keys]
  return situation.bestand.flatMap((bauwerkId) => entry.keys.map((key) => `${key}@${bauwerkId}`))
}

/** Settled: a value, a suggestion, or „nicht bekannt". */
function settled(profile: ProjectProfile, key: string): boolean {
  return key in profile.facts || key in profile.assumptions || profile.unknowns.includes(key)
}

const sameName = (a: string, b: string) => a.localeCompare(b, 'de', { sensitivity: 'base' }) === 0

function requestFor(entry: RegisterEntry, situation: Situation, input: LocationRegisterInput): DocumentRequest | null {
  const keys = keysOf(entry, situation)
  if (keys.length === 0) return null
  const variant = situation.bundesland ? entry.byBundesland?.[situation.bundesland] : undefined
  const additions = (entry.byGemeinde ?? []).filter(
    (local) => local.bundesland === situation.bundesland && situation.gemeinde && sameName(local.gemeinde, situation.gemeinde)
  )
  const reason = [variant?.reason ?? entry.reason, ...additions.map((local) => local.addition)].join(' ')
  return {
    determinant: entry.determinant,
    label: entry.label,
    document: variant?.document ?? entry.document,
    reason,
    keys,
    needs: input.needs.filter((need) => keys.includes(need.key) && need.state === 'open'),
    satisfied: keys.every((key) => settled(input.profile, key)),
    sources: [...(variant?.sources ?? entry.sources), ...additions.flatMap((local) => local.sources)],
  }
}

/**
 * The register for one project: the Bundesland and Gemeinde it read, its own
 * inputs still open (the Bundesland always, decisive for everything else; the
 * Vorhaben for an active project), and the documents it asks for. A past
 * project (`closing`) is asked for no document: its values stay „nicht
 * bekannt" where its own documents are silent. A project outside Austria gets
 * nothing.
 */
export function locationRegisterFor(input: LocationRegisterInput): LocationRegisterView {
  const situation = situationOf(input)
  const empty: LocationRegisterView = { bundesland: null, gemeinde: null, questions: [], documentRequests: [] }
  if (situation.abroad) return empty
  const inputs = REGISTER_INPUTS[input.mode]
  const questions = inputs.flatMap((key) =>
    input.needs.filter((need) => need.key === key && need.state === 'open')
  )
  const documentRequests =
    input.mode === 'closing'
      ? []
      : LOCATION_REGISTER.filter((entry) => entryApplies(entry, situation))
          .map((entry) => requestFor(entry, situation, input))
          .filter((request): request is DocumentRequest => request !== null)
  return { bundesland: situation.bundesland, gemeinde: situation.gemeinde, questions, documentRequests }
}
