'use client'

/**
 * FormulaCard — a named rule the reader can ask "what if" of, on the card.
 *
 * The model names the rule, the case it asks for and the inputs, each with its
 * source. This card compiles the rule to a Rechenweg (`../lib/formulas`),
 * evaluates it with `calculation`'s arithmetic, takes the bound from the
 * Richtlinie's table for that case, and draws the steps with the one
 * derivation renderer (`./Derivation`) (ADR-0143). Change the Dämmstärke and
 * the U-value, the Rechenweg and the verdict recompute once the reader pauses,
 * with no model call and nothing saved.
 *
 * Three promises the layout keeps:
 *
 *  - **Every number is computed, cited or the reader's own.** Results are
 *    computed here; each input says where its value is written; each bound
 *    names its Punkt and row. A value the reader changed is marked „Ihre
 *    Annahme" beside the source's value, beside every verdict resting on it,
 *    and beside the verdict in the header.
 *  - **The bound does not move.** It is the Richtlinie's, chosen by the case
 *    the model named, and has no control.
 *  - **Unknown is said, never guessed.** An input the source does not give is
 *    empty, and every verdict that needs it reads „kann nicht beurteilen"
 *    until the reader enters a value; a value the field refuses says so, not
 *    that one is missing.
 *
 * The verdict is carried by an icon and a word (`StatusBadge`), never by
 * colour alone. `presentational` in CARD_INTERACTIVITY: the inputs are one
 * reader's view state, bound into the A2UI surface's data model and nowhere
 * else (`features/a2ui/reader-inputs.ts`).
 */

