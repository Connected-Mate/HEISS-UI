import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { RotateCcw, Undo2, X } from 'lucide-react';
import { Tip } from './components';
import { cn } from './format';
import type { EnhancePhase, EnhanceTiming, PromptEnhance } from './usePromptEnhance';
import { completionMs, enhanceProgress, FADE_MS, FINISH_MS, followProgress } from './enhanceProgress';

/**
 * Prompt enhance in the composer (usePromptEnhance.ts): the pixel flame that
 * starts it, a fuse of heat that runs round the prompt faster as the words
 * come, the new words arriving hot and cooling to white behind a block
 * cursor, and the small island above the prompt that says what it is doing
 * and, once done, offers Undo and Try again.
 */

const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent);
export const enhanceShortcut = isMac ? '⌘E' : 'Ctrl+E';

/**
 * The flame on a seven-by-seven pixel grid, top row first: a leaning tip, a
 * side flick, a hollow core and a round foot, so it reads as fire and not as
 * a little tree. Drawn solid: at this size the mark's cell gaps turn it into
 * a dotted grid.
 */
const FLAME_ROWS = [
  '....X..',
  '...XX..',
  '..XXX.X',
  '.XXXXXX',
  '.XX.XXX',
  '.X...X.',
  '..XXX..'
];
const FLAME: Array<[number, number]> = FLAME_ROWS.flatMap((row, y) => [...row].flatMap((cell, x) => (cell === 'X' ? [[x, y] as [number, number]] : [])));
const FLAME_SIZE = FLAME_ROWS.length;

/**
 * Prompt enhance's glyph: the pixel flame. Lit, heat climbs through it a row at
 * a time. It snaps to whole device pixels per cell (`size` rounds to a multiple
 * of seven), so its edges stay crisp instead of going soft and grey.
 */
export function EmberGlyph({ size = 14, lit = false, className }: { size?: number; lit?: boolean; className?: string }) {
  const box = Math.max(1, Math.round(size / FLAME_SIZE)) * FLAME_SIZE;
  return (
    <svg className={cn('ember-glyph', lit && 'is-lit', className)} width={box} height={box} viewBox={`0 0 ${FLAME_SIZE} ${FLAME_SIZE}`} shapeRendering="crispEdges" aria-hidden="true">
      {FLAME.map(([x, y]) => <rect key={`${x}-${y}`} className="cell" x={x} y={y} width={1} height={1} style={{ '--i': FLAME_SIZE - 1 - y } as React.CSSProperties} />)}
      <rect className="stop" x={2} y={2} width={3} height={3} />
    </svg>
  );
}

/** The composer button: the flame, which heats up on hover and burns while it works. Pressing it again stops. */
export function EnhanceButton({ phase, verb, onClick, className }: { phase: EnhancePhase; verb: string; onClick: () => void; className?: string }) {
  const busy = phase === 'queued' || phase === 'loading' || phase === 'writing';
  return (
    <Tip content={busy ? 'Stop (Esc)' : `${verb} (${enhanceShortcut})`}>
      <button
        type="button"
        data-enhance-trigger
        className={cn('negative-toggle is-density-mini enhance-toggle', busy && 'is-busy', className)}
        aria-label={busy ? 'Stop enhancing' : verb}
        aria-busy={busy || undefined}
        onClick={onClick}
      >
        <EmberGlyph lit={busy} />
      </button>
    </Tip>
  );
}

/** The new prompt so far, word by word: each word lands hot and cools, with the cursor at the writing edge. */
export function EnhanceWords({ text, cursor = true }: { text: string; cursor?: boolean }) {
  const parts = text.split(/(\s+)/);
  return (
    <>
      {parts.map((part, index) => /^\s+$/.test(part) ? part : <span key={index} className="enhance-word">{part}</span>)}
      {cursor ? <i className="enhance-cursor" /> : null}
    </>
  );
}

export const countWords = (text: string) => (text.match(/\S+/g) || []).length;

/** Starts and ends at rest, so a completion picks up from the line's slow pace and settles instead of stopping dead. */
const smootherstep = (t: number) => { const x = Math.min(1, Math.max(0, t)); return x * x * x * (x * (x * 6 - 15) + 10); };

