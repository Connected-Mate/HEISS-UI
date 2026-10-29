import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Recovery against a stand-in Codex home: session files with studio briefs
// (ours, another copy's, someone's unrelated chat) and the pictures they drew.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "heiss-gpt-recover-"));
const codexHome = path.join(temporary, "codex");
process.env.HEISS_ENGINE = "gptimage";
process.env.CODEX_HOME = codexHome;
process.env.COMFY_OUTPUT_DIR = path.join(temporary, "output");
process.env.HEISS_DATA_DIR = path.join(temporary, "data");
fs.mkdirSync(process.env.COMFY_OUTPUT_DIR, { recursive: true });

const gpt = await import("./gptimage.js");
const recover = await import("./gpt-recover.js");
const store = await import("./gallery-store.js");

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const now = Date.now();
const day = new Date(now);
const sessionsDir = path.join(codexHome, "sessions", String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
fs.mkdirSync(sessionsDir, { recursive: true });
let counter = 0;
function run({ brief, picture = true, ageMs = 5 * 60_000 }) {
  counter += 1;
  const threadId = `01a18871-0000-7000-8000-${String(counter).padStart(12, "0")}`;
  const line = JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: brief }] } });
  fs.writeFileSync(path.join(sessionsDir, `rollout-2026-10-29T17-00-00-${threadId}.jsonl`), `${JSON.stringify({ type: "session_meta" })}\n${line}\n`);
  if (picture) {
    const dir = path.join(codexHome, "generated_images", threadId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "exec-1.png");
    fs.writeFileSync(file, png);
    const time = (now - ageMs) / 1000;
    fs.utimesSync(file, time, time);
  }
  return threadId;
}
const brief = (prompt) => gpt.agentPrompt({ prompt, width: 1024, height: 1024 });

test.after(() => {
  try { fs.rmSync(temporary, { recursive: true, force: true }); } catch { /* temp */ }
});

test("the request comes back out of a studio brief", () => {
  assert.equal(recover.requestFromBrief(brief("Un chat sur un arbre")), "Un chat sur un arbre");
  assert.equal(recover.requestFromBrief("no brief here"), "");
});

test("lost pictures come back once, with their prompt; settled, foreign, fresh and unrelated runs stay out", async () => {
  // First run on this computer: a picture with a gallery image saved right after it is settled.
  const saved = run({ brief: brief("Already in the gallery") });
  const savedAt = fs.statSync(path.join(codexHome, "generated_images", saved, "exec-1.png")).mtimeMs + 3000;
  store.setGallery([{ id: "/comfy/view?filename=a.png", url: "/comfy/view?filename=a.png", jobId: "j1", status: "done", type: "image", model: "gpt-image", completedAt: new Date(savedAt).toISOString(), prompt: "Already in the gallery" }], { persist: false });
  const lost = run({ brief: brief("Sticker en ultra haute définition") });
  const foreign = run({ brief: brief("x").replace(gpt.studioTag, "heiss-0000000000") });
  const fresh = run({ brief: brief("Still drawing"), ageMs: 10_000 });
  run({ brief: "Tu es un relecteur. Unrelated Codex use." });
  run({ brief: brief("Drew nothing"), picture: false });

  assert.equal(await recover.recoverLostGptImages({ now }), 1);
  const back = store.gallery.find((item) => item.jobId === `gpt-recovered-${lost}`);
  assert.ok(back, "the lost picture is in the gallery");
  assert.equal(back.prompt, "Sticker en ultra haute définition");
  assert.ok(fs.existsSync(path.join(process.env.COMFY_OUTPUT_DIR, "gptimage", back.outputName)));
  assert.ok(!store.gallery.some((item) => item.jobId === `gpt-recovered-${saved}`));
  assert.ok(!store.gallery.some((item) => item.jobId === `gpt-recovered-${foreign}`));

  // Never twice; a run that was still drawing comes back once it has settled.
  assert.equal(await recover.recoverLostGptImages({ now }), 0);
  assert.equal(await recover.recoverLostGptImages({ now: now + 5 * 60_000 }), 1);
  assert.ok(store.gallery.some((item) => item.jobId === `gpt-recovered-${fresh}`));
});

test("a run in flight here is never taken, and a stopped one never comes back", async () => {
  const live = run({ brief: brief("Live run") });
  gpt.activeThreads.add(live);
  assert.equal(await recover.recoverLostGptImages({ now }), 0);
  gpt.activeThreads.delete(live);
  gpt.rememberThreads([live]);
  assert.equal(await recover.recoverLostGptImages({ now }), 0);
  const saved = JSON.parse(fs.readFileSync(gpt.knownThreadsPath, "utf8"));
  assert.ok(saved.threads.includes(live));
});
