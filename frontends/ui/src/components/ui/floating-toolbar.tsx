import type { JSX } from 'react'
import type { ComponentProps } from 'react'
import { ButtonGroup } from '@/components/ui/button-group'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * A toolbar that floats over the content it controls: the `ButtonGroup` pill
 * in glass, lifted one elevation step.
 *
 * On the popover plane, the token for anything floating over content.
 * Translucent because what is under it is the reader's document, and an
 * opaque bar over a page reads as a page cut off; blurred so the controls stay
 * legible over a drawing's linework. The same material as the chat toolbar's
 * pills across the seam, so the two halves of the row are one family.
 */
export function FloatingToolbar({ className, ...props }: ComponentProps<typeof ButtonGroup>): JSX.Element {
  return (
    <ButtonGroup
      data-slot="floating-toolbar"
      className={cn(
        'border-base bg-popover/95 gap-0.5 shadow-md backdrop-blur-md',
        className,
      )}
      {...props}
    />
  )
}

/**
 * One icon control inside a toolbar pill: a `size-7` well with a `size-3.5`
 * glyph, which is the pairing the radius and glyph ladders give a `size-7`
 * well. Muted until it is pointed at, so a row of them reads as one quiet
 * object rather than as several buttons competing with the document.
 */
export function ToolbarIconButton({
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, 'variant' | 'size'>): JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn(
        'text-muted-foreground hover:text-foreground size-7 rounded-md [&_svg]:size-3.5 pointer-coarse:size-11',
        className,
      )}
      {...props}
    />
  )
}
