/**
 * GPT Image engine: the studio without ComfyUI. Each image is one prompt
 * handed to a local Codex agent (`codex exec`), which draws it with its
 * built-in image_gen tool on the ChatGPT subscription the person is already
 * signed in with. No provider API keys, nothing to configure: the agent is
 * the provider. Same brief rules as the /gptimage skill.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { comfyOutputDir } from "./comfy.js";
import { loadSharp } from "./sharp-loader.js";

export const gptSubfolder = "gptimage";
const codexBin = process.env.HEISS_CODEX_BIN || "codex";
const codexHome = process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), ".codex");
const runTimeoutMs = Math.max(60_000, Number(process.env.HEISS_GPT_TIMEOUT_MS || 6 * 60 * 1000));
const maxReferences = 8;
// One prompt per image, a few at once: the subscription rate-limits beyond that.
const maxParallel = Math.max(1, Math.min(4, Number(process.env.HEISS_GPT_PARALLEL || 2)));

export const gptSizes = [
  { label: "Square", width: 1024, height: 1024 },
  { label: "Landscape", width: 1536, height: 1024 },
  { label: "Portrait", width: 1024, height: 1536 }
];

/** The brief the agent receives. Exported for tests. */
export function agentPrompt({ prompt, width, height, referenceCount = 0, mode = "precise" }) {
  const shape = width > height ? "landscape" : width < height ? "portrait" : "square";
  const lines = [
    "You are an image generation agent inside a local studio app. Your only job: produce exactly ONE image with your built-in image_gen tool, then stop.",
    "Hard rules: call image_gen exactly once. Do not run shell commands, do not read or write files, do not ask questions, do not explain. After the image is made reply only: DONE",
    `Canvas: ${width}x${height} (${shape}). Compose for that shape and keep the main subject in the middle 60% of the frame.`
  ];
  if (referenceCount) {
    lines.push(`${referenceCount} reference image${referenceCount > 1 ? "s are" : " is"} attached, in order (image 1, image 2, ...). Use every one of them as the user's request says. When the request edits an image, change only what is asked and keep identity, geometry, framing, lighting and every other detail identical.`);
  }
  if (mode === "precise") {
    lines.push(
      "The user writes precise briefs. Keep every subject, attribute, count, position, color, style cue and quoted text exactly as written; never drop, substitute or contradict any of it.",
      "Only when the brief is short or vague, expand it into a specific brief: lead with the subject noun, name the composition, the lighting and a style anchor; colors glued to objects; realism through concrete camera defects (film grain, slight motion blur), never quality words like 8K or masterpiece; exclusions in plain words at the very end.",
      "In-image text: render it exact and verbatim, no extra characters."
    );
  } else {
    lines.push("Pass the user's request to image_gen word for word.");
  }
  lines.push("", "USER REQUEST:", String(prompt || "").trim());
  return lines.join("\n");
}

/** The thread id Codex prints first, which names the folder its images land in. */
export function threadIdFrom(line) {
  try {
    const event = JSON.parse(line);
    return event?.type === "thread.started" && /^[\w-]+$/.test(event.thread_id || "") ? event.thread_id : "";
  } catch {
    return "";
  }
}

/** A plain sentence for what went wrong, never a log dump. Exported for tests. */
export function friendlyError(text = "", code = null) {
  const raw = String(text);
  if (/ENOENT|not found|command not found/i.test(raw)) return "Codex isn’t installed on this computer. Install it, then sign in with `codex login`.";
  if (/401|unauthori[sz]ed|not logged in|login|auth/i.test(raw)) return "You’re signed out of ChatGPT. Run `codex login` in a terminal, then try again.";
  if (/429|rate.?limit|usage limit|too many requests/i.test(raw)) return "ChatGPT’s image limit is reached for now. Try again in a little while.";
  if (/content.?policy|safety|moderation|refus/i.test(raw)) return "ChatGPT declined this image. Try rewording the prompt.";
  if (/timed? ?out/i.test(raw)) return "The image took too long. Try again.";
  return code ? "The image couldn’t be made this time. Try again." : "The image couldn’t be made.";
}

