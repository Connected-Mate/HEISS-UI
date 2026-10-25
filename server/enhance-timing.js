/**
 * How long a prompt enhance takes here, learned from the runs this computer
 * has made, so the prompt's rim can fill over the time it will really take.
 *
 * A run has two parts, timed from the moment ComfyUI starts it (time spent
 * queued behind a render is never counted):
 *   start  until the first words arrive: loading the model when it isn't in
 *          memory, reading the picture when there is one, the first token;
 *   write  from the first words to the last: words times this model's pace.
 *
 * The start depends almost entirely on whether the model is still loaded, and
 * nothing in ComfyUI says so up front. So each run is filed under the
 * situation it started in, and each situation learns its own time:
 *   cold          the first run since HEISS or ComfyUI started, or since
 *                 ComfyUI was seen going away (a refused connection);
 *   warm          shortly after the last run, nothing in between;
 *   after-render  a render (or another enhancer model) ran since, which may
 *                 have pushed the model out of memory, depending on the card;
 *   idle          the last run was a long time ago.
 * Each situation is kept apart for runs with and without a picture.
 *
 * Robust by construction: estimates are medians of recent runs with outliers
 * cut by their median absolute deviation; one or two runs only lean on the
 * defaults; stopped, failed and incomplete runs teach nothing; a run guessed
 * cold that came back at warm speed (HEISS restarted, ComfyUI didn't) is filed
 * as warm, and the reverse as cold, so one wrong guess can't smear the two;
 * every number is clamped to sane bounds; and the file holds only recent runs,
 * so a new graphics card or model is learned within a few runs.
 */
import path from "node:path";
import { dataDir } from "./gallery-store.js";
import { readJsonFile, writeJsonFile } from "./json-store.js";

export const STATES = ["cold", "warm", "after-render", "idle"];
const IDLE_AFTER_MS = 30 * 60_000;
// Recent runs kept per list, and how many the estimate reads.
const KEEP = 24;
const WINDOW = 12;
// Until a list has this many runs, the estimate leans on the default.
const TRUSTED = 3;

/** Before anything is learned: an 8 GB card running the 4B enhancer. */
const DEFAULT_START = {
  cold: { text: 18_000, image: 21_000 },
  warm: { text: 1_200, image: 2_600 },
  "after-render": { text: 9_000, image: 11_000 },
  idle: { text: 2_500, image: 4_000 }
};
const DEFAULT_MS_PER_WORD = 60;
const START_BOUNDS = [150, 240_000];
const PER_WORD_BOUNDS = [4, 1_000];
const RATIO_BOUNDS = [0.3, 3];

const file = () => path.join(dataDir, "enhance-timing.json");
let store = null;

function load() {
  if (store) return store;
  try {
    const value = readJsonFile(file());
    store = value && value.version === 1 && typeof value.models === "object" ? value : { version: 1, models: {} };
  } catch {
    store = { version: 1, models: {} };
  }
  return store;
}

function save() {
  try { writeJsonFile(file(), store); } catch { /* learning is a nicety: a full disk only means it forgets */ }
}

const clamp = (value, [low, high]) => Math.min(high, Math.max(low, value));
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * The typical value of a list of recent runs: the median of the last few,
 * after dropping any run far from the rest (a swap storm, a stuck driver).
 * Null when there is nothing to go on.
 */
export function robustEstimate(values = []) {
  const recent = values.filter(finite).slice(-WINDOW);
  if (!recent.length) return null;
  const middle = median(recent);
  const spread = median(recent.map((value) => Math.abs(value - middle))) * 1.4826;
  // Never tighter than a quarter of the value: a few identical runs aren't a reason to drop the next.
  const tolerance = Math.max(spread * 4, middle * 0.25);
  const kept = recent.filter((value) => Math.abs(value - middle) <= tolerance);
  return { value: median(kept.length ? kept : recent), count: recent.length };
}

/** A learned value leaned toward the default until enough runs back it. */
function blend(values, fallback) {
  const estimate = robustEstimate(values);
  if (!estimate) return { value: fallback, learned: false };
  const weight = Math.min(1, estimate.count / TRUSTED);
  return { value: fallback + (estimate.value - fallback) * weight, learned: weight >= 1 };
}

function modelEntry(model) {
  const models = load().models;
  const key = String(model || "default").slice(0, 255);
  models[key] ||= { start: {}, perWord: [], ratio: {} };
  return models[key];
}

const startKey = (state, image) => `${state}:${image ? "image" : "text"}`;

/** The expected start for a situation, borrowing from the same situation without (or with) a picture while it has no runs. */
function startFor(entry, state, image) {
  const own = entry.start[startKey(state, image)] || [];
  const fallback = DEFAULT_START[state][image ? "image" : "text"];
  if (robustEstimate(own)) return blend(own, fallback);
  const other = robustEstimate(entry.start[startKey(state, !image)] || []);
  if (!other) return { value: fallback, learned: false };
  // The picture's share of the default carries over: reading one costs about the same in every situation.
  const scale = DEFAULT_START[state][image ? "image" : "text"] / DEFAULT_START[state][image ? "text" : "image"];
  return { value: other.value * scale, learned: false };
}

