import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./gallery-store.js";
import { readJsonFile, removeJsonFile, writeJsonFile } from "./json-store.js";

/**
 * Whiteboards, in data/boards/<id>.json: one file per board, so moving a node
 * on one board never rewrites the others. A board is pictures and prompt
 * nodes on an infinite canvas, the links between them (which pictures feed
 * which prompt, in order) and where the view was left.
 *
 * The browser owns the layout; this checks shape and bounds and keeps the
 * file. Every save names the revision it started from, so two devices editing
 * the same board can't silently overwrite each other (a stale save gets 409
 * and the board as it is now).
 *
 * Nothing from Hidden is ever kept here: a board file is plain text in the
 * open data folder, so Hidden pictures, their ids and their prompts stay out.
 */

const folder = () => path.join(dataDir, "boards");
const fileFor = (id) => path.join(folder(), `${id}.json`);

export const boardLimits = { boards: 200, nodes: 1500, edges: 3000, name: 60, prompt: 4000, text: 240 };
export const boardAspects = ["1:1", "3:2", "2:3", "16:9", "9:16"];

const idPattern = /^[\w-]{1,64}$/;
const cleanId = (value) => (idPattern.test(String(value ?? "")) ? String(value) : "");
const text = (value, max = boardLimits.text) => String(value ?? "").slice(0, max);
const finite = (value, fallback = 0, min = -1e7, max = 1e7) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};
const isHiddenRef = (value) => /^vault:/.test(String(value || "")) || /^\/api\/vault\//.test(String(value || ""));

/** Only the studio's own same-origin paths: never another site, a data: or a javascript: URL. */
export function cleanMediaUrl(value) {
  const url = String(value || "").slice(0, 2048);
  if (!url.startsWith("/") || url.startsWith("//") || /[\s\\]/.test(url) || isHiddenRef(url)) return "";
  return url;
}

export function cleanBoardName(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, boardLimits.name);
}

function cleanImageData(data = {}) {
  const assetId = text(data.assetId, 512);
  const url = cleanMediaUrl(data.url);
  if (!url || isHiddenRef(assetId)) return null;
  return {
    assetId,
    url,
    thumbnailUrl: cleanMediaUrl(data.thumbnailUrl) || url,
    name: text(data.name),
    width: Math.round(finite(data.width, 0, 0, 100000)),
    height: Math.round(finite(data.height, 0, 0, 100000)),
    source: ["upload", "generation"].includes(data.source) ? data.source : "upload",
    ...(data.galleryItemId ? { galleryItemId: text(data.galleryItemId, 2048) } : {}),
    ...(data.prompt ? { prompt: text(data.prompt, boardLimits.prompt) } : {}),
    ...(cleanId(data.fromNode) ? { fromNode: cleanId(data.fromNode) } : {})
  };
}

function cleanGenerateData(data = {}) {
  const status = ["idle", "running", "done", "error", "canceled"].includes(data.status) ? data.status : "idle";
  return {
    prompt: text(data.prompt, boardLimits.prompt),
    aspect: boardAspects.includes(data.aspect) ? data.aspect : "1:1",
    count: Math.round(finite(data.count, 1, 1, 4)),
    status,
    ...(cleanId(data.jobId) ? { jobId: cleanId(data.jobId) } : {}),
    ...(status === "error" && data.error ? { error: text(data.error, 400) } : {}),
    ...(data.startedAt ? { startedAt: Math.round(finite(data.startedAt, 0, 0, 1e15)) } : {})
  };
}

function cleanNode(value) {
  if (!value || typeof value !== "object") return null;
  const id = cleanId(value.id);
  const type = value.type === "generate" ? "generate" : value.type === "image" ? "image" : "";
  if (!id || !type) return null;
  const data = type === "image" ? cleanImageData(value.data) : cleanGenerateData(value.data);
  if (!data) return null;
  const node = { id, type, x: finite(value.x), y: finite(value.y), data };
  if (value.w !== undefined) node.w = Math.round(finite(value.w, 240, 80, 4000));
  if (value.h !== undefined) node.h = Math.round(finite(value.h, 240, 60, 4000));
  return node;
}

