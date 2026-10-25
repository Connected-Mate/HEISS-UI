import assert from "node:assert/strict";
import test from "node:test";
import { loadModelMemory, recalledSettings, rememberSettings, saveModelMemory } from "../src/app/modelMemory.js";

const flux = { id: "flux", kind: "image", capabilities: { denoise: false }, constraints: { steps: { min: 1, max: 50 }, cfg: { min: 1, max: 10 } } };

test("a model recalls only its most recent settings", () => {
  let memory = rememberSettings({}, "flux", { steps: 20, cfg: 3, sampler: "euler", scheduler: "beta" }, 1);
  memory = rememberSettings(memory, "flux", { steps: 28, cfg: 4.5, sampler: "dpmpp_2m", scheduler: "karras" }, 2);
  assert.deepEqual(recalledSettings(memory, flux), { steps: 28, cfg: 4.5, sampler: "dpmpp_2m", scheduler: "karras" });
  assert.deepEqual(recalledSettings(memory, { ...flux, id: "other" }), {});
});

test("recalled settings fit what the model takes now", () => {
  const memory = rememberSettings({}, "flux", { steps: 80, cfg: 0.2, denoise: 0.5, frames: 81, fps: 16 });
  assert.deepEqual(recalledSettings(memory, flux), { steps: 50, cfg: 1 });
  const noCfg = recalledSettings(memory, { ...flux, capabilities: { cfg: false } });
  assert.equal(noCfg.cfg, undefined);
  const video = recalledSettings(memory, { id: "flux", kind: "video", capabilities: {} });
  assert.equal(video.frames, 81);
  assert.equal(video.fps, 16);
});

test("only the most recently used models are kept, and storage survives a reload", () => {
  let memory = {};
  for (let index = 0; index < 90; index += 1) memory = rememberSettings(memory, `m${index}`, { steps: index }, index);
  assert.equal(Object.keys(memory).length, 80);
  assert.equal(memory.m0, undefined);
  assert.equal(memory.m89.steps, 89);
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  saveModelMemory(memory, storage);
  assert.equal(loadModelMemory(storage).m89.steps, 89);
  assert.deepEqual(loadModelMemory({ getItem: () => "not json" }), {});
});
