import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { RotateCcw, Undo2, X } from 'lucide-react';
import { Tip } from './components';
import { cn } from './format';
import type { EnhancePhase, EnhanceTiming, PromptEnhance } from './usePromptEnhance';

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

/** Past its expected time a run keeps creeping toward the end, but never reaches it before it's done. */
export function easedShare(x: number) {
  if (!(x > 0)) return 0;
  return x < 0.8 ? x : 0.8 + 0.17 * (1 - Math.exp(-(x - 0.8) / 0.35));
}

/**
 * How far along a run is, 0 to 1, from what the server expected
 * (enhance-timing.js). Until the first words its share is the expected wait
 * over the whole; after them, the words written so far or the time spent
 * writing, whichever is further. Null with nothing to go on.
 */
export function enhanceProgress(timing: EnhanceTiming | null | undefined, words: number, now: number) {
  if (!timing) return null;
  const { startMs, writeMs, words: expectedWords } = timing.expect;
  const total = Math.max(1, startMs + writeMs);
  const waiting = startMs / total;
  if (!timing.firstTextAt) return waiting * easedShare((now - timing.startedAt) / Math.max(1, startMs));
  const written = Math.max(words / Math.max(1, expectedWords), (now - timing.firstTextAt) / Math.max(1, writeMs));
  return waiting + (1 - waiting) * easedShare(written);
}

/**
 * The rim: heat traced along the prompt's edge. Once the server says how long
 * the run should take, it fills from the top-left corner round the whole edge
 * over that time, at an even pace along the outline (an SVG stroke, so the
 * corners and the long sides move alike): a faint ember line under it, the
 * trail behind cooling in steps, a white-hot tip with a bloom. Words arriving
 * stoke it. With nothing expected (queued, the Settings preview) it runs as a
 * fuse round the edge. Done, it closes the ring and flares.
 */
export function EnhanceAura({ phase, pulse, timing = null, words = 0 }: { phase: EnhancePhase; pulse: number; timing?: EnhanceTiming | null; words?: number }) {
  const reduced = useReducedMotion();
  const node = useRef<HTMLDivElement | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);
  const head = useRef<HTMLElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0, r: 0 });
  const heat = useRef(0);
  const seen = useRef(pulse);
  // The loop reads the latest of these without restarting.
  const live = useRef({ phase, timing, words });
  live.current = { phase, timing, words };

  useEffect(() => {
    const grown = pulse - seen.current;
    seen.current = pulse;
    if (grown > 0) heat.current = Math.min(1, heat.current + 0.14 + grown * 0.012);
  }, [pulse]);

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
    const measure = outline.querySelector<SVGRectElement>('[data-part="base"]');
    // Every drawn layer, the blurred glow's own SVG included.
    const paths = Array.from(aura.querySelectorAll<SVGRectElement>('rect[data-part]:not([data-part="base"])'));
    if (!measure) return;
    const length = measure.getTotalLength();
    if (!length) return;
    let shown = 0;
    let loop = 0;
    let before = performance.now();
    let frame = 0;
    const draw = (from: number, to: number) => {
      // A dash pattern exactly one outline long repeats seamlessly, so a fuse can run past the start corner.
      for (const path of paths) {
        const part = path.dataset.part;
        const span = to - from;
        const piece = part === 'tip' ? Math.min(span, length * 0.012) : part === 'warm' || part === 'flame' ? Math.min(span, length * 0.09) : span;
        path.style.strokeDasharray = `${piece} ${length - piece}`;
        path.style.strokeDashoffset = `${-(to - piece)}`;
      }
      const point = measure.getPointAtLength(((to % length) + length) % length);
      if (head.current) head.current.style.transform = `translate(${point.x}px, ${point.y}px)`;
    };
    const step = (now: number) => {
      const seconds = Math.min(0.05, (now - before) / 1000);
      before = now;
      const { phase: current, timing: clock, words: written } = live.current;
      heat.current = Math.max(0, heat.current - seconds * 0.9);
      aura.style.setProperty('--enhance-heat', heat.current.toFixed(3));
      const expected = current === 'done' ? 1 : enhanceProgress(clock, written, now);
      if (expected === null) {
        // Nothing expected yet: a fuse of a third of the edge, burning faster as the words come.
        loop = (loop + seconds * (0.16 + heat.current * 0.5)) % 1;
        draw(length * loop - length * 0.32, length * loop);
      } else {
        // Eases toward where the run should be, never backwards.
        shown = Math.max(shown, shown + (expected - shown) * (1 - Math.exp(-seconds * 7)));
        if (current === 'done' && expected - shown < 0.002) shown = 1;
        draw(0, length * Math.min(1, shown));
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [box, reduced]);

  const inset = 0.75;
  const rect = { x: inset, y: inset, width: Math.max(0, box.w - inset * 2), height: Math.max(0, box.h - inset * 2), rx: Math.max(0, box.r - inset) };
  return (
    <div ref={node} className={cn('enhance-aura', reduced && 'is-still', phase === 'done' && 'is-done')} data-phase={phase}>
      <i className="enhance-bloom" aria-hidden="true" />
      {box.w ? (
        // The glow blurs as a whole SVG: a filter on a shape inside one isn't drawn everywhere (Safari).
        <svg className="enhance-rim enhance-rim-glow-layer" width={box.w} height={box.h} aria-hidden="true">
          <rect {...rect} data-part="glow" className="enhance-rim-glow" />
          <rect {...rect} data-part="flame" className="enhance-rim-flame" />
        </svg>
      ) : null}
      {box.w ? (
        <svg ref={svg} className="enhance-rim" width={box.w} height={box.h} aria-hidden="true">
          <rect {...rect} data-part="base" className="enhance-rim-base" />
          <rect {...rect} data-part="trail" className="enhance-rim-trail" />
          <rect {...rect} data-part="warm" className="enhance-rim-warm" />
          <rect {...rect} data-part="tip" className="enhance-rim-tip" />
        </svg>
      ) : null}
      <i ref={head as React.RefObject<HTMLElement>} className="enhance-head" aria-hidden="true" />
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
    const timer = window.setTimeout(() => setFinishing(false), 700);
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

  // Newest words in view, as a textarea would scroll.
  useLayoutEffect(() => {
    if (ghost.current) ghost.current.scrollTop = ghost.current.scrollHeight;
  }, [text]);

  return (
    <AnimatePresence>
      {busy || finishing ? (
        <motion.div
          key="aura"
          className="enhance-aura-shell"
          aria-hidden="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, scale: reduced ? 1 : 1.012, transition: { duration: 0.6, ease: [0.16, 1, 0.3, 1] } }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        >
          <EnhanceAura phase={finishing ? 'done' : phase} pulse={text.length} timing={timing} words={countWords(text)} />
        </motion.div>
      ) : null}
      {busy && box ? (
        <motion.div
          key="ghost"
          ref={ghost}
          className={cn('enhance-ghost', text ? 'is-writing' : 'is-waiting')}
          style={box}
          aria-hidden="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
          transition={{ duration: 0.2 }}
        >
          {text ? <EnhanceWords text={text} /> : <span className="enhance-scan">{original.trim() || ' '}</span>}
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
