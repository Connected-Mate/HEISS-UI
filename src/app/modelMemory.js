// What each model was last run with: steps, CFG, sampler and the like.
// Plain JavaScript so `node --test` can check it without a build step; the
// types live beside it in modelMemory.d.ts.
//
// One record per model, the most recent values only: switching back to a model
// (or opening HEISS again) picks up where you left it, not its defaults. Kept on
// this device, like the draft.

const storageKey = "heiss-ui-model-settings";
/** Models remembered at most; the least recently used goes first. */
const keep = 80;

const numeric = ["steps", "cfg", "denoise", "inpaintStrength", "frames", "fps"];
const named = ["sampler", "scheduler"];

/**
 * `memory` with `modelId`'s record replaced by `values` (the settings it knows, nothing else).
 * @param {Record<string, any>} memory
 * @param {string} modelId
 * @param {Record<string, unknown>} values
 * @param {number} [now]
 */
export function rememberSettings(memory, modelId, values, now = Date.now()) {
  if (!modelId) return memory || {};
  const record = { at: now };
  for (const key of numeric) {
    const value = Number(values?.[key]);
    if (values?.[key] !== undefined && values[key] !== "" && Number.isFinite(value)) record[key] = value;
  }
  for (const key of named) if (typeof values?.[key] === "string" && values[key]) record[key] = values[key];
  const next = { ...(memory || {}), [modelId]: record };
  const ids = Object.keys(next);
  if (ids.length <= keep) return next;
  return Object.fromEntries(ids.sort((a, b) => (next[b]?.at || 0) - (next[a]?.at || 0)).slice(0, keep).map((id) => [id, next[id]]));
}

/**
 * What `profile` was last run with, fitted to what it takes now: numbers within its limits,
 * and only the settings it has (no CFG on a model without one, frames only for video).
 * @param {Record<string, any>} memory
 * @param {{ id: string, kind?: string, capabilities?: Record<string, boolean>, constraints?: Record<string, { min?: number, max?: number }> }} profile
 */
export function recalledSettings(memory, profile) {
  const record = profile?.id ? memory?.[profile.id] : null;
  if (!record || typeof record !== "object") return {};
  const caps = profile.capabilities || {};
  const offered = {
    steps: caps.steps !== false,
    cfg: caps.cfg !== false,
    sampler: caps.sampler !== false,
    scheduler: caps.sampler !== false,
    denoise: Boolean(caps.denoise),
    inpaintStrength: Boolean(caps.inpaint),
    frames: profile.kind === "video",
    fps: profile.kind === "video"
  };
  const out = {};
  for (const key of numeric) {
    if (!offered[key] || !Number.isFinite(record[key])) continue;
    const limits = profile.constraints?.[key] || {};
    let value = record[key];
    if (Number.isFinite(limits.min)) value = Math.max(limits.min, value);
    if (Number.isFinite(limits.max)) value = Math.min(limits.max, value);
    out[key] = value;
  }
  for (const key of named) if (offered[key] && typeof record[key] === "string" && record[key]) out[key] = record[key];
  return out;
}

/** @param {Storage | undefined} [storage] */
export function loadModelMemory(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(storageKey) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** @param {Record<string, any>} memory @param {Storage | undefined} [storage] */
export function saveModelMemory(memory, storage = globalThis.localStorage) {
  try { storage?.setItem(storageKey, JSON.stringify(memory)); } catch { /* not remembered this time, which is fine */ }
}
