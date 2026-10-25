import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { comfy, hasNode } from "./comfy.js";
import { readJsonFile, writeJsonFile } from "./json-store.js";
import { nodePacks } from "./node-packs.js";
import { packCopies, packFastForwardable, packInstallState, packVersionOnDisk, primaryPackCopy, startPackInstall } from "./pack-installer.js";

/**
 * HEISS UI Nodes, HEISS's own ComfyUI pack, as one thing to install and keep
 * current (docs/heiss-nodes.md). Every feature that runs on it is listed here
 * with the pack version it needs; the first time someone touches one, the
 * app's HEISS Nodes dialog installs the whole pack, and when HEISS later needs
 * a newer pack than the one loaded, the same dialog offers the update.
 *
 * A new feature on the pack: add its nodes to the pack, raise PACK_VERSION
 * there, pin the new commit and version in node-packs.js, and add an entry here.
 */
export const heissFeatures = [
  {
    id: "rapid",
    label: "Rapid",
    blurb: "Pictures up to twice as fast, with the same look and memory.",
    nodes: ["HeissRapid", "HeissRapidGuidance"],
    // Runs on any copy from 2 on; pack 9 (the grow with the run's own noise) only makes its pictures closer to the
    // seed, so an older copy keeps Rapid and is offered the update (node-packs.js pins 9).
    version: 2
  },
  {
    id: "rtx",
    label: "RTX video upscale",
    blurb: "Videos upscaled in seconds, and smoother if you like.",
    nodes: ["HeissRTXVideo", "HeissRTXUpscale"],
    // 6: an nvidia-vfx older than 0.2 is reported too old instead of failing every run; 7: and locked, on Windows.
    version: 7,
    // Only offered on an NVIDIA card; its second part is NVIDIA's own package (rtx.js).
    nvidia: true
  },
  {
    id: "inpaint",
    label: "Seamless inpainting",
    blurb: "What edit models repaint, lined up and colour matched, so no seam shows.",
    // Inpainting works without it (ComfyUI's plain composite); with it, the stitch corrects (inpaint.js).
    nodes: ["HeissInpaintStitch"],
    // 5: colour match leaves a meant change alone, and the correction is read bicubic; 7: none under half a pixel.
    version: 7
  },
  {
    id: "enhance",
    label: "Prompt enhance",
    blurb: "A few words become the prompt your model wants, written on this computer.",
    // The node streams the text as it's written; 8 also lists a just-downloaded model without a restart.
    nodes: ["HeissPromptEnhance"],
    version: 8
  }
];

export function heissFeature(id) {
  return heissFeatures.find((feature) => feature.id === id) || null;
}

/** The pack's own answer (GET /heiss/nodes, version 3 on); null from an older pack, or no pack, or no ComfyUI. */
export async function heissNodesReport() {
  try {
    return await comfy("/heiss/nodes", { signal: AbortSignal.timeout(5000) });
  } catch {
    return null;
  }
}

/**
 * The copy in custom_nodes, when ComfyUI is on this computer: whether it's
 * there (under its own folder name or another, node-packs.js `signature`), a
 * git checkout or not, at which commit, the version its files say, when they
 * last changed, and how many other copies sit beside it. null when HEISS
 * can't look (ComfyUI elsewhere).
 */
export function localHeissCopy(root) {
  if (!root) return null;
  const pack = nodePacks.heiss;
  const customNodes = path.join(root, "custom_nodes");
  const copies = packCopies(customNodes, pack);
  const name = primaryPackCopy(customNodes, pack, copies);
  if (!name) return { present: false, git: false, head: "", version: 0, folder: "", others: 0, changedAt: 0 };
  const folder = path.join(customNodes, name);
  let head = "";
  const git = fs.existsSync(path.join(folder, ".git"));
  if (git) {
    try {
      const value = fs.readFileSync(path.join(folder, ".git", "HEAD"), "utf8").trim();
      head = /^[0-9a-f]{40}$/.test(value) ? value : "";
    } catch { /* unreadable: treat as unknown */ }
  }
  // A checkout or a new copy rewrites these two; installing Python packages touches neither.
  const changedAt = Math.max(0, ...[pack.versionFile, path.join(".git", "HEAD")].map((file) => {
    try { return fs.statSync(path.join(folder, file)).mtimeMs; } catch { return 0; }
  }));
  return { present: true, git, head, version: packVersionOnDisk(folder, pack), folder: name, others: copies.length - 1, changedAt };
}

