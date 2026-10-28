'use client'

import * as React from 'react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

/**
 * Toast durations, owned here rather than at the ~40 call sites.
 *
 * NOTE on the error case: sonner 2.x exposes only ONE central duration (the
 * `duration` prop below, the fallback for every toast a call site creates
 * without its own). A longer error duration (6000ms) is therefore not
 * expressible from this file — it would need each `toast.error(…)` call to
 * pass `duration: 6000`, and those calls belong to other surfaces. Until that
 * is centralized behind a shared `notify` helper, errors share the default
 * below; the longer read is carried by persistence of attention (the error
 * tone below), not by time.
 */
const TOAST_DURATION_MS = 4000

function Toaster({ ...props }: ToasterProps) {
  const [theme, setTheme] = React.useState<'light' | 'dark'>('light')

  React.useEffect(() => {
    const root = document.documentElement

    const updateTheme = () => {
      setTheme(root.classList.contains('dark') ? 'dark' : 'light')
    }

    updateTheme()

    const observer = new MutationObserver(updateTheme)
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })

    return () => observer.disconnect()
  }, [])

  return (
    <Sonner
      theme={theme}
      position="top-right"
      richColors={false}
      duration={TOAST_DURATION_MS}
      gap={8}
      className="toaster group"
      toastOptions={{
        classNames: {
          // The background lives on the per-tone entries rather than here, so
          // the error tone can carry its own body without fighting the base
          // for the same `bg-*` (sonner concatenates the two, and two
          // backgrounds resolve by stylesheet order — invisible in review).
          // Every non-error tone stays monochrome (`bg-popover`); error alone
          // gains the danger-subtle body. Icons are untouched throughout, so
          // error stays distinguishable without color alone.
          // One full hairline on every toast, and no accent edge (side
          // stripes are discouraged, design-language.md "Emphasis
          // without a stripe"): the tone is the icon, in its signal ink, and
          // the toast's own words.
          toast: 'text-popover-foreground border-border rounded-xl border shadow-md',
          default: 'bg-popover',
          loading: 'bg-popover',
          success: 'bg-popover [&_[data-icon]]:text-success',
          error: 'border-danger bg-danger-subtle [&_[data-icon]]:text-error',
          warning: 'bg-popover [&_[data-icon]]:text-warning',
          info: 'bg-popover [&_[data-icon]]:text-info',
        },
      }}
      {...props}
    />
  )
}

/**
 * The toaster of a full-screen modal layer (the Prüfansicht), mounted INSIDE it
 * and centred at the foot of the box it sits in, `foot` pixels up.
 *
 * The app's toaster sits top-right of the viewport, outside every dialog. Over a
 * modal layer that is wrong twice: the corner is where the layer keeps its own
 * controls, and a modal Radix dialog takes pointer events from everything
 * outside it, so a toast's action there cannot be clicked at all (nor reached
 * by Tab, which the dialog keeps inside). A toast shown with `toasterId: id`
 * lands here instead; every other toast still goes to the app's.
 *
 * The wrapper is the anchor: `contain: layout` makes it the containing block of
 * sonner's `position: fixed` list, so `bottom-center` means the middle of the
 * box this is placed in, not of the viewport. It has no height, so it covers
 * nothing; the toasts themselves overflow it upwards.
 */
function LayerToaster({ id, foot, ...props }: ToasterProps & { id: string; foot: number }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-50 h-0 [contain:layout] [&_[data-sonner-toast]]:pointer-events-auto">
      <Toaster id={id} position="bottom-center" offset={{ bottom: foot }} mobileOffset={{ bottom: foot }} {...props} />
    </div>
  )
}

export { LayerToaster, Toaster }
