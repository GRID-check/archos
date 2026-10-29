import { Button } from './button';
import { joinClasses } from './join-classes';
import type { NavLink } from './nav-link';

export interface CTABandProps {
  title: string;
  /** lead in ink */
  text?: string;
  primary?: NavLink;
  secondary?: NavLink;
  className?: string;
}

export function CTABand({ title, text, primary, secondary, className }: CTABandProps) {
  return (
    <div className={joinClasses('ui-cta', className)}>
      <div>
        <h2 className="ui-cta-title heading-1">{title}</h2>
        {text ? <p className="ui-cta-text lead">{text}</p> : null}
      </div>
      <div className="ui-cta-actions">
        {primary ? (
          <Button href={primary.href} variant="primary" size="lg">
            {primary.label}
          </Button>
        ) : null}
        {secondary ? (
          <Button href={secondary.href} variant="secondary" size="lg">
            {secondary.label}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
