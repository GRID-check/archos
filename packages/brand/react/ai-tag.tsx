import { joinClasses } from './join-classes';

export interface AITagProps {
  /** ink instead of on-ink, for light images */
  ink?: boolean;
  className?: string;
}

/** Marks an AI-generated image. */
export function AITag({ ink = false, className }: AITagProps) {
  return (
    <span className={joinClasses('ui-ai-tag', ink && 'ui-ai-tag-ink', className)} title="KI-generiertes Bild">
      AI
    </span>
  );
}
