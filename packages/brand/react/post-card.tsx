import type { ReactNode } from 'react';
import { joinClasses } from './join-classes';

export interface PostCardProps {
  title: string;
  text?: string;
  date?: string;
  href?: string;
  /** Image 3:2 */
  media?: ReactNode;
  className?: string;
}

export function PostCard({ title, text, date, href, media, className }: PostCardProps) {
  return (
    <li className={joinClasses('ui-post', className)}>
      <a href={href || '#'}>
        <div className="ui-post-media">{media || null}</div>
        <h3 className="ui-post-title heading-3">{title}</h3>
        {text ? <p className="ui-post-text body">{text}</p> : null}
        {date ? <p className="ui-post-date small">{date}</p> : null}
      </a>
    </li>
  );
}
