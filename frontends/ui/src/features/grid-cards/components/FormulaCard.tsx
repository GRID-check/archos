'use client'

/**
 * FormulaCard — a named rule the reader can ask "what if" of, on the card.
 *
 * The model names the rule and fills its inputs from cited sources; this card
 * computes, in the browser, with `../lib/formulas` (ADR-0141). Change the
 * Dämmstärke and the U-value, the Rechenweg and the verdict against the cited
 * limit recompute on the spot, with no model call and nothing saved.
 *
 * Three promises the layout keeps:
 *
 *  - **Every number is computed, cited or the reader's own.** Results are
 *    computed here; each input says where its value is written; a value the
 *    reader changed is marked „Ihre Annahme" with the source's value beside
 *    it, and the result says it was computed with their assumptions.
 *  - **The limit does not move.** A limit is a cited statement: it is printed
 *    with its Punkt and has no control.
 *  - **Unknown is said, never guessed.** An input the source does not give is
 *    empty, and every verdict that needs it reads „kann nicht beurteilen"
 *    until the reader enters an assumption.
 *
 * The verdict is carried by an icon and a word (`StatusBadge`), never by
 * colour alone. `presentational` in CARD_INTERACTIVITY: the inputs are one
 * reader's view state, bound into the A2UI surface's data model and nowhere
 * else (`features/a2ui/reader-inputs.ts`).
 */

import { useId, useMemo, type FC } from 'react'
import { RotateCcw, SlidersHorizontal, UserPen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { QuantityInput } from '@/components/ui/quantity-input'
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
import {
  FORMULA_SOURCES,
  changedInputs,
  checkLimits,
  evaluateFormula,
  inputSlots,
  isEditable,
  sourceValues,
  type DerivationLine,
  type FormulaCardData,
  type FormulaInputLabel,
  type FormulaLimitData,
  type InputSlot,
  type LimitCheck,
  type Quantity,
  type Term,
} from '../lib/formulas'

type FormulaCardProps = Pick<FormulaCardData, 'title' | 'formula' | 'limits' | 'note'>

const termFormat = new Intl.NumberFormat('de-AT', { maximumFractionDigits: 4 })
/** An input as it was entered: λ = 0,035 must not print as 0,04. */
const fmtTerm = (value: number): string => termFormat.format(value)
const fmtFixed = (value: number, decimals: number): string =>
  new Intl.NumberFormat('de-AT', { maximumFractionDigits: decimals }).format(value)

/** How far each line's result is printed before a limit asks for more. */
const LINE_DECIMALS: Record<DerivationLine['labelKey'], number> = {
  layerResistance: 3,
  totalResistance: 3,
  uValue: 3,
  stepMeasure: 2,
  routeLength: 2,
  daylightRatio: 2,
}

/** The same precision for a quantity in its verdict row as on its derivation line. */
const TARGET_DECIMALS: Record<string, number> = { u_value: LINE_DECIMALS.uValue }

/* ── the words, spelled out so key-coverage.spec.ts can see every key ─────── */

const inputLabel = (key: FormulaInputLabel, t: Translator): string => {
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
    case 'glazingArea':
      return t('cards.formula.input.glazingArea')
    case 'floorArea':
      return t('cards.formula.input.floorArea')
  }
}

const termLabel = (term: Term, t: Translator): string => {
  switch (term.labelKey) {
    case 'surfaceInside':
      return t('cards.formula.term.surfaceInside')
    case 'surfaceOutside':
      return t('cards.formula.term.surfaceOutside')
    case 'layerResistance':
      return t('cards.formula.term.layerResistance', { layer: term.group ?? '' })
    case 'totalResistance':
      return t('cards.formula.term.totalResistance')
    case 'one':
      return ''
    case 'thickness':
    case 'conductivity':
    case 'length':
      return term.group ?? inputLabel(term.labelKey, t)
    default:
      return inputLabel(term.labelKey, t)
  }
}

const lineLabel = (line: DerivationLine, t: Translator): string => {
  switch (line.labelKey) {
    case 'layerResistance':
      return t('cards.formula.line.layerResistance', { layer: line.group ?? '' })
    case 'totalResistance':
      return t('cards.formula.line.totalResistance')
    case 'uValue':
      return t('cards.formula.line.uValue')
    case 'stepMeasure':
      return t('cards.formula.line.stepMeasure')
    case 'routeLength':
      return t('cards.formula.line.routeLength')
    case 'daylightRatio':
      return t('cards.formula.line.daylightRatio')
  }
}

