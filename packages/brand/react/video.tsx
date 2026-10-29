'use client';

import { useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { joinClasses } from './join-classes';

export interface VideoProps {
  sources: { src: string; type: string }[];
  /** Poster frame with no text in the centre (the play button sits there) */
  poster?: string;
  label?: string;
  /** CSS aspect-ratio; default 2 / 1 */
  ratio?: string;
  loop?: boolean;
  className?: string;
}

/** Muted video with a poster, a centred play button and a progress bar. */
export function Video({ sources, poster, label, ratio, loop = true, className }: VideoProps) {
  const video = useRef<HTMLVideoElement>(null);
  const fill = useRef<HTMLSpanElement>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const el = video.current;
      if (el && el.duration && fill.current) {
        fill.current.style.transform = `scaleX(${el.currentTime / el.duration})`;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  function play() {
    const el = video.current;
    if (!el) return;
    void el.play();
    setPlaying(true);
  }

  function toggle() {
    const el = video.current;
    if (!el) return;
    if (el.paused) {
      void el.play();
      setPlaying(true);
    } else {
      el.pause();
      setPlaying(false);
    }
  }

  function seek(e: MouseEvent<HTMLDivElement>) {
    const el = video.current;
    if (!el || !el.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    el.currentTime = fraction * el.duration;
    if (el.paused) play();
  }

  return (
    <div className={joinClasses('ui-video', className)} style={ratio ? { aspectRatio: ratio } : undefined}>
      <video
        ref={video}
        className="ui-video-media"
        muted
        loop={loop}
        playsInline
        preload="metadata"
        poster={poster}
        aria-label={label}
        onClick={toggle}
      >
        {sources.map((source, i) => (
          <source key={i} src={source.src} type={source.type} />
        ))}
      </video>
      {playing ? null : (
        <button type="button" className="ui-video-play" aria-label="Video abspielen" onClick={play}>
          <span aria-hidden="true" />
        </button>
      )}
      <div className="ui-video-bar" aria-hidden="true" onClick={seek}>
        <span ref={fill} />
      </div>
    </div>
  );
}
