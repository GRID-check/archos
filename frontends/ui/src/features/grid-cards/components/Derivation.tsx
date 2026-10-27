'use client'

/**
 * A Rechenweg, laid out line by line: the one derivation renderer.
 *
 * `CalculationCard` draws the steps a model wrote; `FormulaCard` draws the
 * steps a named rule compiles to (`../lib/formulas`). Both are
 * `CalculationStepData` evaluated by `../lib/calculate`, so a step is printed
 * one way, whichever card it is on: each operand with what it is underneath it,
 * the way a Rechenweg is written on paper, and the result this module was
 * handed by `evaluate`, never one stated on the wire.
 *
 * How a number is printed is part of not disagreeing with oneself:
 *
 *  - an input prints as it was written (`formatInput`), so a λ of 0,035 does
 *    not round to 0,04;
 *  - a result prints to its step's `display`, and an operand that IS an
 *    earlier result prints exactly as that step's result did, so the terms of
 *    a sum are at the precision of the line they came from.
 */

import type { FC } from 'react'
import type { Translator } from '@/i18n'
import { cn } from '@/lib/utils'
import { fmtTolerance, missingLabel, statusColor } from '../schematics/kit'
import {
  formatInput,
  formatResult,
  type Derivation,
  type StepDisplay,
  type StepResult,
} from '../lib/calculate'
import type { CalculationOperandData, CalculationStepData, DimStatus } from '@/shared/cards/schemas'

export type { StepDisplay } from '../lib/calculate'

/** The glyph BETWEEN two operands of a step. Symbols, so they need no locale. */
const operatorFor = (
  operation: CalculationStepData['operation'],
  operand: CalculationOperandData
): string => {
  if (operation === 'sum') return (operand.factor ?? 1) < 0 ? '−' : '+'
  if (operation === 'quotient' || operation === 'percent_ratio') return '÷'
  return '×'
}

/** The constant a percentage step applies after its operands. */
const PERCENT_FACTOR: Partial<Record<CalculationStepData['operation'], string>> = {
  percent_ratio: '× 100',
  percent_of: '÷ 100',
}

const printResult = (value: number, display: StepDisplay | undefined): string =>
  formatResult(value, display?.decimals ?? 2, display?.fixed ?? false)

const Operand: FC<{
  operand: CalculationOperandData
  steps: CalculationStepData[]
  referenced: StepResult | undefined
  referencedDisplay: StepDisplay | undefined
  stepReference: 'index' | 'label'
  t: Translator
}> = ({ operand, steps, referenced, referencedDisplay, stepReference, t }) => {
  const fromStep = operand.step != null
  const value = fromStep ? referenced?.value : operand.value
  const unit = fromStep ? (referenced?.unit ?? '') : (operand.unit ?? '')
  const factor =
    typeof operand.factor === 'number' && operand.factor !== 1 ? Math.abs(operand.factor) : null
  const label = fromStep
    ? stepReference === 'index'
      ? t('cards.calculation.fromStep', { step: String(operand.step) })
      : operand.label || steps[(operand.step ?? 1) - 1]?.label
    : operand.label

  return (
    <span className="flex shrink-0 flex-col items-center">
      <span className="text-foreground font-mono text-[13.5px] whitespace-nowrap tabular-nums">
        {/* The rule's own multiplier reads as part of the term („2 × 17 cm"),
            because that is what it is — not a quantity anybody measured. */}
        {factor != null && <span className="text-muted-foreground">{formatInput(factor)} × </span>}
        {value == null ? (
          <span className="text-muted-foreground font-sans text-xs italic">{missingLabel(t)}</span>
        ) : (
          <>
            {fromStep ? printResult(value, referencedDisplay) : formatInput(value)}
            {unit && <span className="text-muted-foreground"> {unit}</span>}
          </>
        )}
      </span>
      {/* Wraps instead of clipping: the label names what the figure above is,
          and a `title` attribute is not shown on a phone. */}
      {label && (
        <span className="card-meta max-w-[11rem] text-center font-normal text-pretty text-muted-foreground [overflow-wrap:anywhere]">
          {label}
        </span>
      )}
    </span>
  )
}