const targetLabel = (target: string, t: Translator): string => {
  switch (target) {
    case 'u_value':
      return t('cards.formula.target.uValue')
    case 'step_measure':
      return t('cards.formula.target.stepMeasure')
    case 'riser':
      return t('cards.formula.target.riser')
    case 'going':
      return t('cards.formula.target.going')
    case 'route_length':
      return t('cards.formula.target.routeLength')
    case 'daylight_ratio':
      return t('cards.formula.target.daylightRatio')
    default:
      return target
  }
}

const heatFlowLabel = (flow: 'horizontal' | 'upward' | 'downward', t: Translator): string => {
  switch (flow) {
    case 'horizontal':
      return t('cards.formula.heatFlow.horizontal')
    case 'upward':
      return t('cards.formula.heatFlow.upward')
    case 'downward':
      return t('cards.formula.heatFlow.downward')
  }
}

const withUnit = (value: string, unit: string): string => (unit ? `${value} ${unit}` : value)

/* ── inputs ─────────────────────────────────────────────────────────────── */

/** Where an input's value comes from: its source line, its norm reference, its provenance. */
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

/** One input's control: a field, or the fixed value; and, once changed, the reader's-assumption marker. */
const InputField: FC<{
  slot: InputSlot
  value: number | null
  changed: boolean
  captioned: boolean
  rowName: string | null
  sourcesId: string | null
  onChange: (key: string, value: number | null) => void
  t: Translator
}> = ({ slot, value, changed, captioned, rowName, sourcesId, onChange, t }) => {
  const markerId = useId()
  const label = inputLabel(slot.labelKey, t)
  const sourceValue = slot.input.value
  const describedBy = [sourcesId, changed ? markerId : null].filter(Boolean).join(' ')
  return (
    <span className="flex flex-col items-end gap-1">
      {captioned && <span className="card-meta text-muted-foreground">{label}</span>}
      {isEditable(slot) ? (
        <QuantityInput
          value={value}
          onValueChange={(next) => onChange(slot.key, next)}
          unit={slot.unit}
          label={rowName ? `${rowName}, ${label}` : label}
          placeholder={t('cards.formula.missingPlaceholder')}
          min={slot.input.min ?? slot.floor}
          max={slot.input.max}
          step={slot.input.step}
          describedBy={describedBy || undefined}
          invalidMessage={(reason) =>
            reason === 'notANumber'
              ? t('cards.formula.invalidNumber')
              : t('cards.formula.outOfRange', {
                  min: fmtTerm(slot.input.min ?? slot.floor),
                  max: slot.input.max == null ? '∞' : fmtTerm(slot.input.max),
                  unit: slot.unit,
                })
          }
        />
      ) : (
        <span className="card-body flex h-9 items-baseline gap-1.5 pt-1.5 font-mono tabular-nums text-foreground">
          {value == null ? (
            <span className="font-sans italic text-muted-foreground">{missingLabel(t)}</span>
          ) : (
            withUnit(fmtTerm(value), slot.unit)
          )}
          <span className="card-meta font-sans text-muted-foreground">{t('cards.formula.fixed')}</span>
        </span>
      )}
      {changed && (
        // The reader's figure, said in words and beside the source's, so a
        // screenshot of the card cannot pass it off as the plan's.
        <span id={markerId} className="card-meta flex max-w-[8.5rem] flex-wrap items-center justify-end gap-x-1.5 gap-y-0.5 text-right">
          <Chip variant="warning" size="sm">
            <UserPen aria-hidden="true" />
            {t('cards.formula.yourAssumption')}
          </Chip>
          <span className="text-muted-foreground">
            {sourceValue == null
              ? t('cards.formula.sourceMissing')
              : t('cards.formula.sourceValue', { value: withUnit(fmtTerm(sourceValue), slot.unit) })}
          </span>
        </span>
      )}
    </span>
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
  onChange: (key: string, value: number | null) => void
  t: Translator
}> = ({ slots, values, changed, onChange, t }) => {
  const rows: Array<{ name: string | null; slots: InputSlot[] }> = []
  for (const slot of slots) {
    const last = rows[rows.length - 1]
    if (last && slot.group !== null && last.name === slot.group) last.slots.push(slot)
    else rows.push({ name: slot.group, slots: [slot] })
  }
  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map((row, index) => (
        <InputRowItem key={`${row.name ?? row.slots[0].key}-${index}`} row={row} values={values} changed={changed} onChange={onChange} t={t} />
      ))}
    </ul>
  )
}