/**
 * Why ComfyUI couldn't load the pack the last time it started, from its own
 * log ("Cannot import <folder> module for custom nodes: <error>"). null when
 * the log doesn't say: it loaded, or the line has scrolled out of ComfyUI's
 * buffer (300 lines), or this ComfyUI has no log route.
 */
export function heissLoadFailureFrom(entries = [], folders = []) {
  const known = new Set(folders.filter(Boolean).map((name) => name.toLowerCase()));
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const match = /Cannot import (.+?) module for custom nodes: ([^\n]*)/.exec(String(entries[index]?.m || ""));
    if (!match) continue;
    const folder = match[1].trim().split(/[\\/]/).pop();
    if (!known.has(folder.toLowerCase()) && !/heiss.?ui.?nodes/i.test(folder)) continue;
    // ComfyUI stamps its log in local time, without a zone, as Date reads it.
    return { folder, error: match[2].trim(), at: Date.parse(entries[index].t) || 0 };
  }
  return null;
}

export async function heissLoadFailure(folders = []) {
  try {
    const { entries } = await comfy("/internal/logs/raw", { signal: AbortSignal.timeout(5000) });
    return heissLoadFailureFrom(Array.isArray(entries) ? entries : [], folders);
  } catch {
    return null;
  }
}

/** The failure in a sentence someone can act on; Repair reinstalls the pack's Python packages. */
export function loadFailureReason(error = "") {
  const missing = /No module named '([^'.]+)/.exec(error);
  if (missing) return `A Python package they need (${missing[1]}) isn’t installed in ComfyUI.`;
  if (/cannot import name .* from '?(comfy|comfy_extras|nodes|server)\b/i.test(error)) return "This ComfyUI is older than they need. Update ComfyUI, then restart it.";
  const text = String(error).trim();
  return text ? `ComfyUI said: ${text.length > 160 ? `${text.slice(0, 157)}…` : text}` : "ComfyUI didn’t say why.";
}

/**
 * Where the pack stands, from what ComfyUI has loaded and what is on disk:
 *   ready   - loaded, and at least the version HEISS needs
 *   restart - the right version is on disk (or was just repaired), but ComfyUI hasn't loaded it yet
 *   failed  - there, but ComfyUI couldn't import it when it last started (its log says why);
 *             a restart alone won't help, Repair reinstalls its packages
 *   update  - loaded (or on disk) but older than HEISS needs
 *   install - not there at all
 * Version 1 and 2 copies had no version route; their nodes tell them apart.
 * Each feature says whether it can run now, so an older pack keeps what it can.
 * `installedAt` is when HEISS last finished installing it (pack-installer.js).
 */
