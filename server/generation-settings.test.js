import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.COMFY_OUTPUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "heiss-output-"));
process.env.HEISS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "heiss-data-"));
const { generationSettings } = await import("./gallery-store.js");

test("a reference that only guided is kept with the run, so a retry runs it the same way", () => {
  const references = [{ slot: "reference", assetId: "a1" }];
  assert.equal(generationSettings({ kind: "image", referenceAssets: references, referenceRole: "reference" }).referenceRole, "reference");
  // Edit is the default, and is what older runs without the field replay as.
  assert.equal(generationSettings({ kind: "image", referenceAssets: references, referenceRole: "edit" }).referenceRole, undefined);
  assert.equal(generationSettings({ kind: "image", referenceAssets: [], referenceRole: "reference" }).referenceRole, undefined, "no reference, nothing to say");
});

test("an imported workflow's More settings are kept with the run, with their names", () => {
  const settings = generationSettings({ kind: "image", workflowSettings: { "6.b1": 1.05, "9.mode": "fast", bad: { nested: true } }, workflowSettingLabels: { "6.b1": "FreeU · b1" } });
  assert.deepEqual(settings.workflowSettings, { "6.b1": 1.05, "9.mode": "fast" });
  assert.deepEqual(settings.workflowSettingLabels, { "6.b1": "FreeU · b1" });
  assert.equal(generationSettings({ kind: "image" }).workflowSettings, undefined, "nothing changed, nothing kept");
});
