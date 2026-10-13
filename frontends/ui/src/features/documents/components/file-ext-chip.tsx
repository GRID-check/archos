import type { JSX, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { extChipTint, fileExtensionLabel } from '../document-kind'

/**
 * A file's extension as a tinted tile: "PDF", "DWG", "IFC".
 *
 * The first thing that says WHICH kind of file a header is about, before the
 * reader has parsed the name. One component for the modal header and the chat
 * peek, so the two never disagree on the tint a type gets (`extChipTint`).
 * A five-letter extension ("IFCZIP") steps the type down rather than spilling
 * out of the tile. `fallback` is drawn when the name carries no extension.
 */
export function FileExtChip({
  filename,
  fallback,
  size = 'md',
  className,
}: {
  filename: string
  fallback?: ReactNode
  size?: 'sm' | 'md'
  className?: string
}): JSX.Element {
  const ext = fileExtensionLabel(filename)
  return (
    <span
      data-testid="file-ext-chip"
      className={cn(
        'flex shrink-0 items-center justify-center font-bold uppercase leading-none tracking-tight',
        size === 'md' ? 'size-9 rounded-lg text-xs' : 'size-8 rounded-md text-[10px]',
        ext.length > 4 && 'text-[9px]',
        className,
      )}
      style={extChipTint(ext)}
      aria-hidden
    >
      {ext || fallback}
    </span>
  )
}
