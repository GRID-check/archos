import type { JSX, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * LiveCursor — somebody else's pointer on a shared canvas: the arrow in their
 * colour, and their name on a tag beside it.
 *
 * Its tip is the top-left of the element, so the caller places it with
 * `left`/`top` on the point and nothing else. Motion is the caller's: the
 * pointer arrives a dozen times a second and the caller glides between the
 * samples.
 *
 * `busy`: they are about to set a mark (a point or a region tool in hand), so
 * the tag says so with a glyph: the room sees a colleague take aim before the
 * mark lands, the way people round a table see a pen come down.
 *
 * `chat`: a line of cursor chat. The tag grows into a bubble that keeps the
 * name above the words, so a room always knows who said „hier fehlt die
 * Kote", and the words wrap rather than run off the sheet.
 *
 * `idle`: the pointer has not moved for a while. The arrow stays where it was,
 * quieter, and the tag folds away, so a colleague who went for coffee does not
 * keep a label over the drawing.
 */
export function LiveCursor({
  color,
  label,
  icon,
  busy,
  chat,
  idle,
  className,
}: {
  color: string
  label: string
  icon?: ReactNode
  busy?: ReactNode
  chat?: string | null
  idle?: boolean
  className?: string
}): JSX.Element {
  return (
    <span
      data-slot="live-cursor"
      data-idle={idle || undefined}
      className={cn(
        'pointer-events-none absolute top-0 left-0 block transition-opacity duration-base ease-out motion-reduce:transition-none',
        idle && 'opacity-55',
        className
      )}
    >
      <svg
        aria-hidden
        width="18"
        height="20"
        viewBox="0 0 18 20"
        className="block drop-shadow-[0_1px_1.5px_rgb(0_0_0/0.35)]"
      >
        <path
          d="M1.5 1.5 L1.5 16.2 L5.6 12.6 L8.4 18.6 L11.1 17.4 L8.4 11.5 L14 11.5 Z"
          fill={color}
          stroke="white"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
      {chat ? (
        <span
          data-slot="live-cursor-chat"
          className="absolute top-[15px] left-[12px] flex w-max max-w-60 flex-col rounded-2xl rounded-tl-sm px-2.5 py-1.5 text-white shadow-md"
          style={{ backgroundColor: color }}
        >
          <span className="flex items-center gap-1 text-[10px] leading-3 font-medium opacity-85">
            {icon}
            <span className="truncate">{label}</span>
          </span>
          <span className="text-xs leading-4 font-medium break-words whitespace-pre-wrap">{chat}</span>
        </span>
      ) : (
        <span
          className={cn(
            'absolute top-[15px] left-[12px] inline-flex max-w-44 items-center gap-1 rounded-full rounded-tl-sm px-2 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap text-white shadow-md',
            'origin-top-left transition-[opacity,transform] duration-base ease-out motion-reduce:transition-none',
            idle && 'scale-90 opacity-0'
          )}
          style={{ backgroundColor: color }}
        >
          {icon}
          <span className="truncate">{label}</span>
          {busy}
        </span>
      )}
    </span>
  )
}
