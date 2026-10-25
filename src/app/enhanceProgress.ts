import type { EnhanceTiming } from './usePromptEnhance';

/**
 * How far along a prompt enhance is, for the line on the prompt's edge
 * (EnhanceComposer.tsx). Pure, so scripts/enhance-progress.test.js can run
 * whole runs through it frame by frame.
 */

/**
 * A share of the expected time, as a share of the line. Straight up to 85%,
 * then easing toward the end without reaching it, so a run that takes longer
 * than expected creeps on instead of standing still or finishing early. On
 * time it stands at about 95%, and the closing stroke (completionMs) is short.
 */
export function easedShare(x: number) {
  if (!(x > 0)) return 0;
  if (x <= 0.85) return x;
  // Same slope as the straight part where they meet, so there is no kink in the pace.
  return Math.min(0.985, 0.85 + 0.15 * (1 - Math.exp(-(x - 0.85) / 0.15)));
}

/**
 * Where the run should be, 0 to 1, from what the server expected
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
 * One frame of the line following where the run should be. Steady progress
 * is followed exactly, with no lag; a jump (the first words arriving early)
 * is caught up at a calm pace rather than in one frame. Never goes back.
 */
export function followProgress(shown: number, target: number, seconds: number) {
  const gap = target - shown;
  if (gap <= 0) return shown;
  if (gap < 0.015) return target;
  return Math.min(target, shown + seconds * Math.max(0.3, gap * 3));
}

/** How long the line takes to close the ring once the prompt is done: longer the further it has to go, never abrupt. */
export const completionMs = (remaining: number) => 420 + 640 * Math.min(1, Math.max(0, remaining));
/** After the ring closes, everything fades together. */
export const FADE_MS = 380;
/** How long the overlay keeps the aura once the run is done: the longest completion and the fade. */
export const FINISH_MS = completionMs(1) + FADE_MS + 60;