const InputRowItem: FC<{
  row: { name: string | null; slots: InputSlot[] }
  values: Record<string, number | null>
  changed: Set<string>
  onChange: (key: string, value: number | null) => void
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

/* ── derivation ─────────────────────────────────────────────────────────── */

const operatorFor = (line: DerivationLine, term: Term): string => {
  if (line.operation === 'sum') return (term.factor ?? 1) < 0 ? '−' : '+'
  return '÷'
}

const QuantityText: FC<{ quantity: Quantity; decimals: number; t: Translator }> = ({ quantity, decimals, t }) =>
  quantity.value == null ? (
    <span className="font-sans text-xs font-normal italic text-muted-foreground">{missingLabel(t)}</span>
  ) : (
    <>
      {fmtFixed(quantity.value, decimals)}
      {quantity.unit && <span className="font-normal opacity-70"> {quantity.unit}</span>}
    </>
  )

const LineRow: FC<{ line: DerivationLine; decimals: number; final: boolean; t: Translator }> = ({ line, decimals, final, t }) => (
  <li className="flex flex-col gap-1">
    <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{lineLabel(line, t)}</span>
    <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
      {line.terms.map((term, position) => (
        <span key={`${term.labelKey}-${position}`} className="flex items-start gap-2">
          {position > 0 && (
            <span aria-hidden="true" className="pt-0.5 font-mono text-[13.5px] text-muted-foreground">
              {operatorFor(line, term)}
            </span>
          )}
          <span className="flex min-w-0 flex-col items-center">
            <span className="whitespace-nowrap font-mono text-[13.5px] tabular-nums text-foreground">
              {term.factor != null && term.factor !== 1 && (
                <span className="text-muted-foreground">{fmtTerm(Math.abs(term.factor))} × </span>
              )}
              {term.value == null ? (
                <span className="font-sans text-xs italic text-muted-foreground">{missingLabel(t)}</span>
              ) : (
                <>
                  {term.decimals == null ? fmtTerm(term.value) : fmtFixed(term.value, term.decimals)}
                  {term.unit && <span className="text-muted-foreground"> {term.unit}</span>}
                </>
              )}
            </span>
            <span className="card-meta max-w-[11rem] text-center font-normal [overflow-wrap:anywhere] text-muted-foreground">
              {termLabel(term, t)}
            </span>
          </span>
        </span>
      ))}
      {line.operation === 'percent_ratio' && (
        <span aria-hidden="true" className="pt-0.5 font-mono text-[13.5px] text-muted-foreground">
          × 100
        </span>
      )}
      <span aria-hidden="true" className="pt-0.5 font-mono text-[13.5px] text-muted-foreground">
        =
      </span>
      <span className={final ? 'whitespace-nowrap font-mono card-figure-24 text-foreground' : 'whitespace-nowrap pt-0.5 font-mono text-[13.5px] text-foreground'}>
        <QuantityText quantity={line.result} decimals={decimals} t={t} />
      </span>
    </div>
    {line.result.undecidable === 'undefined' && (
      <p className="card-caption max-w-prose text-muted-foreground">{t('cards.formula.undefinedResult')}</p>
    )}
  </li>
)

/* ── checks ─────────────────────────────────────────────────────────────── */

const boundText = (limit: FormulaLimitData, unit: string): string =>
  limit.comparator === 'between'
    ? withUnit(`${fmtTerm(limit.value)}–${fmtTerm(limit.upper ?? limit.value)}`, unit)
    : `${fmtComparator(limit.comparator)} ${withUnit(fmtTerm(limit.value), unit)}`

const CheckRow: FC<{ check: LimitCheck; t: Translator }> = ({ check, t }) => {
  const { limit, quantity } = check
  const name = limit.label || targetLabel(limit.target, t)
  return (
    <li className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusBadge status={check.status} />
        <span className="card-body text-foreground">{name}</span>
        <span className="card-body font-mono tabular-nums text-foreground">
          <QuantityText quantity={quantity} decimals={Math.max(check.decimals, TARGET_DECIMALS[limit.target] ?? 2)} t={t} />
        </span>
        <span className="card-body font-mono text-muted-foreground">{boundText(limit, quantity.unit)}</span>
      </div>
      <span className="card-meta text-muted-foreground">
        {[limit.reference.document, limit.reference.section, limit.reference.edition].filter(Boolean).join(' · ')}
      </span>
      {check.status === 'needs_input' && (
        <p className="card-caption max-w-prose text-muted-foreground">
          {quantity.undecidable === 'undefined' ? t('cards.formula.undefinedResult') : t('cards.formula.cannotJudge')}
        </p>
      )}
    </li>
  )
}

/* ── the card ───────────────────────────────────────────────────────────── */

export const FormulaCard: FC<FormulaCardProps> = ({ title, formula, limits, note }) => {
  const t = useTranslations('chat')
  const { overrides, change, reset } = useReaderOverrides()

  const slots = useMemo(() => inputSlots(formula), [formula])
  const source = useMemo(() => sourceValues(formula), [formula])
  const values = { ...source, ...overrides }
  const outcome = evaluateFormula(formula, values)
  const checks = checkLimits(limits, outcome)
  const changed = changedInputs(source, values)
  const verdict = worstStatus(checks.map((check) => check.status))
  const editable = slots.some(isEditable)

  // A limit decides how far its quantity is printed; the derivation's last line
  // prints at least that far, so the number above the verdict is the verdict's.
  const finalLine = outcome.lines[outcome.lines.length - 1]
  const finalDecimals = Math.max(
    finalLine ? LINE_DECIMALS[finalLine.labelKey] : 2,
    ...checks.filter((check) => check.limit.target === finalLine?.id).map((check) => check.decimals)
  )

  const summary = checks.length > 0 ? checks.map((check) => statusLabel(check.status, t)).join(', ') : t('cards.formula.noLimits')

  return (
    <SchematicCard
      icon={SlidersHorizontal}
      eyebrow={t('cards.formula.eyebrow')}
      title={title}
      verdict={verdict}
      note={note}
      reference={FORMULA_SOURCES[formula.name]}
    >
      {editable && <p className="card-caption max-w-prose text-muted-foreground">{t('cards.formula.hint')}</p>}

      <section className="flex flex-col gap-2" aria-label={t('cards.formula.inputsLabel')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionLabel as="h3">{t('cards.formula.inputsLabel')}</SectionLabel>
          {changed.size > 0 && (
            <Button variant="ghost" size="sm" onClick={reset} aria-label={t('cards.formula.resetLabel')}>
              <RotateCcw className="size-3.5" aria-hidden="true" />
              {t('cards.formula.reset')}
            </Button>
          )}
        </div>
        {formula.name === 'u_value' && (
          <span className="card-meta text-muted-foreground">{heatFlowLabel(formula.heat_flow, t)}</span>
        )}
        <InputRows slots={slots} values={values} changed={changed} onChange={change} t={t} />
      </section>

      <section className="flex flex-col gap-2" aria-label={t('cards.formula.derivationLabel')}>
        <SectionLabel as="h3">{t('cards.formula.derivationLabel')}</SectionLabel>
        <ol className="flex flex-col gap-3">
          {outcome.lines.map((line, index) => (
            <LineRow
              key={line.id}
              line={line}
              final={index === outcome.lines.length - 1}
              decimals={index === outcome.lines.length - 1 ? finalDecimals : LINE_DECIMALS[line.labelKey]}
              t={t}
            />
          ))}
        </ol>
        {changed.size > 0 && <p className="card-caption font-medium text-warning">{t('cards.formula.withAssumptions')}</p>}
      </section>

      <section className="flex flex-col gap-2" aria-label={t('cards.formula.checksLabel')}>
        <SectionLabel as="h3">{t('cards.formula.checksLabel')}</SectionLabel>
        {checks.length > 0 ? (
          <ul className="flex flex-col gap-2.5">
            {checks.map((check, index) => (
              <CheckRow key={`${check.limit.target}-${index}`} check={check} t={t} />
            ))}
          </ul>
        ) : (
          <p className="card-caption max-w-prose text-muted-foreground">{t('cards.formula.noLimits')}</p>
        )}
      </section>

      {/* Said once the reader has changed something, so a screen reader hears
          the new verdict without leaving the field it is in. */}
      <p className="sr-only" aria-live="polite">
        {changed.size > 0 ? t('cards.formula.recomputed', { verdict: summary }) : ''}
      </p>
    </SchematicCard>
  )
}