import { useId, useMemo, useState, type FC } from 'react'
import { RotateCcw, SlidersHorizontal, UserPen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { QuantityInput, type QuantityIssue } from '@/components/ui/quantity-input'
import { SectionLabel } from '@/components/ui/section-label'
import { useReaderOverrides } from '@/features/a2ui/reader-inputs'
import { useTranslations, type Translator } from '@/i18n'
import {
  SchematicCard,
  StatusBadge,
  fmtComparator,
  missingLabel,
  provenanceLabel,
  provenanceTitle,
  statusLabel,
  worstStatus,
} from '../schematics/kit'
import { formatInput, formatResult } from '../lib/calculate'
import {
  FORMULA_SOURCES,
  changedInputs,
  compileFormula,
  inputSlots,
  judgeFormula,
  sourceValues,
  type CaveatKey,
  type CheckId,
  type CompiledFormula,
  type FormulaCardData,
  type FormulaWords,
  type InputLabel,
  type InputSlot,
  type JudgedFormula,
  type LimitCheck,
  type LineKey,
  type TermKey,
} from '../lib/formulas'
import { DerivationSteps } from './Derivation'

type FormulaCardProps = Pick<FormulaCardData, 'title' | 'formula' | 'note'>

const withUnit = (value: string, unit: string): string => (unit ? `${value} ${unit}` : value)

/* ── the words, spelled out so key-coverage.spec.ts can see every key ─────── */

const inputLabel = (key: InputLabel, t: Translator): string => {
  switch (key) {
    case 'riser':
      return t('cards.formula.input.riser')
    case 'going':
      return t('cards.formula.input.going')
    case 'thickness':
      return t('cards.formula.input.thickness')
    case 'conductivity':
      return t('cards.formula.input.conductivity')
    case 'length':
      return t('cards.formula.input.length')
    case 'openingArea':
      return t('cards.formula.input.openingArea')
    case 'floorArea':
      return t('cards.formula.input.floorArea')
    case 'roomDepth':
      return t('cards.formula.input.roomDepth')
    case 'overhangDepth':
      return t('cards.formula.input.overhangDepth')
  }
}

const zeroQuantity = (key: InputLabel, t: Translator): string =>
  key === 'floorArea' ? t('cards.formula.zeroQuantity.floorArea') : t('cards.formula.zeroQuantity.conductivity')

const termText = (key: TermKey, params: { group?: string | null; metres?: number } | undefined, t: Translator): string => {
  const layer = params?.group ?? ''
  const metres = params?.metres == null ? null : String(params.metres)
  switch (key) {
    case 'riser':
      return t('cards.formula.term.riser')
    case 'going':
      return t('cards.formula.term.going')
    case 'thickness':
      return t('cards.formula.term.thickness', { layer })
    case 'conductivity':
      return t('cards.formula.term.conductivity', { layer })
    case 'length':
      return t('cards.formula.term.length', { layer })
    case 'openingArea':
      return t('cards.formula.term.openingArea')
    case 'floorArea':
      return t('cards.formula.term.floorArea')
    case 'roomDepth':
      return t('cards.formula.term.roomDepth')
    case 'overhangDepth':
      return t('cards.formula.term.overhangDepth')
    case 'surfaceInside':
      return t('cards.formula.term.surfaceInside')
    case 'surfaceOutside':
      return t('cards.formula.term.surfaceOutside')
    case 'layerResistance':
      return t('cards.formula.term.layerResistance', { layer })
    case 'totalResistance':
      return t('cards.formula.term.totalResistance')
    case 'baseShare':
      return t('cards.formula.term.baseShare')
    case 'raisedShare':
      return t('cards.formula.term.raisedShare')
    case 'overhangIncrement':
      return metres == null
        ? t('cards.formula.term.overhangIncrement')
        : t('cards.formula.term.overhangIncrementMetres', { metres })
    case 'depthIncrement':
      return metres == null
        ? t('cards.formula.term.depthIncrement')
        : t('cards.formula.term.depthIncrementMetres', { metres })
  }
}

const lineText = (key: LineKey, group: string | null | undefined, t: Translator): string => {
  switch (key) {
    case 'layerResistance':
      return t('cards.formula.line.layerResistance', { layer: group ?? '' })
    case 'totalResistance':
      return t('cards.formula.line.totalResistance')
    case 'uValue':
      return t('cards.formula.line.uValue')
    case 'stepMeasure':
      return t('cards.formula.line.stepMeasure')
    case 'routeLength':
      return t('cards.formula.line.routeLength')
    case 'daylightShare':
      return t('cards.formula.line.daylightShare')
    case 'requiredShare':
      return t('cards.formula.line.requiredShare')
  }
}

const checkLabel = (id: CheckId, t: Translator): string => {
  switch (id) {
    case 'stepRule':
      return t('cards.formula.check.stepRule')
    case 'riserMax':
      return t('cards.formula.check.riserMax')
    case 'goingMin':
      return t('cards.formula.check.goingMin')
    case 'uMax':
      return t('cards.formula.check.uMax')
    case 'routeMax':
      return t('cards.formula.check.routeMax')
    case 'daylightMin':
      return t('cards.formula.check.daylightMin')
  }
}

const caveatText = (key: CaveatKey, params: Record<string, string> | undefined, t: Translator): string => {
  switch (key) {
    case 'uValueNewBuild':
      return t('cards.formula.caveat.uValueNewBuild', { row: params?.row ?? '' })
    case 'uValueScope':
      return t('cards.formula.caveat.uValueScope')
    case 'routeFromRoom':
      return t('cards.formula.caveat.routeFromRoom')
    case 'routeFromDwelling':
      return t('cards.formula.caveat.routeFromDwelling')
    case 'daylightAngle':
      return t('cards.formula.caveat.daylightAngle')
    case 'daylightOtherLaw':
      return t('cards.formula.caveat.daylightOtherLaw')
  }
}

/** The case the model named, said in words above the inputs. */
const caseText = (formula: FormulaCardData['formula'], t: Translator): string | null => {
  switch (formula.name) {
    case 'u_value':
      switch (formula.component) {
        case 'external_wall':
          return t('cards.formula.component.external_wall')
        case 'roof_or_ceiling_to_outside_air':
          return t('cards.formula.component.roof_or_ceiling_to_outside_air')
        case 'floor_over_outside_air':
          return t('cards.formula.component.floor_over_outside_air')
      }
      return null
    case 'stair_step_rule':
      switch (formula.stair_type) {
        case 'main':
          return t('cards.formula.stairType.main')
        case 'dwelling':
          return t('cards.formula.stairType.dwelling')
        case 'secondary':
          return t('cards.formula.stairType.secondary')
      }
      return null
    default:
      return null
  }
}

const wordsFor = (t: Translator): FormulaWords => ({
  line: (key, group) => lineText(key, group, t),
  term: (key, params) => termText(key, params, t),
})

/* ── inputs ─────────────────────────────────────────────────────────────── */

/** Where an input's value comes from: its source line, its norm reference. */
const sourceText = (slot: InputSlot): string =>
  [
    slot.input.source,
    slot.input.reference && [slot.input.reference.document, slot.input.reference.section].filter(Boolean).join(' '),
  ]
    .filter(Boolean)
    .join(' · ')

/**
 * The sources of one row's inputs. One line when they agree; each input's own,
 * named, when they do not („Dicke d: Wandaufbau AW 01 · λ: Produktdatenblatt"),
 * so the reader knows which figure a source stands behind before changing it.
 */
const RowSources: FC<{ slots: InputSlot[]; id: string; t: Translator }> = ({ slots, id, t }) => {
  const texts = slots.map(sourceText)
  const provenance = slots.find((slot) => slot.input.provenance)?.input.provenance
  const distinct = new Set(texts.filter(Boolean))
  if (distinct.size === 0 && !provenance) return null
  const line =
    distinct.size <= 1
      ? [...distinct][0]
      : slots
          .map((slot, index) => (texts[index] ? `${inputLabel(slot.labelKey, t)}: ${texts[index]}` : null))
          .filter(Boolean)
          .join(' · ')
  return (
    <span id={id} className="card-meta flex flex-wrap items-baseline gap-x-1.5 text-muted-foreground">
      {line && <span className="[overflow-wrap:anywhere]">{line}</span>}
      {provenance && (
        <span className="rounded bg-muted px-1 py-px" title={provenanceTitle(provenance, t)}>
          {provenanceLabel(provenance, t)}
        </span>
      )}
    </span>
  )
}

/** The reader's-assumption marker: an icon and the word, the colour only reinforcing them. */
const AssumptionChip: FC<{ label: string }> = ({ label }) => (
  <Chip variant="warning" size="sm">
    <UserPen aria-hidden="true" />
    {label}
  </Chip>
)

type ChangeHandler = (key: string, value: number | null, issue: QuantityIssue | null) => void

/** One input's control: a field, or the given value; and, once changed, the reader's-assumption marker. */
const InputField: FC<{
  slot: InputSlot
  value: number | null
  changed: boolean
  captioned: boolean
  rowName: string | null
  sourcesId: string | null
  onChange: ChangeHandler
  t: Translator
}> = ({ slot, value, changed, captioned, rowName, sourcesId, onChange, t }) => {
  const markerId = useId()
  const label = inputLabel(slot.labelKey, t)
  const sourceValue = slot.input.value
  const describedBy = [sourcesId, changed ? markerId : null].filter(Boolean).join(' ')
  const issueText = (issue: QuantityIssue): string => {
    switch (issue) {
      case 'notANumber':
        return t('cards.formula.invalidNumber')
      case 'zero':
        return t('cards.formula.zeroNotPossible', { quantity: zeroQuantity(slot.labelKey, t) })
      case 'outOfRange':
        return t('cards.formula.outOfRange', {
          min: formatInput(slot.min ?? 0),
          max: slot.max == null ? '∞' : formatInput(slot.max),
          unit: slot.unit,
        })
    }
  }
  return (
    <span className="flex flex-col items-end gap-1">
      {captioned && <span className="card-meta text-muted-foreground">{label}</span>}
      {slot.editable ? (
        <QuantityInput
          value={value}
          onValueChange={(next, issue) => onChange(slot.key, next, issue)}
          unit={slot.unit}
          label={rowName ? `${rowName}, ${label}` : label}
          placeholder={t('cards.formula.missingPlaceholder')}
          min={slot.min}
          max={slot.max}
          step={slot.step}
          positive={slot.positive}
          describedBy={describedBy || undefined}
          invalidMessage={issueText}
        />
      ) : (
        <span className="card-body flex h-9 items-baseline gap-1.5 pt-1.5 font-mono tabular-nums text-foreground">
          {value == null ? (
            <span className="font-sans italic text-muted-foreground">{missingLabel(t)}</span>
          ) : (
            withUnit(formatInput(value), slot.unit)
          )}
          <span className="card-meta font-sans text-muted-foreground">{t('cards.formula.fixed')}</span>
        </span>
      )}
      {changed && (
        // The reader's figure, said in words and beside the source's, so a
        // screenshot of the card cannot pass it off as the plan's.
        <span
          id={markerId}
          className="card-meta flex max-w-[8.5rem] flex-wrap items-center justify-end gap-x-1.5 gap-y-0.5 text-right"
        >
          <AssumptionChip label={t('cards.formula.yourAssumption')} />
          <span className="text-muted-foreground">
            {sourceValue == null
              ? t('cards.formula.sourceMissing')
              : t('cards.formula.sourceValue', { value: withUnit(formatInput(sourceValue), slot.unit) })}
          </span>
        </span>
      )}
    </span>
  )
}

interface Row {
  name: string | null
  slots: InputSlot[]
}

const InputRowItem: FC<{
  row: Row
  values: Record<string, number | null>
  changed: Set<string>
  onChange: ChangeHandler
  t: Translator
}> = ({ row, values, changed, onChange, t }) => {
  const sourcesId = useId()
  const hasSources = row.slots.some((slot) => sourceText(slot) || slot.input.provenance)
  const title = row.name ?? inputLabel(row.slots[0].labelKey, t)
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
      <span className="flex min-w-0 flex-1 basis-[9rem] flex-col gap-0.5 pt-1.5">
        <span className="card-body text-foreground [overflow-wrap:anywhere]">{title}</span>
        <RowSources slots={row.slots} id={sourcesId} t={t} />
      </span>
      <span className="flex flex-wrap justify-end gap-x-3 gap-y-1.5">
        {row.slots.map((slot) => (
          <InputField
            key={slot.key}
            slot={slot}
            value={values[slot.key] ?? null}
            changed={changed.has(slot.key)}
            captioned={row.name !== null && row.slots.length > 1}
            rowName={row.name}
            sourcesId={hasSources ? sourcesId : null}
            onChange={onChange}
            t={t}
          />
        ))}
      </span>
    </li>
  )
}

