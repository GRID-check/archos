import type { JSX, ReactNode } from 'react'

/** One labelled block of the atoms preview. */
export function Section({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}): JSX.Element {
  return (
    <section className="grid gap-4 border-t border-border pt-6">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="grid gap-4">{children}</div>
    </section>
  )
}
