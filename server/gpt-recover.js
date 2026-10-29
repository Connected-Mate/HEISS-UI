/**
 * Brings back GPT Image pictures that were drawn but never reached the
 * gallery. Codex keeps every picture it makes (generated_images/<thread>) and
 * every brief (sessions/**.jsonl), so a run whose server stopped mid-way (a
 * restart, an update, a crash) is not lost: at start-up and every few
 * minutes, any studio thread that drew a picture and is not settled
 * (gptimage.js knownThreadSet) joins the gallery with its prompt.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { activeThreads, codexHome, gptOutputDir, gptViewUrl, knownThreadSet, rememberThreads, studioTag } from "./gptimage.js";
import { gallery, replaceGalleryJob } from "./gallery-store.js";
import { loadSharp } from "./sharp-loader.js";

const briefMarker = "You are an image generation agent inside a local studio app.";
// Old enough that a live run has saved it; recent enough to skip a long history.
const settleMs = 90_000;
const lookbackDays = 3;

/** The person's own words from a studio brief (gptimage.js agentPrompt). Exported for tests. */
export function requestFromBrief(text = "") {
  const at = text.indexOf("USER REQUEST:\n");
  return at < 0 ? "" : text.slice(at + "USER REQUEST:\n".length).trim();
}

function sessionFiles(now) {
  const files = [];
  for (let day = 0; day < lookbackDays; day += 1) {
    const date = new Date(now - day * 86_400_000);
    const dir = path.join(codexHome, "sessions", String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0"));
    try {
      for (const name of fs.readdirSync(dir)) if (name.endsWith(".jsonl")) files.push(path.join(dir, name));
    } catch { /* no runs that day */ }
  }
  return files;
}

/** A studio run's thread id and request, read from its session file, or null for any other Codex use. */
export function studioRun(file) {
  let text;
  try {
    // The brief follows Codex's own instructions and any reference pictures (base64), so it can sit
    // several MB in; read up to 64 MB, and only the first lines that hold it.
    const size = fs.statSync(file).size;
    if (size > 64 * 1024 * 1024) return null;
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  if (!text.includes(briefMarker)) return null;
  const threadId = path.basename(file, ".jsonl").match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1] || "";
  if (!threadId) return null;
  for (const line of text.split("\n")) {
    if (!line.includes("USER REQUEST:")) continue;
    try {
      const event = JSON.parse(line);
      const content = event?.payload?.content;
      const brief = Array.isArray(content) ? content.map((part) => part?.text || "").join("") : "";
      if (!brief.includes(briefMarker)) continue;
      // Another copy of the studio (its own data folder) ran this one: its pictures are its own.
      const tag = brief.match(/Run tag \(bookkeeping only[^)]*\): (heiss-[0-9a-f]+)/)?.[1];
      if (tag && tag !== studioTag) return null;
      return { threadId, request: requestFromBrief(brief) };
    } catch { /* a cut-off last line */ }
  }
  return { threadId, request: "" };
}

function threadPicture(threadId, now, { anyAge = false } = {}) {
  const dir = path.join(codexHome, "generated_images", threadId);
  try {
    const file = fs.readdirSync(dir).filter((name) => /\.png$/i.test(name)).map((name) => path.join(dir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (!file) return null;
    const mtime = fs.statSync(file).mtimeMs;
    return anyAge || now - mtime >= settleMs ? { file, mtime } : null;
  } catch {
    return null;
  }
}

/**
 * The first time this runs on a computer there is no settled list yet: every
 * studio thread already there counts as settled, except pictures with no
 * gallery image saved within a few seconds of them, which are the lost ones.
 */
function seedKnown(runs, now) {
  const savedTimes = gallery.filter((item) => item.model === "gpt-image" && item.completedAt).map((item) => Date.parse(item.completedAt));
  const settled = [];
  for (const run of runs) {
    // A picture still being saved by a live run is not settled yet; the next pass decides.
    const picture = threadPicture(run.threadId, now, { anyAge: true });
    if (!picture || now - picture.mtime < settleMs) continue;
    const index = savedTimes.findIndex((time) => time >= picture.mtime - 1000 && time - picture.mtime < 20_000);
    if (index >= 0) { savedTimes.splice(index, 1); settled.push(run.threadId); }
  }
  rememberThreads(settled);
}

let running = false;

/** Imports lost pictures; resolves to how many came back. */
export async function recoverLostGptImages({ now = Date.now() } = {}) {
  if (running) return 0;
  running = true;
  try {
    const runs = sessionFiles(now).map(studioRun).filter(Boolean);
    if (!knownThreadSet()) seedKnown(runs, now);
    const known = knownThreadSet() || new Set();
    const sharp = await loadSharp();
    let recovered = 0;
    for (const run of runs) {
      if (known.has(run.threadId) || activeThreads.has(run.threadId)) continue;
      const picture = threadPicture(run.threadId, now);
      if (!picture) continue;
      const buffer = fs.readFileSync(picture.file);
      const meta = sharp ? await sharp(buffer).metadata().catch(() => ({})) : {};
      const name = `recovered-${new Date(picture.mtime).toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}.png`;
      fs.writeFileSync(path.join(gptOutputDir(), name), buffer);
      const jobId = `gpt-recovered-${run.threadId}`;
      const completedAt = new Date(picture.mtime).toISOString();
      const prompt = run.request || "Recovered image";
      replaceGalleryJob(jobId, [{
        id: jobId,
        jobId,
        index: 0,
        url: gptViewUrl(name),
        filename: name,
        type: "image",
        status: "done",
        completedAt,
        width: meta.width || 0,
        height: meta.height || 0,
        model: "gpt-image",
        prompt,
        negative: "",
        recovered: true
      }], { prompt, model: "gpt-image", width: meta.width || 0, height: meta.height || 0, createdAt: completedAt }, new Map());
      rememberThreads([run.threadId]);
      recovered += 1;
    }
    if (recovered) console.log(`  [HEISS] Brought back ${recovered} GPT Image picture${recovered === 1 ? "" : "s"} that hadn’t reached the gallery.`);
    return recovered;
  } finally {
    running = false;
  }
}

/** At start-up, then every few minutes while the studio runs. */
export function startGptRecovery() {
  const tick = () => recoverLostGptImages().catch((error) => console.warn(`  [HEISS] GPT Image recovery skipped: ${error.message}`));
  setTimeout(tick, 5_000).unref?.();
  setInterval(tick, 3 * 60_000).unref?.();
}