/**
 * One row per layer or leg (its inputs side by side under their own small
 * labels), or per input where the rule has no groups. Side by side because a
 * layer is read as one thing — „EPS-F: 20 cm, λ 0,035" — and two rows per layer
 * made a four-layer wall eight rows tall.
 */
const InputRows: FC<{
  slots: InputSlot[]
  values: Record<string, number | null>
  changed: Set<string>
  onChange: ChangeHandler
  t: Translator
}> = ({ slots, values, changed, onChange, t }) => {
  const rows: Row[] = []
  for (const slot of slots) {
    const last = rows[rows.length - 1]
    if (last && slot.group !== null && last.name === slot.group) last.slots.push(slot)
    else rows.push({ name: slot.group, slots: [slot] })
  }
  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map((row, index) => (
        <InputRowItem
          key={`${row.name ?? row.slots[0].key}-${index}`}
          row={row}
          values={values}
          changed={changed}
          onChange={onChange}
          t={t}
        />
      ))}
    </ul>
  )
}

/* ── checks ─────────────────────────────────────────────────────────────── */

/** The quantity as the card prints it: a step's result as its Rechenweg line does, an input as written. */
const quantityText = (check: LimitCheck, judged: JudgedFormula, t: Translator): string => {
  const { value, unit } = check.quantity
  if (value == null) return missingLabel(t)
  if (check.spec.quantity.kind === 'input') return withUnit(formatInput(value), unit)
  const display = judged.display[check.spec.quantity.index]
  return withUnit(formatResult(value, Math.max(display.decimals, check.decimals), display.fixed), unit)
}