function newestPng(dir, since) {
  try {
    return fs.readdirSync(dir)
      .filter((name) => /\.png$/i.test(name))
      .map((name) => ({ file: path.join(dir, name), mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
      .filter((item) => item.mtime >= since - 1000)
      .sort((a, b) => b.mtime - a.mtime)[0]?.file || "";
  } catch {
    return "";
  }
}

/**
 * One image from one agent prompt. Resolves to the PNG Codex wrote;
 * `signal` aborts the agent.
 */
export function runAgentImage({ prompt, references = [], width, height, workDir, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(Object.assign(new Error("Canceled"), { canceled: true })); return; }
    const startedAt = Date.now();
    const args = ["exec", "--skip-git-repo-check", "--json", "-s", "read-only", "-c", 'model_reasoning_effort="low"', "-C", workDir];
    for (const file of references.slice(0, maxReferences)) args.push("-i", file);
    args.push("-");
    let child;
    try {
      child = spawn(codexBin, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    } catch (error) {
      reject(new Error(friendlyError(error.message)));
      return;
    }
    let threadId = "";
    let stderr = "";
    let buffered = "";
    let lastMessage = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      fn(value);
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      finish(reject, Object.assign(new Error("Canceled"), { canceled: true }));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(reject, new Error(friendlyError("timed out")));
    }, runTimeoutMs);
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      let index;
      while ((index = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        threadId ||= threadIdFrom(line);
        try {
          const event = JSON.parse(line);
          if (event?.type === "item.completed" && event.item?.type === "agent_message") lastMessage = String(event.item.text || "");
          if (event?.type === "error" || event?.type === "turn.failed") stderr += ` ${JSON.stringify(event)}`;
        } catch { /* not an event */ }
      }
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on("error", (error) => finish(reject, new Error(friendlyError(error.message))));
    child.on("close", (code) => {
      const file = threadId ? newestPng(path.join(codexHome, "generated_images", threadId), startedAt) : "";
      if (file) { finish(resolve, file); return; }
      finish(reject, new Error(friendlyError(`${stderr} ${lastMessage}`, code)));
    });
    child.stdin.end(prompt);
  });
}

/** Cover-crop to the exact size asked for, like the /gptimage skill's enforceSize. */
async function fitToSize(buffer, width, height) {
  const sharp = await loadSharp();
  if (!sharp || !width || !height) return { buffer, width, height };
  const out = await sharp(buffer).resize({ width, height, fit: "cover", position: "centre", kernel: "lanczos3" }).png().toBuffer();
  return { buffer: out, width, height };
}

export function gptOutputDir() {
  const dir = path.join(comfyOutputDir, gptSubfolder);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeStem(prompt) {
  return String(prompt || "image").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "image";
}

/** Writes the run's reference bytes to a private temp folder the agent can attach. */
export function stageReferenceFiles(buffers = []) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "heiss-gpt-"));
  const files = buffers.slice(0, maxReferences).map((item, index) => {
    const ext = /jpe?g/i.test(item.mime || "") ? "jpg" : /webp/i.test(item.mime || "") ? "webp" : "png";
    const file = path.join(workDir, `reference-${index + 1}.${ext}`);
    fs.writeFileSync(file, item.buffer, { mode: 0o600 });
    return file;
  });
  return { workDir, files };
}

export function cleanupWorkDir(workDir) {
  if (!workDir || !path.basename(workDir).startsWith("heiss-gpt-")) return;
  try {
    for (const name of fs.readdirSync(workDir)) fs.unlinkSync(path.join(workDir, name));
    fs.rmdirSync(workDir);
  } catch { /* temp folder, the OS clears it */ }
}

/**
 * Makes `count` images and saves them into the output folder. Calls
 * `onImage` as each one lands so the gallery fills in as it goes.
 */
export async function makeImages({ prompt, count = 1, width, height, references = [], signal, onImage = () => {}, onError = () => {} }) {
  const { workDir, files } = stageReferenceFiles(references);
  const brief = agentPrompt({ prompt, width, height, referenceCount: files.length });
  const outDir = gptOutputDir();
  const results = new Array(count).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < count) {
      const index = next++;
      if (signal?.aborted) return;
      try {
        const file = await runAgentImage({ prompt: brief, references: files, width, height, workDir, signal });
        const fitted = await fitToSize(fs.readFileSync(file), width, height);
        const name = `${safeStem(prompt)}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.png`;
        fs.writeFileSync(path.join(outDir, name), fitted.buffer);
        results[index] = { index, filename: name, width: fitted.width, height: fitted.height };
        onImage(results[index]);
      } catch (error) {
        if (error?.canceled) return;
        results[index] = { index, error: error.message };
        onError(results[index]);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(maxParallel, count) }, worker));
  } finally {
    cleanupWorkDir(workDir);
  }
  return results;
}

export function gptViewUrl(filename) {
  return `/comfy/view?${new URLSearchParams({ filename, subfolder: gptSubfolder, type: "output" })}`;
}

/** Is Codex there and signed in? Read from its own files, never its secrets' values. */
export function codexReady() {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8"));
    return Boolean(auth?.tokens || auth?.OPENAI_API_KEY);
  } catch {
    return false;
  }
}
