import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The GPT Image engine against a stand-in `codex`: a script that answers like
// `codex exec --json` and drops a PNG where Codex keeps its generated images.
// FAKE_CODEX picks how it behaves: ok, fail, auth, ratelimit, slow, noimage.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "heiss-gptimage-"));
const codexHome = path.join(temporary, "codex");
const outputDir = path.join(temporary, "output");
fs.mkdirSync(codexHome, { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const fakeCodex = path.join(temporary, "fake-codex.mjs");
fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const mode = process.env.FAKE_CODEX || "ok";
const args = process.argv.slice(2);
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  const id = "thread-" + process.pid + "-" + Date.now();
  fs.writeFileSync(path.join(${JSON.stringify(temporary)}, "last-call.json"), JSON.stringify({ args, stdin }));
  console.log(JSON.stringify({ type: "thread.started", thread_id: id }));
  if (mode === "fail") { console.error("something broke"); process.exit(1); }
  if (mode === "auth") { console.log(JSON.stringify({ type: "error", message: "401 Unauthorized" })); process.exit(1); }
  if (mode === "ratelimit") { console.log(JSON.stringify({ type: "turn.failed", error: { message: "429 Too Many Requests" } })); process.exit(1); }
  if (mode === "noimage") { console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "I can't make that." } })); process.exit(0); }
  const finish = () => {
    const dir = path.join(${JSON.stringify(codexHome)}, "generated_images", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "exec-1.png"), Buffer.from(${JSON.stringify(png)}, "base64"));
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "DONE" } }));
  };
  if (mode === "slow") setTimeout(finish, 20000); else finish();
});
`, { mode: 0o755 });
fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { present: true } }));

process.env.HEISS_ENGINE = "gptimage";
process.env.HEISS_CODEX_BIN = fakeCodex;
process.env.CODEX_HOME = codexHome;
process.env.COMFY_OUTPUT_DIR = outputDir;
process.env.HEISS_DATA_DIR = path.join(temporary, "data");

const gpt = await import("./gptimage.js");
const lastCall = () => JSON.parse(fs.readFileSync(path.join(temporary, "last-call.json"), "utf8"));

test.after(() => {
  try { fs.rmSync(temporary, { recursive: true, force: true }); } catch { /* temp */ }
});

test("the agent brief keeps the request verbatim and asks for one image", () => {
  const brief = gpt.agentPrompt({ prompt: "  A red \"SALE\" sign on a brick wall  ", width: 1536, height: 1024, referenceCount: 2 });
  assert.match(brief, /exactly ONE image/);
  assert.match(brief, /1536x1024 \(landscape\)/);
  assert.match(brief, /2 reference images are attached/);
  assert.ok(brief.endsWith("USER REQUEST:\nA red \"SALE\" sign on a brick wall"));
  assert.doesNotMatch(gpt.agentPrompt({ prompt: "x", width: 1024, height: 1024 }), /reference image/);
});

test("thread ids come only from the thread.started event", () => {
  assert.equal(gpt.threadIdFrom('{"type":"thread.started","thread_id":"01a1-x"}'), "01a1-x");
  assert.equal(gpt.threadIdFrom('{"type":"turn.started"}'), "");
  assert.equal(gpt.threadIdFrom("not json"), "");
  assert.equal(gpt.threadIdFrom('{"type":"thread.started","thread_id":"../../etc"}'), "");
});

test("errors read as plain sentences", () => {
  assert.match(gpt.friendlyError("spawn codex ENOENT"), /isn’t installed/);
  assert.match(gpt.friendlyError("401 Unauthorized"), /signed out/);
  assert.match(gpt.friendlyError("429 Too Many Requests"), /limit/);
  assert.match(gpt.friendlyError("blocked by content policy"), /declined/);
  assert.match(gpt.friendlyError("", 1), /couldn’t be made/);
});

test("makes the images asked for, at the exact size, with every reference attached", async () => {
  process.env.FAKE_CODEX = "ok";
  const seen = [];
  const results = await gpt.makeImages({
    prompt: "Brass watch",
    count: 2,
    width: 1536,
    height: 1024,
    references: [{ buffer: Buffer.from(png, "base64"), mime: "image/png" }, { buffer: Buffer.from(png, "base64"), mime: "image/jpeg" }],
    onImage: (item) => seen.push(item)
  });
  assert.equal(results.length, 2);
  assert.equal(seen.length, 2);
  for (const item of results) {
    assert.ok(item.filename.startsWith("brass-watch-"));
    const file = path.join(outputDir, "gptimage", item.filename);
    assert.ok(fs.existsSync(file));
    const sharp = (await import("sharp")).default;
    const meta = await sharp(file).metadata();
    assert.deepEqual([meta.width, meta.height], [1536, 1024]);
  }
  const call = lastCall();
  assert.equal(call.args.filter((arg) => arg === "-i").length, 2);
  assert.ok(call.args.includes("read-only"));
  assert.match(call.stdin, /Brass watch/);
  // The references' temp folder is gone once the run ends.
  const refDir = call.args[call.args.indexOf("-C") + 1];
  assert.equal(fs.existsSync(refDir), false);
});

for (const [mode, pattern] of [["fail", /couldn’t be made/], ["auth", /signed out/], ["ratelimit", /limit/], ["noimage", /couldn’t be made/]]) {
  test(`a failed agent (${mode}) reports a plain error and saves nothing`, async () => {
    process.env.FAKE_CODEX = mode;
    const before = fs.readdirSync(path.join(outputDir, "gptimage")).length;
    const errors = [];
    const results = await gpt.makeImages({ prompt: "x", count: 1, width: 1024, height: 1024, onError: (item) => errors.push(item) });
    assert.match(results[0].error, pattern);
    assert.equal(errors.length, 1);
    assert.equal(fs.readdirSync(path.join(outputDir, "gptimage")).length, before);
  });
}

test("canceling stops the agent right away", async () => {
  process.env.FAKE_CODEX = "slow";
  const controller = new AbortController();
  const startedAt = Date.now();
  const run = gpt.makeImages({ prompt: "x", count: 1, width: 1024, height: 1024, signal: controller.signal });
  setTimeout(() => controller.abort(), 300);
  const results = await run;
  assert.ok(Date.now() - startedAt < 5000);
  assert.equal(results[0], null);
});

test("an already canceled run never starts the agent", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(gpt.runAgentImage({ prompt: "x", width: 1, height: 1, workDir: temporary, signal: controller.signal }), /Canceled/);
});

test("signed in only when Codex holds a ChatGPT sign-in", () => {
  assert.equal(gpt.codexReady(), true);
  fs.writeFileSync(path.join(codexHome, "auth.json"), "{}");
  assert.equal(gpt.codexReady(), false);
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { present: true } }));
});

test("gallery links point at the engine's own output subfolder", () => {
  assert.equal(gpt.gptViewUrl("a b.png"), "/comfy/view?filename=a+b.png&subfolder=gptimage&type=output");
});

test("the GPT Image model offers prompt, size and six references, nothing to tune", async () => {
  const { mockModelResult } = await import("./models.js");
  const result = mockModelResult();
  assert.equal(result.engine, "gptimage");
  assert.equal(result.profiles.length, 1);
  const [profile] = result.profiles;
  assert.equal(profile.mediaInputs.length, 6);
  assert.equal(profile.capabilities.steps, false);
  assert.equal(profile.capabilities.negativePrompt, false);
  assert.equal(profile.capabilities.lora, false);
  assert.deepEqual(result.videoModels, []);
});