/* ------------------------------------------------------------ The situation */

// In memory only: after a HEISS restart nothing is known, and the first run counts as cold
// (and is refiled as warm if ComfyUI had kept the model; see recordEnhanceRun).
const runtime = { gone: 0, work: 0, last: null };

/** ComfyUI refused a connection: it stopped or restarted, so nothing is in memory any more. */
export function noteComfyGone() {
  runtime.gone += 1;
}

/** A render, upscale or other ComfyUI work finished: it may have pushed the enhancer out of memory. */
export function noteComfyWork() {
  runtime.work += 1;
}

/** What the next run with `model` most likely starts from. */
export function enhanceSituation(model, now = Date.now()) {
  const last = runtime.last;
  if (!last || last.gone !== runtime.gone) return "cold";
  if (last.model !== model || last.work !== runtime.work) return "after-render";
  return now - last.at > IDLE_AFTER_MS ? "idle" : "warm";
}

/* ------------------------------------------------------------ Expect and learn */

/** The middle of the length the prompt is asked to have, in words. */
export const askedWords = ([low, high] = [70, 130]) => Math.max(1, Math.round((low + high) / 2));

/**
 * What a run should take, said when ComfyUI starts it:
 * `{ situation, startMs, writeMs, words, learned }`. `asked` is the word range
 * the prompt is asked for (prompt-enhance.js promptLength).
 */
export function expectEnhance({ model, image = false, target = "image", asked = [70, 130], now = Date.now() } = {}) {
  const entry = modelEntry(model);
  const situation = enhanceSituation(model, now);
  const start = startFor(entry, situation, image);
  const pace = blend(entry.perWord, DEFAULT_MS_PER_WORD);
  const ratio = blend(entry.ratio[target] || [], 1);
  const words = Math.max(1, Math.round(askedWords(asked) * clamp(ratio.value, RATIO_BOUNDS)));
  return {
    situation,
    startMs: Math.round(clamp(start.value, START_BOUNDS)),
    writeMs: Math.round(words * clamp(pace.value, PER_WORD_BOUNDS)),
    words,
    learned: start.learned && pace.learned
  };
}

/** Which situation a finished run belongs to, by what it was guessed to be and how it actually went. */
export function fileSituation(entry, guessed, startMs, image) {
  if (guessed !== "cold" && guessed !== "warm") return guessed;
  const warm = startFor(entry, "warm", image).value;
  const cold = startFor(entry, "cold", image).value;
  // Halfway between the two on a log scale: a start ten times warm is not "a slow warm".
  const split = Math.sqrt(warm * cold);
  if (guessed === "cold" && startMs < split) return "warm";
  if (guessed === "warm" && startMs > split) return "cold";
  return guessed;
}

const push = (list, value) => { list.push(Math.round(value * 1000) / 1000); if (list.length > KEEP) list.splice(0, list.length - KEEP); };

/**
 * Learns from one finished run. Only complete runs count: one that was
 * stopped, failed, or never streamed its words is left out by the caller.
 * `situation` is what expectEnhance said when the run started.
 */
export function recordEnhanceRun({ model, image = false, target = "image", asked = [70, 130], situation, startMs, writeMs, words, now = Date.now() } = {}) {
  if (!STATES.includes(situation) || !finite(startMs) || startMs <= 0) return null;
  const entry = modelEntry(model);
  const filed = fileSituation(entry, situation, startMs, image);
  const starts = (entry.start[startKey(filed, image)] ||= []);
  push(starts, clamp(startMs, START_BOUNDS));
  // A pace from a handful of words is mostly the end-of-run wait; it needs a real prompt to mean anything.
  if (finite(writeMs) && finite(words) && words >= 8 && writeMs > 0) push(entry.perWord, clamp(writeMs / words, PER_WORD_BOUNDS));
  if (finite(words) && words > 0) push((entry.ratio[target] ||= []), clamp(words / askedWords(asked), RATIO_BOUNDS));
  runtime.last = { model, at: now, gone: runtime.gone, work: runtime.work };
  save();
  return filed;
}

/**
 * A run ComfyUI started but that taught nothing (stopped, failed): the model
 * was loaded all the same, so the next run starts warm.
 */
export function noteEnhanceRan(model, now = Date.now()) {
  runtime.last = { model, at: now, gone: runtime.gone, work: runtime.work };
}

/** Tests: start from nothing. */
export function resetEnhanceTiming() {
  store = { version: 1, models: {} };
  runtime.gone = 0;
  runtime.work = 0;
  runtime.last = null;
}