const boundText = (check: LimitCheck, t: Translator): string => {
  const { limit, spec } = check
  if (limit == null) return `${fmtComparator(spec.limit.comparator === 'between' ? '>=' : spec.limit.comparator)} ${missingLabel(t)}`
  if (limit.comparator === 'between') {
    return withUnit(`${formatInput(limit.value)}–${formatInput(limit.upper ?? limit.value)}`, spec.unit)
  }
  return `${fmtComparator(limit.comparator)} ${withUnit(formatInput(limit.value), spec.unit)}`
}

/** Why a check cannot be judged: a refused entry, a division by zero, or a value nobody has given. */
const undecidedText = (
  check: LimitCheck,
  compiled: CompiledFormula,
  issues: Record<string, QuantityIssue>,
  t: Translator
): string => {
  if (check.spec.dependsOn.some((key) => issues[key])) return t('cards.formula.inputRejected')
  if (check.quantity.undecidable === 'undefined') {
    return compiled.zeroInput
      ? t('cards.formula.zeroNotPossible', { quantity: zeroQuantity(compiled.zeroInput, t) })
      : t('cards.formula.undefinedResult')
  }
  return t('cards.formula.cannotJudge')
}

const CheckRow: FC<{
  check: LimitCheck
  judged: JudgedFormula
  compiled: CompiledFormula
  assumed: boolean
  issues: Record<string, QuantityIssue>
  t: Translator
}> = ({ check, judged, compiled, assumed, issues, t }) => {
  const { reference } = check.spec
  return (
    <li className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusBadge status={check.status} />
        <span className="card-body text-foreground">{checkLabel(check.spec.id, t)}</span>
        <span className="card-body font-mono tabular-nums text-foreground">{quantityText(check, judged, t)}</span>
        <span className="card-body font-mono text-muted-foreground">{boundText(check, t)}</span>
        {assumed && <AssumptionChip label={t('cards.formula.yourAssumption')} />}
      </div>
      <span className="card-meta text-muted-foreground">
        {[reference.document, reference.section, reference.edition].filter(Boolean).join(' · ')}
      </span>
      {check.status === 'needs_input' && (
        <p className="card-caption max-w-prose text-muted-foreground">{undecidedText(check, compiled, issues, t)}</p>
      )}
    </li>
  )
}