/**
 * Prompt enhance's light, meant to be felt more than seen. Behind the glass a
 * soft warm haze sits low under the prompt, wider than it and fading out with
 * no edge, drifting slowly and coming up as the run gets along. On the edge a
 * hairline, with no glow, traces how far along the run is: it fills from the
 * top-left corner over the time the server expects (enhance-timing.js), at an
 * even pace along the outline, easing, never back. Until ComfyUI starts the
 * run there is no line, only the haze breathing. Done, early or late, the
 * line carries on and closes the ring in one eased stroke, then the line and
 * the haze fade together. `idle="fuse"` is for the demos, which have no
 * clock: a short hairline runs slowly round the edge.
 */
export function EnhanceAura({ phase, pulse, timing = null, words = 0, idle = 'calm' }: { phase: EnhancePhase; pulse: number; timing?: EnhanceTiming | null; words?: number; idle?: 'calm' | 'fuse' }) {
  const reduced = useReducedMotion();
  const node = useRef<HTMLDivElement | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0, r: 0 });
  // Where the line has got to, as a share of the edge. Kept across re-measures: the prompt grows
  // a line at a time as the words come, and the line must carry on from where it was.
  const shown = useRef(0);
  const loop = useRef(0);
  const finish = useRef<{ at: number; from: number; ms: number } | null>(null);
  const live = useRef({ phase, timing, words, idle });
  live.current = { phase, timing, words, idle };
  // `pulse` stays in the signature for the demos; the light no longer reacts to each word.
  void pulse;

  // The outline follows the prompt's own box and corner radius.
  useLayoutEffect(() => {
    const aura = node.current;
    if (!aura) return;
    const measure = () => {
      const rect = aura.getBoundingClientRect();
      const radius = parseFloat(getComputedStyle(aura).borderTopLeftRadius) || 0;
      setBox((current) => (current.w === rect.width && current.h === rect.height && current.r === radius ? current : { w: rect.width, h: rect.height, r: radius }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(aura);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const aura = node.current;
    const outline = svg.current;
    if (!aura || !outline || !box.w || reduced) return;
    const measure = outline.querySelector<SVGRectElement>('[data-part="track"]');
    const paths = Array.from(outline.querySelectorAll<SVGRectElement>('rect[data-part]:not([data-part="track"])'));
    if (!measure) return;
    const length = measure.getTotalLength();
    if (!length) return;
    let before = performance.now();
    let frame = 0;
    // From and to as shares of the edge, so a re-measured outline picks up exactly where the last one was.
    const draw = (from: number, to: number) => {
      const span = Math.max(0, to - from) * length;
      for (const path of paths) {
        // The lead: the last stretch, a shade brighter, so the line reads as moving without a bright tip.
        const piece = path.dataset.part === 'lead' ? Math.min(span, length * 0.06) : span;
        // A dash pattern exactly one outline long repeats seamlessly, so a fuse can run past the start corner.
        path.style.strokeDasharray = `${piece} ${length - piece}`;
        path.style.strokeDashoffset = `${-(to * length - piece)}`;
      }
    };
    const step = (now: number) => {
      const seconds = Math.min(0.05, (now - before) / 1000);
      before = now;
      const { phase: current, timing: clock, words: written, idle: resting } = live.current;
      let fade = 1;
      if (current === 'done') {
        // Done: carry on from here and close the ring, eased, then let everything go.
        finish.current ||= { at: now, from: shown.current, ms: shown.current > 0 ? completionMs(1 - shown.current) : 0 };
        const { at, from, ms } = finish.current;
        const t = now - at;
        if (from > 0) shown.current = from + (1 - from) * smootherstep(t / ms);
        fade = 1 - smootherstep((t - ms) / FADE_MS);
        draw(0, from > 0 ? shown.current : 0);
      } else {
        finish.current = null;
        const expected = enhanceProgress(clock, written, now);
        if (expected === null) {
          // Before ComfyUI starts the run (or a new one, after Try again): from the start.
          shown.current = 0;
          if (resting === 'fuse') {
            loop.current = (loop.current + seconds * 0.09) % 1;
            draw(loop.current - 0.22, loop.current);
          } else draw(0, 0);
        } else {
          // Follows where the run should be: exactly while it moves steadily, calmly after a jump, never back.
          shown.current = followProgress(shown.current, expected, seconds);
          draw(0, Math.min(1, shown.current));
        }
      }
      aura.style.setProperty('--enhance-progress', Math.min(1, shown.current).toFixed(3));
      aura.style.setProperty('--enhance-fade', fade.toFixed(3));
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [box, reduced]);

  const inset = 0.5;
  const rect = { x: inset, y: inset, width: Math.max(0, box.w - inset * 2), height: Math.max(0, box.h - inset * 2), rx: Math.max(0, box.r - inset) };
  const waiting = !timing && phase !== 'done' && idle === 'calm';
  return (
    <div ref={node} className={cn('enhance-aura', reduced && 'is-still', waiting && 'is-waiting', phase === 'done' && 'is-done')} data-phase={phase}>
      {/* Light behind the glass, under the prompt's frosted surface (its ::before sits at -1). */}
      <i className="enhance-haze" aria-hidden="true"><i /></i>
      {box.w ? (
        <svg ref={svg} className="enhance-rim" width={box.w} height={box.h} aria-hidden="true">
          <rect {...rect} data-part="track" className="enhance-rim-track" />
          <rect {...rect} data-part="line" className="enhance-rim-line" />
          <rect {...rect} data-part="lead" className="enhance-rim-lead" />
        </svg>
      ) : null}
    </div>
  );
}

/**
 * Over the prompt while it works: the fuse, and in the textarea's own box the
 * person's words with a scan line stepping over them until the model's arrive.
 */
export function EnhanceOverlay({ enhance, field, original }: { enhance: PromptEnhance; field: React.RefObject<HTMLTextAreaElement | null>; original: string }) {
  const reduced = useReducedMotion();
  const ghost = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<React.CSSProperties | null>(null);
  const { busy, text, phase, timing } = enhance;
  // A finished run's rim closes and flares before it fades, instead of vanishing mid-stroke.
  const [finishing, setFinishing] = useState(false);
  const wasBusy = useRef(busy);
  useEffect(() => {
    const ended = wasBusy.current && !busy && phase === 'done';
    wasBusy.current = busy;
    if (!ended || reduced) return;
    setFinishing(true);
    const timer = window.setTimeout(() => setFinishing(false), FINISH_MS);
    return () => { window.clearTimeout(timer); setFinishing(false); };
  }, [busy, phase, reduced]);

  // The ghost sits exactly on the textarea, with its type, so the words land where they will stay.
  useLayoutEffect(() => {
    const area = field.current;
    if (!busy || !area) return;
    const place = () => {
      const style = getComputedStyle(area);
      setBox({
        top: area.offsetTop, left: area.offsetLeft, width: area.offsetWidth, height: Math.max(area.offsetHeight, 44),
        padding: style.padding, font: style.font, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, textAlign: style.textAlign as React.CSSProperties['textAlign']
      });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(area);
    return () => observer.disconnect();
  }, [busy, field]);

  // Newest words in view, as a textarea would scroll. The prompt underneath scrolls with them, so
  // when the ghost fades at the end the same lines are where they were, not the prompt's first ones.
  useLayoutEffect(() => {
    if (ghost.current) ghost.current.scrollTop = ghost.current.scrollHeight;
    const area = field.current;
    if (area && text) area.scrollTop = area.scrollHeight;
  }, [text, field]);
  useLayoutEffect(() => {
    const area = field.current;
    if (!busy && area && phase === 'done') area.scrollTop = area.scrollHeight;
  }, [busy, phase, field]);

  // The person's own words as they were when the run started (`original` becomes the new text as it
  // is written), and where the prompt was scrolled, so their layer shows exactly what was on screen.
  const before = useRef('');
  const beforeScroll = useRef(0);
  if (busy && !text) before.current = original;
  const wasWaiting = useRef(false);
  useLayoutEffect(() => {
    const waiting = busy && !text;
    if (waiting && !wasWaiting.current) beforeScroll.current = field.current?.scrollTop || 0;
    wasWaiting.current = waiting;
  }, [busy, text, field]);

  return (
    <AnimatePresence>
      {busy || finishing ? (
        <motion.div
          key="aura"
          className="enhance-aura-shell"
          aria-hidden="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.25 } }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        >
          <EnhanceAura phase={finishing ? 'done' : phase} pulse={text.length} timing={timing} words={countWords(text)} />
        </motion.div>
      ) : null}
      {/* Two layers over the prompt, each in its own box, so neither shifts the other: the person's
          words while it thinks, dissolving where they are; then the new words, from the top. */}
      {busy && box && !text ? (
        <motion.div
          key="before"
          ref={(node: HTMLDivElement | null) => { if (node) node.scrollTop = beforeScroll.current; }}
          className="enhance-ghost is-waiting"
          style={box}
          aria-hidden="true"
          // In place at once, over the words it stands for: they don't blink out and back.
          initial={false}
          exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -4, filter: 'blur(3px)', transition: { duration: 0.55, ease: [0.22, 1, 0.36, 1] } }}
        >
          <span className="enhance-ghost-before">
            <span className="enhance-scan">{before.current.trim() || ' '}</span>
            {/* The same words in full colour on top, fading: they dim into the sheen instead of switching. */}
            {reduced ? null : (
              <motion.span className="enhance-ghost-plain" initial={{ opacity: 1 }} animate={{ opacity: 0 }} transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}>
                {before.current.trim() || ' '}
              </motion.span>
            )}
          </span>
        </motion.div>
      ) : null}
      {busy && box && text ? (
        <motion.div
          key="words"
          ref={ghost}
          className="enhance-ghost is-writing"
          style={box}
          aria-hidden="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.2 } }}
          transition={{ duration: reduced ? 0 : 0.35, ease: [0.22, 1, 0.36, 1] }}
        >
          <EnhanceWords text={text} />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/** What it is doing, in the status voice: a blinking ember cell, then the words in mono capitals and a running count. */
export function EnhanceStatus({ enhance, className }: { enhance: PromptEnhance; className?: string }) {
  const words = countWords(enhance.text);
  return (
    <span className={cn('enhance-status', className)}>
      <i className="enhance-dot" aria-hidden="true" />
      <span className="enhance-status-label">{enhance.working}</span>
      {words ? <span className="enhance-status-count">{words}</span> : null}
    </span>
  );
}

/**
 * Above the prompt's top edge: what it is doing while it works, then Undo and
 * Try again once it is done. One island that changes shape between the two.
 */
export function EnhanceIsland({ enhance }: { enhance: PromptEnhance }) {
  const reduced = useReducedMotion();
  const { busy, settled } = enhance;
  const spring = reduced ? { duration: 0 } : { type: 'spring' as const, stiffness: 520, damping: 38, mass: 0.7 };
  return (
    <AnimatePresence>
      {busy || settled ? (
        <motion.div
          key="island"
          layout
          className={cn('enhance-island', busy ? 'is-busy' : 'is-settled')}
          role="status"
          initial={{ opacity: 0, y: 8, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: 0.97, transition: { duration: 0.18 } }}
          transition={spring}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            {busy ? (
              <motion.span key="working" className="enhance-island-working" layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <EnhanceStatus enhance={enhance} />
                <button type="button" className="enhance-island-stop" onClick={enhance.stop} aria-label="Stop enhancing"><X size={12} /></button>
              </motion.span>
            ) : (
              <motion.span key="done" className="enhance-island-done" layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <button type="button" onClick={enhance.undo}><Undo2 size={13} /> Undo</button>
                <button type="button" onClick={enhance.again}><RotateCcw size={13} /> Try again</button>
                <button type="button" className="enhance-island-close" onClick={enhance.dismiss} aria-label="Keep it"><X size={12} /></button>
              </motion.span>
            )}
          </AnimatePresence>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/**
 * The feature shown on a loop, for the setup dialog and Settings: an idea for
 * a beat, the words arriving at about a model's pace, a rest, then again.
 * Starts over whenever `replay` changes. Returns how many words to show.
 */
export function useEnhanceDemo(total: number, replay?: unknown) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(reduced ? total : 0);
  useEffect(() => {
    if (reduced) { setShown(total); return; }
    let count = 0;
    let timer = 0;
    setShown(0);
    const tick = () => {
      count = count > total + 22 ? 0 : count + 1;
      setShown(Math.min(total, Math.max(0, count - 10)));
      timer = window.setTimeout(tick, count <= 10 ? 120 : 75);
    };
    timer = window.setTimeout(tick, 400);
    return () => window.clearTimeout(timer);
  }, [reduced, total, replay]);
  return shown;
}
