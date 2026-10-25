import React from 'react';
import { ChevronDown, CircleDotDashed, Minus, Plus } from 'lucide-react';
import { cn } from './format';
import { Tip } from './components';
import { usePresence } from './usePresence';
import { useDismiss } from './useDismiss';
import { RowReset } from './SizeMenu';
import type { ControlDensity } from './components';

/* ---------------------------------------------------------------------------
   Steps and Images, folded into the size menu (components.tsx AspectPicker)
   so the composer bar keeps one button for "what comes out": its shape, its
   steps and how many. They sit under the shapes, nearest the button, as two
   rows of one kind: the name on the left in the shapes' own type, and a
   − value + pill on the right that takes typing, the arrow keys, and a hold
   on either end. Steps puts a small Reset arrow before its pill once it
   isn't the model's own.

   A workflow that takes no size gets RunPicker instead: the same two in a
   small menu of their own.
--------------------------------------------------------------------------- */

export type RunNumber = { value: number; min: number; max: number; step: number; onChange: (value: number) => void };
export type RunControl = {
  steps?: RunNumber & { default?: number };
  count?: RunNumber;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What the run settings add to a size, in words: "30 steps · 2 images". */
export function runWords(run?: RunControl) {
  return [run?.steps ? plural(run.steps.value, 'step') : '', run?.count && run.count.value > 1 ? plural(run.count.value, 'image') : ''].filter(Boolean).join(' · ');
}

/** Repeats a step while a button is held: one at once, then quickly after a beat. */
function useHold(stepBy: (direction: number) => void) {
  const hold = React.useRef<{ timer: number; interval: number }>({ timer: 0, interval: 0 });
  const latest = React.useRef(stepBy);
  latest.current = stepBy;
  const stop = React.useCallback(() => {
    window.clearTimeout(hold.current.timer);
    window.clearInterval(hold.current.interval);
  }, []);
  React.useEffect(() => stop, [stop]);
  return (direction: number) => ({
    onPointerDown: (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      stop();
      latest.current(direction);
      hold.current.timer = window.setTimeout(() => { hold.current.interval = window.setInterval(() => latest.current(direction), 60); }, 340);
    },
    // Enter or Space: a click with no pointer behind it.
    onClick: (event: React.MouseEvent) => { if (event.detail === 0) latest.current(direction); },
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop
  });
}

/** − value +, in the size menu's well: type it, arrow it, or hold an end. */
function RunStepper({ label, number }: { label: string; number: RunNumber }) {
  const { value, min, max, step, onChange } = number;
  const clamp = (next: number) => Math.max(min, Math.min(max, Math.round(next / step) * step));
  const valueRef = React.useRef(value);
  valueRef.current = value;
  const stepBy = (direction: number) => {
    const next = clamp(valueRef.current + direction * step);
    if (next !== valueRef.current) { valueRef.current = next; onChange(next); }
  };
  const hold = useHold(stepBy);
  const [draft, setDraft] = React.useState(String(value));
  const [editing, setEditing] = React.useState(false);
  React.useEffect(() => { if (!editing) setDraft(String(value)); }, [value, editing]);
  const commit = () => {
    const typed = Number(draft);
    const next = draft && Number.isFinite(typed) ? clamp(typed) : value;
    if (next !== value) onChange(next);
    setDraft(String(next));
  };
  const lower = label.toLowerCase();
  return (
    <div className="run-stepper">
      <button type="button" aria-label={`Fewer ${lower}`} disabled={value <= min} {...hold(-1)}><Minus size={12} strokeWidth={2.4} /></button>
      <input
        inputMode="numeric"
        aria-label={label}
        value={draft}
        onFocus={(event) => { setEditing(true); event.currentTarget.select(); }}
        onBlur={() => { setEditing(false); commit(); }}
        onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); commit(); event.currentTarget.select(); }
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            stepBy((event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 10 : 1));
            setEditing(false);
          }
        }}
      />
      <button type="button" aria-label={`More ${lower}`} disabled={value >= max} {...hold(1)}><Plus size={12} strokeWidth={2.4} /></button>
    </div>
  );
}

/** The block under the shapes: Images, then Steps, one row each. */
export function RunFields({ run }: { run: RunControl }) {
  const { steps, count } = run;
  if (!steps && !count) return null;
  return (
    <div className="run-fields">
      {count ? (
        <div className="run-row">
          <span className="size-mp-label">Images</span>
          <RunStepper label="Images" number={count} />
        </div>
      ) : null}
      {steps ? (
        <div className="run-row">
          <span className="size-mp-label">Steps</span>
          {steps.default && steps.value !== steps.default
            ? <RowReset label={`Reset to ${steps.default}`} onReset={() => steps.onChange(steps.default!)} />
            : null}
          <RunStepper label="Steps" number={steps} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Steps and Images for a workflow that takes no size: the same block, in a
 * small menu of its own, behind a button that says them.
 */
export function RunPicker({ run, density = 'full' }: { run: RunControl; density?: ControlDensity }) {
  const [open, setOpen] = React.useState(false);
  const presence = usePresence(open);
  const ref = React.useRef<HTMLDivElement | null>(null);
  const close = React.useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  if (!run.steps && !run.count) return null;
  const words = runWords(run) || plural(run.count?.value || 1, 'image');
  const steps = run.steps?.value;
  const count = run.count?.value || 1;
  return (
    <div className={cn('aspect-picker run-picker', density !== 'full' && `is-density-${density}`)} ref={ref} data-open-surface={open || undefined}>
      <Tip content={words}>
        <button type="button" data-open-trigger className="aspect-trigger" aria-label={words} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <span className="aspect-shape-slot"><CircleDotDashed size={15} strokeWidth={1.9} /></span>
          {steps !== undefined && density === 'full' ? <span className="aspect-trigger-label">{plural(steps, 'step')}</span> : null}
          {count > 1 ? <b className="aspect-tag run-count-tag" aria-hidden="true">×{count}</b> : null}
          {density === 'mini' ? null : <ChevronDown size={14} className={cn(open && 'flip')} />}
        </button>
      </Tip>
      {presence.mounted ? (
        <div className={cn('aspect-menu size-menu run-menu', presence.closing && 'is-closing')} data-open-surface role="dialog" aria-label="Steps and images">
          <div className="size-menu-side"><RunFields run={run} /></div>
        </div>
      ) : null}
    </div>
  );
}
