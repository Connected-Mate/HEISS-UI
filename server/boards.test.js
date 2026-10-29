import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.HEISS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "heiss-boards-"));
const { boardLimits, cleanBoard, cleanMediaUrl, createBoard, deleteBoard, getBoard, listBoards, renameBoard, saveBoard } = await import("./boards.js");

const image = (id, extra = {}) => ({ id, type: "image", x: 10, y: 20, w: 240, h: 180, data: { assetId: `asset-${id}`, url: `/api/reference-assets/${id}/media`, name: `${id}.png`, width: 1024, height: 768, ...extra } });
const prompt = (id, extra = {}) => ({ id, type: "generate", x: 400, y: 20, data: { prompt: "a red bicycle", aspect: "16:9", count: 2, ...extra } });

test("a board is created, listed, read back and survives a reload", () => {
  const board = createBoard({ name: "  Moodboard   one " });
  assert.equal(board.name, "Moodboard one");
  assert.equal(board.revision, 1);
  assert.deepEqual(board.nodes, []);
  assert.ok(listBoards().some((item) => item.id === board.id && item.nodeCount === 0));
  assert.deepEqual(getBoard(board.id), board);
});

test("saving keeps nodes, links in order and the view, and bumps the revision", () => {
  const board = createBoard({ name: "Edits" });
  const saved = saveBoard(board.id, {
    name: "Edits",
    viewport: { x: -120, y: 40, zoom: 1.5 },
    nodes: [image("a"), image("b"), prompt("g")],
    edges: [
      { id: "e1", source: "b", target: "g", order: 0 },
      { id: "e2", source: "a", target: "g", order: 1 }
    ]
  }, board.revision);
  assert.equal(saved.revision, 2);
  assert.deepEqual(saved.viewport, { x: -120, y: 40, zoom: 1.5 });
  assert.deepEqual(saved.edges.map((edge) => [edge.source, edge.order, edge.kind]), [["b", 0, "reference"], ["a", 1, "reference"]]);
  assert.equal(getBoard(board.id).nodes.length, 3);
  assert.equal(getBoard(board.id).nodes[2].data.aspect, "16:9");
});

test("a stale save is refused with the board as it is now", () => {
  const board = createBoard({ name: "Shared" });
  saveBoard(board.id, { nodes: [image("a")] }, 1);
  assert.throws(() => saveBoard(board.id, { nodes: [] }, 1), (error) => error.status === 409 && error.board.nodes.length === 1);
  assert.equal(getBoard(board.id).nodes.length, 1);
});

test("links only join what exists, the right way round, once, and at most six references per prompt", () => {
  const nodes = [prompt("g"), image("r"), ...Array.from({ length: 8 }, (_, index) => image(`i${index}`))];
  const edges = [
    ...Array.from({ length: 8 }, (_, index) => ({ id: `e${index}`, source: `i${index}`, target: "g", order: index })),
    { id: "dup", source: "i0", target: "g" },
    { id: "ghost", source: "nope", target: "g" },
    { id: "backwards", source: "g", target: "i1" },
    { id: "result", source: "g", target: "r", kind: "result" },
    { id: "self", source: "g", target: "g" }
  ];
  const board = cleanBoard({ nodes, edges });
  assert.equal(board.edges.filter((edge) => edge.kind === "reference").length, 6);
  assert.deepEqual(board.edges.filter((edge) => edge.kind === "result").map((edge) => edge.id), ["result"]);
  assert.ok(!board.edges.some((edge) => ["dup", "ghost", "backwards", "self"].includes(edge.id)));
});

test("nothing from Hidden, another site or a script URL is kept", () => {
  assert.equal(cleanMediaUrl("https://evil.example/x.png"), "");
  assert.equal(cleanMediaUrl("//evil.example/x.png"), "");
  assert.equal(cleanMediaUrl("javascript:alert(1)"), "");
  assert.equal(cleanMediaUrl("/api/vault/media/abc"), "");
  assert.equal(cleanMediaUrl("/comfy/view?filename=a.png&subfolder=gptimage&type=output"), "/comfy/view?filename=a.png&subfolder=gptimage&type=output");
  const board = cleanBoard({ nodes: [image("ok"), image("vault", { assetId: "vault:secret" }), image("site", { url: "https://evil.example/a.png" }), { id: "x", type: "script", data: {} }] });
  assert.deepEqual(board.nodes.map((node) => node.id), ["ok"]);
});

test("bad values are bounded instead of kept", () => {
  const board = cleanBoard({
    name: "x".repeat(500),
    viewport: { x: "nope", y: Infinity, zoom: 99 },
    nodes: [
      { ...prompt("g", { prompt: "p".repeat(10000), count: 50, aspect: "7:3", status: "weird" }), x: 1e30, w: 1 },
      { ...image("bad id with spaces") }
    ]
  });
  assert.equal(board.name.length, boardLimits.name);
  assert.deepEqual(board.viewport, { x: 0, y: 0, zoom: 8 });
  assert.equal(board.nodes.length, 1);
  const [node] = board.nodes;
  assert.equal(node.data.prompt.length, boardLimits.prompt);
  assert.equal(node.data.count, 4);
  assert.equal(node.data.aspect, "1:1");
  assert.equal(node.data.status, "idle");
  assert.equal(node.x, 1e7);
  assert.equal(node.w, 80);
});

test("too many nodes are capped", () => {
  const nodes = Array.from({ length: boardLimits.nodes + 50 }, (_, index) => image(`n${index}`));
  assert.equal(cleanBoard({ nodes }).nodes.length, boardLimits.nodes);
});

test("rename and delete, and a deleted board stays gone", () => {
  const board = createBoard({ name: "Old" });
  assert.equal(renameBoard(board.id, "  New name ").name, "New name");
  assert.throws(() => renameBoard(board.id, "   "), (error) => error.status === 400);
  deleteBoard(board.id);
  assert.equal(getBoard(board.id), null);
  assert.ok(!listBoards().some((item) => item.id === board.id));
  assert.throws(() => saveBoard(board.id, {}, 1), (error) => error.status === 404);
  assert.throws(() => deleteBoard(board.id), (error) => error.status === 404);
  assert.equal(getBoard("../../etc/passwd"), null);
});

test("a corrupt board file falls back to its last good copy", () => {
  const board = createBoard({ name: "Fragile" });
  saveBoard(board.id, { name: "Fragile", nodes: [image("a")] }, 1);
  saveBoard(board.id, { name: "Fragile", nodes: [image("a"), image("b")] }, 2);
  fs.writeFileSync(path.join(process.env.HEISS_DATA_DIR, "boards", `${board.id}.json`), "{ half a fi");
  assert.equal(getBoard(board.id).nodes.length, 1);
});