/** A board as it is kept: known node types only, links between nodes that exist, one per pair, references at most 6 per prompt. */
export function cleanBoard(value, { id, createdAt, revision } = {}) {
  const raw = value && typeof value === "object" ? value : {};
  const seen = new Set();
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : [])
    .map(cleanNode)
    .filter((node) => node && !seen.has(node.id) && seen.add(node.id))
    .slice(0, boardLimits.nodes);
  const types = new Map(nodes.map((node) => [node.id, node.type]));
  const pairs = new Set();
  const perTarget = new Map();
  const edges = [];
  for (const edge of Array.isArray(raw.edges) ? raw.edges : []) {
    if (edges.length >= boardLimits.edges) break;
    const edgeId = cleanId(edge?.id);
    const source = cleanId(edge?.source);
    const target = cleanId(edge?.target);
    // A picture (or a prompt, for its results) feeds a prompt or shows what a prompt made.
    if (!edgeId || !types.has(source) || !types.has(target) || source === target) continue;
    const kind = edge.kind === "result" ? "result" : "reference";
    if (kind === "reference" && (types.get(source) !== "image" || types.get(target) !== "generate")) continue;
    if (kind === "result" && (types.get(source) !== "generate" || types.get(target) !== "image")) continue;
    const pair = `${source}>${target}`;
    if (pairs.has(pair)) continue;
    if (kind === "reference") {
      const used = perTarget.get(target) || 0;
      if (used >= 6) continue;
      perTarget.set(target, used + 1);
    }
    pairs.add(pair);
    edges.push({ id: edgeId, source, target, kind, ...(kind === "reference" ? { order: Math.round(finite(edge.order, 0, 0, 1000)) } : {}) });
  }
  const viewport = raw.viewport && typeof raw.viewport === "object"
    ? { x: finite(raw.viewport.x), y: finite(raw.viewport.y), zoom: finite(raw.viewport.zoom, 1, 0.05, 8) }
    : { x: 0, y: 0, zoom: 1 };
  const now = new Date().toISOString();
  return {
    id: id || cleanId(raw.id),
    name: cleanBoardName(raw.name) || "Untitled board",
    createdAt: createdAt || text(raw.createdAt, 40) || now,
    updatedAt: now,
    revision: Number.isInteger(revision) ? revision : Math.max(0, Math.round(finite(raw.revision, 0, 0, 1e12))),
    viewport,
    nodes,
    edges
  };
}

function readBoardFile(id) {
  if (!cleanId(id)) return null;
  try {
    const board = readJsonFile(fileFor(id));
    return board && typeof board === "object" && board.id === id ? board : null;
  } catch {
    return null;
  }
}

export function listBoards() {
  let names = [];
  try {
    names = fs.readdirSync(folder()).filter((name) => /^[\w-]{1,64}\.json$/.test(name));
  } catch {
    return [];
  }
  return names
    .map((name) => readBoardFile(name.slice(0, -5)))
    .filter(Boolean)
    .map((board) => ({ id: board.id, name: board.name, updatedAt: board.updatedAt, createdAt: board.createdAt, nodeCount: board.nodes?.length || 0 }))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function getBoard(id) {
  return readBoardFile(id);
}

export function createBoard({ name } = {}) {
  if (listBoards().length >= boardLimits.boards) throw Object.assign(new Error(`You can keep up to ${boardLimits.boards} boards. Delete one first.`), { status: 409 });
  const id = crypto.randomUUID();
  const board = cleanBoard({ name: cleanBoardName(name) || "Untitled board" }, { id, revision: 1 });
  writeJsonFile(fileFor(id), board, { compact: true });
  return board;
}

/**
 * Saves a board. `baseRevision` is the revision the browser last had: when
 * someone else saved since, nothing is written and the error carries the
 * board as it is now (status 409), so the browser can show that instead.
 */
export function saveBoard(id, value, baseRevision) {
  const current = readBoardFile(id);
  if (!current) throw Object.assign(new Error("That board is gone. It may have been deleted on another device."), { status: 404 });
  if (baseRevision !== undefined && baseRevision !== null && Number(baseRevision) !== current.revision) {
    throw Object.assign(new Error("This board changed on another device."), { status: 409, board: current });
  }
  const board = cleanBoard(value, { id, createdAt: current.createdAt, revision: current.revision + 1 });
  writeJsonFile(fileFor(id), board, { compact: true });
  return board;
}

export function renameBoard(id, name) {
  const current = readBoardFile(id);
  if (!current) throw Object.assign(new Error("That board is gone."), { status: 404 });
  const clean = cleanBoardName(name);
  if (!clean) throw Object.assign(new Error("Give the board a name."), { status: 400 });
  const board = { ...current, name: clean, updatedAt: new Date().toISOString(), revision: current.revision + 1 };
  writeJsonFile(fileFor(id), board, { compact: true });
  return board;
}

export function deleteBoard(id) {
  if (!readBoardFile(id)) throw Object.assign(new Error("That board is gone."), { status: 404 });
  removeJsonFile(fileFor(id));
  return { ok: true };
}
