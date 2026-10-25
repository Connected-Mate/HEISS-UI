import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { RotateCcw, Undo2, X } from 'lucide-react';
import { Tip } from './components';
import { cn } from './format';
import type { EnhancePhase, PromptEnhance } from './usePromptEnhance';

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

/**
 * The fuse: a short run of heat round the edge with a stepped tail. It idles
 * while the model loads and speeds up with every piece of text that arrives,
 * so a fast model visibly burns hotter. `pulse` is anything that grows as the
 * words come (the text's length).
 */
export function EnhanceAura({ phase, pulse }: { phase: EnhancePhase; pulse: number }) {
  const reduced = useReducedMotion();
  const node = useRef<HTMLDivElement | null>(null);
  const heat = useRef(0);
  const seen = useRef(pulse);
  const writing = useRef(phase === 'writing');
  writing.current = phase === 'writing';

  useEffect(() => {
    const grown = pulse - seen.current;
    seen.current = pulse;
    if (grown > 0) heat.current = Math.min(1, heat.current + 0.14 + grown * 0.012);
  }, [pulse]);

  useEffect(() => {
    const aura = node.current;
    if (!aura || reduced) return;
    let angle = 0;
    let before = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const seconds = Math.min(0.05, (now - before) / 1000);
      before = now;
      heat.current = Math.max(0, heat.current - seconds * 0.9);
      angle = (angle + seconds * ((writing.current ? 140 : 60) + heat.current * 420)) % 360;
      aura.style.setProperty('--enhance-turn', `${angle.toFixed(2)}deg`);
      aura.style.setProperty('--enhance-heat', heat.current.toFixed(3));
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [reduced]);

  return (
    <div ref={node} className={cn('enhance-aura', reduced && 'is-still')} data-phase={phase}>
      <div className="enhance-glow"><i /></div>
      <i className="enhance-edge" />
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
  const { busy, text, phase } = enhance;

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
      {busy ? (
        <motion.div
          key="aura"
          className="enhance-aura-shell"
          aria-hidden="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, scale: reduced ? 1 : 1.012, transition: { duration: 0.6, ease: [0.16, 1, 0.3, 1] } }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        >
          <EnhanceAura phase={phase} pulse={text.length} />
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
