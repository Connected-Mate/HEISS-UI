import assert from "node:assert/strict";
import test from "node:test";
import { completionMs, easedShare, enhanceProgress, followProgress } from "../src/app/enhanceProgress.ts";

/**
 * Whole prompt-enhance runs, frame by frame at 60 fps, through the same maths
 * the composer's line uses: where the line stands when the run actually ends.
 */
function simulate({ expectStart, expectWrite, expectWords = 80, actualStart, actualWrite, actualWords = expectWords }) {
  const frame = 1000 / 60;
  const timing = { expect: { situation: "warm", startMs: expectStart, writeMs: expectWrite, words: expectWords, learned: true }, startedAt: 0, firstTextAt: 0 };
  let shown = 0;
  let biggestStep = 0;
  let worstLag = 0;
  const end = actualStart + actualWrite;
  for (let now = frame; now < end; now += frame) {
    if (!timing.firstTextAt && now >= actualStart) timing.firstTextAt = now;
    const words = timing.firstTextAt ? Math.round(actualWords * Math.min(1, (now - actualStart) / actualWrite)) : 0;
    const target = enhanceProgress(timing, words, now);
    const next = followProgress(shown, target, frame / 1000);
    biggestStep = Math.max(biggestStep, next - shown);
    worstLag = Math.max(worstLag, target - next);
    shown = next;
  }
  return { shown, biggestStep, worstLag };
}

test("a run that takes as long as expected ends with the line nearly closed", () => {
  const { shown } = simulate({ expectStart: 1500, expectWrite: 4000, actualStart: 1500, actualWrite: 4000 });
  assert.ok(shown >= 0.93 && shown < 1, `stood at ${shown.toFixed(3)}`);
  assert.ok(completionMs(1 - shown) < 500, "the closing stroke is short");
});

test("a run a fifth quicker than expected still ends well along", () => {
  const { shown } = simulate({ expectStart: 1500, expectWrite: 4000, actualStart: 1200, actualWrite: 3200 });
  assert.ok(shown >= 0.76, `stood at ${shown.toFixed(3)}`);
});

test("a run slower than expected creeps on but never closes before it's done", () => {
  const { shown } = simulate({ expectStart: 1500, expectWrite: 4000, actualStart: 2500, actualWrite: 7000 });
  assert.ok(shown > 0.96 && shown < 1, `stood at ${shown.toFixed(3)}`);
});

test("steady progress is followed without lag, and a jump is caught up calmly", () => {
  // The first words arrive at a third of the expected wait: the target jumps ahead.
  const { worstLag, biggestStep } = simulate({ expectStart: 6000, expectWrite: 4000, actualStart: 2000, actualWrite: 4000 });
  assert.ok(biggestStep < 0.03, `a frame moved ${biggestStep.toFixed(3)} of the ring`);
  const steady = simulate({ expectStart: 1500, expectWrite: 4000, actualStart: 1500, actualWrite: 4000 });
  assert.ok(steady.worstLag < 0.016, `lagged by ${steady.worstLag.toFixed(3)}`);
  assert.ok(worstLag < 0.4, "the jump is closed within the run");
});

test("the curve is straight to 85%, then eases without reaching the end", () => {
  assert.equal(easedShare(0), 0);
  assert.equal(easedShare(0.5), 0.5);
  assert.equal(easedShare(0.85), 0.85);
  assert.ok(easedShare(1) > 0.94 && easedShare(1) < 0.95);
  assert.ok(easedShare(5) <= 0.985);
  assert.ok(easedShare(0.86) - easedShare(0.85) < 0.0101, "no kink where the curve bends");
  assert.equal(enhanceProgress(null, 0, 1000), null);
  assert.equal(followProgress(0.5, 0.4, 0.016), 0.5, "never back");
});