export function heissNodesStatusFrom({ info = {}, report = null, local = null, failure = null, installedAt = 0 } = {}) {
  const pack = nodePacks.heiss;
  const required = pack.version;
  const loadedNodes = pack.nodes.filter((node) => hasNode(info, node));
  const loadedVersion = Number(report?.version) || (hasNode(info, "HeissRapidGuidance") ? 2 : hasNode(info, "HeissRapid") ? 1 : 0);
  const features = heissFeatures.map((feature) => ({
    id: feature.id,
    label: feature.label,
    blurb: feature.blurb,
    version: feature.version,
    nvidia: Boolean(feature.nvidia),
    ready: loadedVersion >= feature.version && feature.nodes.every((node) => hasNode(info, node))
  }));
  // Failed to import, and nothing has changed since: files moved or packages went in after the failure mean a restart.
  const failed = !loadedVersion && failure && (local === null || local.present)
    && Math.max(local?.changedAt || 0, installedAt || 0) <= failure.at;
  let state;
  if (loadedVersion >= required) state = "ready";
  else if (failed) state = "failed";
  else if (local?.present && (local.version >= required || (failure && !loadedVersion))) state = "restart";
  else if (loadedVersion > 0 || local?.present) state = "update";
  else state = "install";
  return {
    state,
    requiredVersion: required,
    loadedVersion,
    diskVersion: local?.present ? local.version : null,
    local: local ? { present: local.present, git: local.git, onPin: Boolean(local.head) && local.head === pack.commit, folder: local.folder || "", others: local.others || 0 } : null,
    failure: state === "failed" ? { reason: loadFailureReason(failure.error), error: failure.error } : null,
    loadedNodes,
    features
  };
}

/** Everything heissNodesStatusFrom reads, asked of ComfyUI and the disk in one go. */
export async function heissNodesSnapshot({ info = {}, root = "" } = {}) {
  const local = localHeissCopy(root);
  const pack = nodePacks.heiss;
  const [report, failure] = await Promise.all([
    heissNodesReport(),
    // Only worth asking while the nodes are missing: a loaded pack didn't fail.
    pack.nodes.some((node) => hasNode(info, node)) ? null : heissLoadFailure([pack.folder, local?.folder])
  ]);
  const install = packInstallState("heiss");
  const status = heissNodesStatusFrom({ info, report, local, failure, installedAt: install?.status === "done" ? install.finishedAt : 0 });
  return {
    ...status,
    // An update HEISS is making, or made by itself (autoUpdateHeissNodes), so the app can say so.
    updating: install?.status === "running",
    autoUpdated: Boolean(install?.background && install.status === "done" && status.state === "restart"),
    autoUpdate: heissNodesSettings().autoUpdate
  };
}

/* ------------------------------------------------------------ Keeping it current by itself */

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.HEISS_DATA_DIR || process.env.JAI_DATA_DIR ? path.resolve(process.env.HEISS_DATA_DIR || process.env.JAI_DATA_DIR) : path.join(appRoot, "data");
const settingsFile = path.join(dataDir, "heiss-nodes.json");

/** { autoUpdate }: on unless someone switched it off in Settings. */
export function heissNodesSettings() {
  let saved = null;
  try { saved = readJsonFile(settingsFile); } catch { saved = null; }
  return { autoUpdate: saved?.autoUpdate !== false };
}

export function saveHeissNodesSettings({ autoUpdate } = {}) {
  const settings = { ...heissNodesSettings(), ...(typeof autoUpdate === "boolean" ? { autoUpdate } : {}) };
  fs.mkdirSync(dataDir, { recursive: true });
  writeJsonFile(settingsFile, settings);
  return settings;
}

let autoTried = "";

/**
 * The quiet update: when this HEISS needs a newer pack and the copy is a clean
 * git checkout that is simply behind the reviewed commit with the same Python
 * requirements, HEISS moves it there by itself (files only, no pip), once per
 * pin. ComfyUI keeps running the loaded version until its next restart, which
 * stays the person's call; the app says the update is waiting. Anything else
 * (edits, a zip copy, new packages, ComfyUI elsewhere) waits for the dialog.
 */
export async function autoUpdateHeissNodes(status, root) {
  const pack = nodePacks.heiss;
  if (status?.state !== "update" || !root || autoTried === pack.commit || !heissNodesSettings().autoUpdate) return false;
  if (packInstallState("heiss")?.status === "running") return false;
  const local = localHeissCopy(root);
  if (!local?.present || !local.git) return false;
  autoTried = pack.commit;
  if (!await packFastForwardable(path.join(root, "custom_nodes", local.folder), pack)) return false;
  await startPackInstall("heiss", { background: true });
  return true;
}
