import { useCallback, useEffect, useRef, useState } from 'react';
import { enhanceVerb, enhanceWorking, loadEnhanceStatus, openEnhanceSetup, requireEnhance, streamEnhance, type EnhanceExpectation, type EnhanceTarget } from './promptEnhance';
import type { Mode, Profile } from './types';
import type { ShowToast } from './toast';

/**
 * The composer's side of prompt enhance. One press: the prompt is handed to
 * the local model and the new one is written into the box word by word, so it
 * grows as it would under someone typing. Stop (the same button, or Escape)
 * puts the person's own words back; afterwards Undo does, and Try again
 * writes another take from those same words.
 */
export type EnhancePhase = 'idle' | 'queued' | 'loading' | 'writing' | 'done';

/** The run's clock, on this page's `performance.now()`: when ComfyUI started it, when the first words came, and what to expect. */
export type EnhanceTiming = { expect: EnhanceExpectation; startedAt: number; firstTextAt: number };

export type PromptEnhance = {
  phase: EnhancePhase;
  busy: boolean;
  /** The new prompt so far, while it is written. */
  text: string;
  /** What the button does now ("Describe the picture"), and what it is doing while it works. */
  verb: string;
  working: string;
  target: EnhanceTarget | '';
  /** After a finished run, until the prompt is edited: Undo and Try again are offered. */
  settled: boolean;
  /** Once ComfyUI has started the run: how long it should take, for the rim to fill over. */
  timing: EnhanceTiming | null;
  run: () => void;
  again: () => void;
  stop: () => void;
  undo: () => void;
  dismiss: () => void;
};

export function usePromptEnhance({ prompt, setPrompt, mode, profile, imageId, limit, showToast, focus }: {
  prompt: string;
  setPrompt: (text: string) => void;
  mode: Mode;
  profile: Profile | null;
  imageId: string;
  limit: number;
  showToast: ShowToast;
  focus: () => void;
}): PromptEnhance {
  const [phase, setPhase] = useState<EnhancePhase>('idle');
  const [text, setText] = useState('');
  const [target, setTarget] = useState<EnhanceTarget | ''>('');
  const [timing, setTiming] = useState<EnhanceTiming | null>(null);
  const original = useRef('');
  const result = useRef('');
  const controller = useRef<AbortController | null>(null);
  const editing = Boolean(profile?.capabilities?.imageToImage);
  const busy = phase === 'queued' || phase === 'loading' || phase === 'writing';
  const verb = enhanceVerb({ kind: mode, hasImage: Boolean(imageId), hasText: Boolean(prompt.trim()), editing });

  // Known before the first press where it can be, so the button can say "Set up" honestly.
  useEffect(() => { loadEnhanceStatus(); }, []);

  const start = useCallback(async (from: string, again: boolean) => {
    controller.current?.abort();
    const stop = new AbortController();
    controller.current = stop;
    original.current = from;
    setText('');
    setTarget('');
    setTiming(null);
    setPhase('loading');
    try {
      const finished = await streamEnhance({
        prompt: from, kind: mode, family: profile?.family || '', variant: profile?.variant || '', editing,
        image: imageId ? { assetId: imageId } : null, again
      }, (event) => {
        if (event.type === 'start') setTarget(event.target);
        else if (event.type === 'queued' || event.type === 'loading') {
          setPhase(event.type);
          // Timed from here, not from the press: time queued behind a render was never part of it.
          if (event.type === 'loading' && event.expect) setTiming({ expect: event.expect, startedAt: performance.now(), firstTextAt: 0 });
        } else if (event.type === 'text') {
          setTiming((current) => (current && !current.firstTextAt ? { ...current, firstTextAt: performance.now() } : current));
          setText(event.text);
          setPrompt(limit > 0 ? event.text.slice(0, limit) : event.text);
          setPhase('writing');
        }
      }, stop.signal);
      if (controller.current !== stop) return;
      const next = limit > 0 ? finished.slice(0, limit) : finished;
      result.current = next;
      setPrompt(next);
      setText('');
      setPhase('done');
      focus();
    } catch (error) {
      if (controller.current !== stop) return;
      setText('');
      setPhase('idle');
      setPrompt(from);
      const failure = error as Error & { reason?: string };
      if (failure?.name === 'AbortError') return;
      if (failure.reason === 'setup') { openEnhanceSetup(); return; }
      showToast(failure.message || 'Prompt enhance failed.', 'error');
    } finally {
      if (controller.current === stop) controller.current = null;
    }
  }, [mode, profile?.family, profile?.variant, editing, imageId, limit, setPrompt, showToast, focus]);

  const stop = useCallback(() => {
    if (!controller.current) return;
    controller.current.abort();
    controller.current = null;
    setText('');
    setPhase('idle');
    setPrompt(original.current);
  }, [setPrompt]);

  const run = useCallback(() => {
    if (busy) { stop(); return; }
    const from = prompt;
    requireEnhance(() => start(from, false));
  }, [busy, prompt, start, stop]);

  // Another take on the person's own words, not on the last result.
  const again = useCallback(() => { start(original.current, true); }, [start]);

  const undo = useCallback(() => {
    setPrompt(original.current);
    setPhase('idle');
    focus();
  }, [setPrompt, focus]);

  const dismiss = useCallback(() => setPhase((current) => (current === 'done' ? 'idle' : current)), []);

  // Edited after a run: the result is theirs now, Undo would throw that away.
  useEffect(() => {
    if (phase === 'done' && prompt !== result.current) setPhase('idle');
  }, [phase, prompt]);

  useEffect(() => () => controller.current?.abort(), []);

  return {
    phase, busy, text, verb, target, timing,
    working: busy ? enhanceWorking(target, phase === 'queued' ? 'queued' : phase === 'writing' ? 'writing' : 'loading') : '',
    settled: phase === 'done',
    run, again, stop, undo, dismiss
  };
}