/* ── the card ───────────────────────────────────────────────────────────── */

export const FormulaCard: FC<FormulaCardProps> = ({ title, formula, note }) => {
  const t = useTranslations('chat')
  const { overrides, change, reset } = useReaderOverrides()
  // Which fields hold text the field refused. One reader's view of their own
  // typing, so component state, never the data model.
  const [issues, setIssues] = useState<Record<string, QuantityIssue>>({})
  const [interacted, setInteracted] = useState(false)

  const slots = useMemo(() => inputSlots(formula), [formula])
  const source = useMemo(() => sourceValues(formula), [formula])
  const words = useMemo(() => wordsFor(t), [t])
  const values = { ...source, ...overrides }
  const compiled = compileFormula(formula, values, words)
  const judged = judgeFormula(compiled, values)
  const changed = changedInputs(source, values)
  const verdict = worstStatus(judged.checks.map((check) => check.status))
  const editable = slots.some((slot) => slot.editable)
  const assumedChecks = new Set(
    judged.checks.filter((check) => check.spec.dependsOn.some((key) => changed.has(key))).map((check) => check.spec.id)
  )
  const tint = judged.checks.find((check) => check.spec.id === compiled.tint)?.status ?? null
  const caseLine = caseText(formula, t)

  const onChange: ChangeHandler = (key, value, issue) => {
    change(key, value)
    setIssues((previous) => {
      const next = { ...previous }
      if (issue) next[key] = issue
      else delete next[key]
      return next
    })
    setInteracted(true)
  }
  const onReset = () => {
    reset()
    setIssues({})
    setInteracted(true)
  }

  const spoken = judged.checks
    .map((check) =>
      t('cards.formula.checkSpoken', {
        name: checkLabel(check.spec.id, t),
        value: quantityText(check, judged, t),
        bound: boundText(check, t),
        verdict: statusLabel(check.status, t),
      })
    )
    .join(' ')

  return (
    <SchematicCard
      icon={SlidersHorizontal}
      eyebrow={t('cards.formula.eyebrow')}
      title={title}
      verdict={verdict}
      verdictNote={changed.size > 0 ? <AssumptionChip label={t('cards.formula.withYourAssumptions')} /> : undefined}
      note={note}
      reference={FORMULA_SOURCES[formula.name]}
    >
      {editable && <p className="card-caption max-w-prose text-muted-foreground">{t('cards.formula.hint')}</p>}

      <section className="flex flex-col gap-2" aria-label={t('cards.formula.inputsLabel')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionLabel as="h3">{t('cards.formula.inputsLabel')}</SectionLabel>
          {/* Always mounted, disabled while there is nothing to reset: a
              button that vanishes on press takes the keyboard focus with it. */}
          {editable && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onReset}
              disabled={changed.size === 0 && Object.keys(issues).length === 0}
              aria-label={t('cards.formula.resetLabel')}
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              {t('cards.formula.reset')}
            </Button>
          )}
        </div>
        {caseLine && <span className="card-meta text-muted-foreground">{caseLine}</span>}
        <InputRows slots={slots} values={values} changed={changed} onChange={onChange} t={t} />
      </section>

      <section className="flex flex-col gap-2" aria-label={t('cards.formula.derivationLabel')}>
        <SectionLabel as="h3">{t('cards.formula.derivationLabel')}</SectionLabel>
        <DerivationSteps
          steps={compiled.steps}
          results={judged.results}
          display={judged.display}
          tint={tint}
          stepReference="label"
          undefinedText={() =>
            compiled.zeroInput
              ? t('cards.formula.zeroNotPossible', { quantity: zeroQuantity(compiled.zeroInput, t) })
              : undefined
          }
          t={t}
        />
        {changed.size > 0 && <p className="card-caption font-medium text-warning">{t('cards.formula.withAssumptions')}</p>}
      </section>

      <section className="flex flex-col gap-2" aria-label={t('cards.formula.checksLabel')}>
        <SectionLabel as="h3">{t('cards.formula.checksLabel')}</SectionLabel>
        <ul className="flex flex-col gap-2.5">
          {judged.checks.map((check) => (
            <CheckRow
              key={check.spec.id}
              check={check}
              judged={judged}
              compiled={compiled}
              assumed={assumedChecks.has(check.spec.id)}
              issues={issues}
              t={t}
            />
          ))}
        </ul>
      </section>

      {compiled.caveats.length > 0 && (
        <section className="flex flex-col gap-1" aria-label={t('cards.formula.notesLabel')}>
          <ul className="flex flex-col gap-1">
            {compiled.caveats.map((caveat) => (
              <li key={caveat.key} className="card-caption max-w-prose text-muted-foreground">
                {caveatText(caveat.key, caveat.params, t)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Said after the reader changed something and the field settled, so a
          screen reader hears each verdict with its quantity and bound without
          leaving the field. */}
      <p className="sr-only" aria-live="polite">
        {interacted ? t('cards.formula.recomputed', { checks: spoken }) : ''}
      </p>
    </SchematicCard>
  )
}