const StepRow: FC<{
  step: CalculationStepData
  index: number
  steps: CalculationStepData[]
  results: Derivation
  display: StepDisplay[]
  tint: DimStatus | null
  emphasis: boolean
  stepReference: 'index' | 'label'
  undefinedText: string | undefined
  t: Translator
}> = ({
  step,
  index,
  steps,
  results,
  display,
  tint,
  emphasis,
  stepReference,
  undefinedText,
  t,
}) => {
  const result = results[index]
  const band = fmtTolerance(result.tolerance, result.unit)
  // Said once, on the step where it happens: a later step that is undecidable
  // only because it builds on this one has nothing new to say.
  const inherited = step.operands.some(
    (operand) => operand.step != null && results[operand.step - 1]?.undecidable
  )
  const color = tint ? statusColor(tint) : null

  return (
    <li className="flex flex-col gap-1">
      <span className="text-muted-foreground text-[11px] font-medium tracking-wider uppercase">
        {step.label}
      </span>
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        {step.operands.map((operand, position) => (
          <span key={`${operand.label}-${position}`} className="flex items-start gap-2">
            {position > 0 && (
              <span
                aria-hidden="true"
                className="text-muted-foreground pt-0.5 font-mono text-[13.5px]"
              >
                {operatorFor(step.operation, operand)}
              </span>
            )}
            <Operand
              operand={operand}
              steps={steps}
              referenced={operand.step != null ? results[operand.step - 1] : undefined}
              referencedDisplay={operand.step != null ? display[operand.step - 1] : undefined}
              stepReference={stepReference}
              t={t}
            />
          </span>
        ))}

        {/* A percentage is a ratio times 100, and a share of a base is a
            product over 100: the constant is part of the rule, so the line
            shows it, or the arithmetic above the result does not add up. */}
        {/* „= result" (and a percentage's „× 100" before it) is one unit, so
            a long sum wraps BEFORE the equals sign, never leaving it alone at
            the end of a line with its result on the next. */}
        <span className="flex items-start gap-2">
          {PERCENT_FACTOR[step.operation] && (
            <span
              aria-hidden="true"
              className="text-muted-foreground pt-0.5 font-mono text-[13.5px]"
            >
              {PERCENT_FACTOR[step.operation]}
            </span>
          )}
          <span aria-hidden="true" className="text-muted-foreground pt-0.5 font-mono text-[13.5px]">
            =
          </span>

          <span className="flex min-w-0 flex-col items-start">
            <span
              className={cn(
                'font-mono whitespace-nowrap',
                emphasis ? 'card-figure-24' : 'pt-0.5 text-[13.5px]',
                color ? undefined : 'text-foreground'
              )}
              style={color ? { color } : undefined}
            >
              {result.value == null ? (
                <span className="text-muted-foreground font-sans text-xs font-normal italic">
                  {missingLabel(t)}
                </span>
              ) : (
                <>
                  {printResult(result.value, display[index])}
                  {result.unit && <span className="font-normal opacity-70"> {result.unit}</span>}
                </>
              )}
            </span>
            {band && (
              <span className="text-muted-foreground text-[10.5px] leading-tight">{band}</span>
            )}
          </span>
        </span>
      </div>

      {result.undecidable && !inherited && (
        <p className="text-muted-foreground max-w-prose text-xs leading-relaxed">
          {result.undecidable === 'undefined'
            ? (undefinedText ?? t('cards.calculation.undefinedResult'))
            : t('cards.calculation.undecidable')}
        </p>
      )}
    </li>
  )
}

export interface DerivationStepsProps {
  steps: CalculationStepData[]
  results: Derivation
  /** One entry per step; a missing entry prints to the house two decimals. */
  display: StepDisplay[]
  /** The verdict colour of the LAST step's result. An intermediate result coloured green would read as a verdict. */
  tint?: DimStatus | null
  /**
   * How an operand that is an earlier step's result is named: by the step's
   * number („aus Schritt 2"), for a model's derivation, whose operand labels are
   * the model's; or by its own label, for a compiled rule, whose labels say it.
   */
  stepReference?: 'index' | 'label'
  /** What a division by zero in a given step means, when the rule can say it better („λ = 0 ist nicht möglich."). */
  undefinedText?: (index: number) => string | undefined
  t: Translator
}

/** The steps of a Rechenweg; the last one's result is the card's figure. */
export const DerivationSteps: FC<DerivationStepsProps> = ({
  steps,
  results,
  display,
  tint = null,
  stepReference = 'index',
  undefinedText,
  t,
}) => (
  <ol className="flex flex-col gap-3">
    {steps.map((step, index) => {
      const last = index === steps.length - 1
      return (
        <StepRow
          key={`${step.label}-${index}`}
          step={step}
          index={index}
          steps={steps}
          results={results}
          display={display}
          tint={last ? tint : null}
          emphasis={last}
          stepReference={stepReference}
          undefinedText={undefinedText?.(index)}
          t={t}
        />
      )
    })}
  </ol>
)
