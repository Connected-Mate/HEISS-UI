import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.HEISS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "heiss-enhance-timing-"));
const timing = await import("./enhance-timing.js");
const { expectEnhance, enhanceSituation, fileSituation, noteComfyGone, noteComfyWork, noteEnhanceRan, recordEnhanceRun, resetEnhanceTiming, robustEstimate } = timing;

const model = "qwen3-vl-4b.gguf";
const asked = [70, 130];
const run = (situation, startMs, extra = {}) => recordEnhanceRun({ model, asked, situation, startMs, writeMs: 6000, words: 100, ...extra });

test("with nothing learned, a run expects the defaults, cold first", () => {
  resetEnhanceTiming();
  const first = expectEnhance({ model, asked });
  assert.equal(first.situation, "cold");
  assert.equal(first.learned, false);
  assert.ok(first.startMs > 10_000);
  assert.equal(first.words, 100);
  assert.equal(first.writeMs, 100 * 60);
  assert.ok(expectEnhance({ model, asked, image: true }).startMs > first.startMs, "a picture takes longer to read");
});

test("the situation follows what happened since the last run", () => {
  resetEnhanceTiming();
  const t = 1_000_000;
  assert.equal(enhanceSituation(model, t), "cold");
  noteEnhanceRan(model, t);
  assert.equal(enhanceSituation(model, t + 5_000), "warm");
  assert.equal(enhanceSituation(model, t + 31 * 60_000), "idle");
  assert.equal(enhanceSituation("other-model.gguf", t + 5_000), "after-render", "another enhancer model took the memory");
  noteComfyWork();
  assert.equal(enhanceSituation(model, t + 5_000), "after-render");
  noteEnhanceRan(model, t + 6_000);
  assert.equal(enhanceSituation(model, t + 7_000), "warm");
  noteComfyGone();
  assert.equal(enhanceSituation(model, t + 7_000), "cold", "ComfyUI went away: nothing is loaded");
});

test("each situation learns its own start, and the next run expects it", () => {
  resetEnhanceTiming();
  for (const ms of [30_000, 32_000, 29_000]) run("cold", ms);
  for (const ms of [800, 900, 850]) run("warm", ms);
  noteEnhanceRan(model);
  const warm = expectEnhance({ model, asked });
  assert.equal(warm.situation, "warm");
  assert.equal(warm.startMs, 850);
  noteComfyGone();
  assert.equal(expectEnhance({ model, asked }).startMs, 30_000);
});

test("one or two runs only lean on the default; three are trusted", () => {
  resetEnhanceTiming();
  run("warm", 400);
  noteEnhanceRan(model);
  const one = expectEnhance({ model, asked }).startMs;
  assert.ok(one > 400 && one < 1_200, `one run moves it partway (${one})`);
  run("warm", 400);
  run("warm", 400);
  noteEnhanceRan(model);
  assert.equal(expectEnhance({ model, asked }).startMs, 400);
});

test("a run far from the others doesn't move the estimate", () => {
  assert.equal(robustEstimate([1000, 1100, 950, 1050, 60_000]).value, 1025);
  assert.equal(robustEstimate([]), null);
  assert.equal(robustEstimate([NaN, Infinity, 500]).value, 500);
  // Only the recent runs count: a new graphics card is learned within a few runs.
  assert.equal(robustEstimate([...Array(20).fill(5000), ...Array(12).fill(1000)]).value, 1000);
});

test("a guess proven wrong is filed by what happened", () => {
  resetEnhanceTiming();
  for (const ms of [20_000, 21_000, 19_000]) run("cold", ms);
  for (const ms of [1_000, 1_100, 900]) run("warm", ms);
  // HEISS restarted but ComfyUI kept the model: guessed cold, came back at warm speed.
  assert.equal(run("cold", 1_200), "warm");
  // Something outside HEISS unloaded it: guessed warm, took a cold load.
  assert.equal(run("warm", 18_000), "cold");
  // The uncertain situations keep what they saw: that is the honest typical value.
  assert.equal(run("after-render", 15_000), "after-render");
  noteComfyGone();
  assert.ok(expectEnhance({ model, asked }).startMs >= 18_000, "the cold estimate still reads as cold");
});

test("with a picture, a situation borrows from its text-only runs until it has its own", () => {
  resetEnhanceTiming();
  for (const ms of [1_000, 1_000, 1_000]) run("warm", ms);
  noteEnhanceRan(model);
  const withImage = expectEnhance({ model, asked, image: true });
  assert.ok(withImage.startMs > 1_000 && withImage.startMs < 3_000, `scaled by the picture's share (${withImage.startMs})`);
  for (const ms of [5_000, 5_000, 5_000]) run("warm", ms, { image: true });
  noteEnhanceRan(model);
  assert.equal(expectEnhance({ model, asked, image: true }).startMs, 5_000);
  assert.equal(expectEnhance({ model, asked }).startMs, 1_000);
});

test("the pace and the length are learned; short or broken runs teach nothing", () => {
  resetEnhanceTiming();
  for (let i = 0; i < 3; i += 1) run("warm", 1000, { writeMs: 3_000, words: 150, target: "image" });
  noteEnhanceRan(model);
  const expected = expectEnhance({ model, asked, target: "image" });
  assert.equal(expected.words, 150, "this model writes longer than asked");
  assert.equal(expected.writeMs, 150 * 20);
  assert.equal(expectEnhance({ model, asked: [25, 45], target: "tags" }).words, 35, "another target keeps its own length");
  // Three words: mostly the end-of-run wait, not a pace.
  run("warm", 1000, { writeMs: 3_000, words: 3, target: "image" });
  noteEnhanceRan(model);
  assert.equal(expectEnhance({ model, asked, target: "image" }).writeMs / expectEnhance({ model, asked, target: "image" }).words, 20);
  assert.equal(recordEnhanceRun({ model, asked, situation: "warm", startMs: NaN }), null);
  assert.equal(recordEnhanceRun({ model, asked, situation: "made-up", startMs: 1000 }), null);
  assert.equal(recordEnhanceRun({ model, asked, situation: "warm", startMs: -5 }), null);
});

test("numbers stay in sane bounds", () => {
  resetEnhanceTiming();
  for (let i = 0; i < 3; i += 1) run("warm", 10_000_000, { writeMs: 1e9, words: 10 });
  noteEnhanceRan(model);
  const expected = expectEnhance({ model, asked });
  assert.ok(expected.startMs <= 240_000);
  assert.ok(expected.writeMs <= expected.words * 1_000);
});

test("what is learned survives a restart of HEISS; a broken file starts over", async () => {
  resetEnhanceTiming();
  for (const ms of [700, 700, 700]) run("warm", ms);
  const file = path.join(process.env.HEISS_DATA_DIR, "enhance-timing.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(saved.models[model].start["warm:text"], [700, 700, 700]);
  fs.writeFileSync(file, "{ not json");
  const fresh = await import(`./enhance-timing.js?again=${Date.now()}`);
  assert.equal(fresh.expectEnhance({ model, asked }).situation, "cold", "a new HEISS knows nothing of ComfyUI's memory");
  assert.equal(fresh.expectEnhance({ model, asked }).learned, false);
});

test("fileSituation leaves uncertain situations alone", () => {
  resetEnhanceTiming();
  const entry = { start: {}, perWord: [], ratio: {} };
  assert.equal(fileSituation(entry, "idle", 60_000, false), "idle");
  assert.equal(fileSituation(entry, "after-render", 500, false), "after-render");
});
