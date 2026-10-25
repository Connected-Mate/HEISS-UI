import fs from "node:fs";
import path from "node:path";
import { comfy, hasNode } from "./comfy.js";
import { nodePacks } from "./node-packs.js";
import { packVersionOnDisk } from "./pack-installer.js";

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
 * there, a git checkout or not, at which commit, and the version its files
 * say. null when HEISS can't look (ComfyUI elsewhere).
 */
export function localHeissCopy(root) {
  if (!root) return null;
  const pack = nodePacks.heiss;
  const folder = path.join(root, "custom_nodes", pack.folder);
  if (!fs.existsSync(folder)) return { present: false, git: false, head: "", version: 0 };
  let head = "";
  const git = fs.existsSync(path.join(folder, ".git"));
  if (git) {
    try {
      const value = fs.readFileSync(path.join(folder, ".git", "HEAD"), "utf8").trim();
      head = /^[0-9a-f]{40}$/.test(value) ? value : "";
    } catch { /* unreadable: treat as unknown */ }
  }
  return { present: true, git, head, version: packVersionOnDisk(folder, pack) };
}

/**
 * Where the pack stands, from what ComfyUI has loaded and what is on disk:
 *   ready   - loaded, and at least the version HEISS needs
 *   restart - the right version is on disk, but ComfyUI hasn't loaded it yet
 *   update  - loaded (or on disk) but older than HEISS needs
 *   install - not there at all
 * Version 1 and 2 copies had no version route; their nodes tell them apart.
 * Each feature says whether it can run now, so an older pack keeps what it can.
 */
export function heissNodesStatusFrom({ info = {}, report = null, local = null } = {}) {
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
  let state;
  if (loadedVersion >= required) state = "ready";
  else if (local?.present && local.version >= required) state = "restart";
  else if (loadedVersion > 0 || local?.present) state = "update";
  else state = "install";
  return {
    state,
    requiredVersion: required,
    loadedVersion,
    diskVersion: local?.present ? local.version : null,
    local: local ? { present: local.present, git: local.git, onPin: Boolean(local.head) && local.head === pack.commit } : null,
    loadedNodes,
    features
  };
}
