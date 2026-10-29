import type { Edge, Node, Viewport } from '@xyflow/react';
import { apiFetch, apiJson, ApiError } from '../api';

/**
 * Whiteboards (server/boards.js): pictures and prompt nodes on a canvas. Links
 * from pictures into a prompt are its references, in order; a prompt links to
 * the pictures it made. What's here is what the server keeps.
 */

export type BoardAspect = '1:1' | '3:2' | '2:3' | '16:9' | '9:16';
export const boardAspects: ReadonlyArray<{ value: BoardAspect; width: number; height: number; label: string }> = [
  { value: '1:1', width: 1024, height: 1024, label: 'Square' },
  { value: '3:2', width: 1536, height: 1024, label: 'Landscape' },
  { value: '2:3', width: 1024, height: 1536, label: 'Portrait' },
  { value: '16:9', width: 1536, height: 864, label: 'Wide' },
  { value: '9:16', width: 864, height: 1536, label: 'Tall' }
];
export const maxReferences = 6;
export const maxCount = 4;

export type ImageNodeData = {
  assetId: string;
  url: string;
  thumbnailUrl?: string;
  name?: string;
  width?: number;
  height?: number;
  source?: 'upload' | 'generation';
  galleryItemId?: string;
  prompt?: string;
  /** The prompt node that made it. */
  fromNode?: string;
};

export type GenerateStatus = 'idle' | 'running' | 'done' | 'error' | 'canceled';
export type GenerateNodeData = {
  prompt: string;
  aspect: BoardAspect;
  count: number;
  status: GenerateStatus;
  jobId?: string;
  error?: string;
  startedAt?: number;
};

export type ImageNode = Node<ImageNodeData, 'image'>;
export type GenerateNode = Node<GenerateNodeData, 'generate'>;
export type BoardNode = ImageNode | GenerateNode;
export type EdgeKind = 'reference' | 'result';
export type BoardEdge = Edge<{ kind: EdgeKind; order?: number }>;

type StoredNode = { id: string; type: 'image' | 'generate'; x: number; y: number; w?: number; h?: number; data: ImageNodeData | GenerateNodeData };
type StoredEdge = { id: string; source: string; target: string; kind: EdgeKind; order?: number };
export type StoredBoard = { id: string; name: string; createdAt: string; updatedAt: string; revision: number; viewport: Viewport; nodes: StoredNode[]; edges: StoredEdge[] };
export type BoardSummary = { id: string; name: string; updatedAt: string; createdAt: string; nodeCount: number };

export const imageNodeWidth = 240;
export const generateNodeWidth = 320;

/** The height an image node takes at `width` for a picture of this shape, kept within sane bounds. */
export function imageHeight(width: number, data: Pick<ImageNodeData, 'width' | 'height'>) {
  const ratio = data.width && data.height ? data.height / data.width : 1;
  return Math.round(Math.min(4, Math.max(0.25, ratio)) * width);
}

export function newId(prefix: string) {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 12) : Math.random().toString(36).slice(2, 14);
  return `${prefix}-${random}`;
}

export function toFlow(board: StoredBoard): { nodes: BoardNode[]; edges: BoardEdge[] } {
  const nodes = board.nodes.map((node) => {
    const base = { id: node.id, position: { x: node.x, y: node.y } };
    if (node.type === 'image') {
      const data = node.data as ImageNodeData;
      const width = node.w || imageNodeWidth;
      return { ...base, type: 'image', data, width, height: node.h || imageHeight(width, data) } as ImageNode;
    }
    return { ...base, type: 'generate', data: node.data as GenerateNodeData, width: node.w || generateNodeWidth } as GenerateNode;
  });
  const edges = board.edges.map((edge) => edgeFor(edge.source, edge.target, edge.kind, edge.order, edge.id));
  return { nodes, edges };
}

export function edgeFor(source: string, target: string, kind: EdgeKind, order = 0, id = newId('e')): BoardEdge {
  return {
    id,
    source,
    target,
    type: kind === 'result' ? 'result' : 'reference',
    sourceHandle: 'out',
    targetHandle: kind === 'result' ? 'from' : 'refs',
    data: { kind, ...(kind === 'reference' ? { order } : {}) },
    // A result link only shows lineage; it isn't removed on its own.
    deletable: kind !== 'result',
    focusable: kind !== 'result'
  };
}

export function fromFlow(nodes: BoardNode[], edges: BoardEdge[], viewport: Viewport, name: string) {
  return {
    name,
    viewport,
    nodes: nodes.map((node): StoredNode => ({
      id: node.id,
      type: node.type === 'image' ? 'image' : 'generate',
      x: Math.round(node.position.x),
      y: Math.round(node.position.y),
      ...(node.width ? { w: Math.round(node.width) } : {}),
      ...(node.type === 'image' && node.height ? { h: Math.round(node.height) } : {}),
      data: node.data
    })),
    edges: edges.map((edge): StoredEdge => ({ id: edge.id, source: edge.source, target: edge.target, kind: edge.data?.kind || 'reference', ...(edge.data?.kind === 'result' ? {} : { order: edge.data?.order || 0 }) }))
  };
}

/** A prompt's references, in their order, as the images they come from. */
export function referencesOf(nodeId: string, nodes: BoardNode[], edges: BoardEdge[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return edges
    .filter((edge) => edge.target === nodeId && edge.data?.kind !== 'result')
    .sort((a, b) => (a.data?.order || 0) - (b.data?.order || 0))
    .map((edge) => ({ edge, node: byId.get(edge.source) }))
    .filter((item): item is { edge: BoardEdge; node: ImageNode } => item.node?.type === 'image');
}

/** Renumbers a prompt's references 0, 1, 2… in the order given (edge ids), leaving every other link alone. */
export function reorderReferences(edges: BoardEdge[], target: string, orderedIds: string[]) {
  const position = new Map(orderedIds.map((id, index) => [id, index]));
  return edges.map((edge) => edge.target === target && position.has(edge.id) ? { ...edge, data: { kind: 'reference' as const, order: position.get(edge.id)! } } : edge);
}

/** Everything a node came from (its references, the prompts that made them, theirs…) and everything made from it. */
export function lineageOf(nodeId: string, edges: BoardEdge[]) {
  const nodes = new Set<string>([nodeId]);
  const links = new Set<string>();
  const incoming = new Map<string, BoardEdge[]>();
  const outgoing = new Map<string, BoardEdge[]>();
  for (const edge of edges) {
    incoming.set(edge.target, [...(incoming.get(edge.target) || []), edge]);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) || []), edge]);
  }
  const walk = (from: Map<string, BoardEdge[]>, next: (edge: BoardEdge) => string) => {
    const queue = [nodeId];
    const seen = new Set<string>([nodeId]);
    while (queue.length) {
      const current = queue.shift()!;
      for (const edge of from.get(current) || []) {
        links.add(edge.id);
        const other = next(edge);
        nodes.add(other);
        if (!seen.has(other)) { seen.add(other); queue.push(other); }
      }
    }
  };
  walk(incoming, (edge) => edge.source);
  walk(outgoing, (edge) => edge.target);
  return { nodes, links };
}

const json = (body: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const boardApi = {
  list: () => apiJson<{ boards: BoardSummary[] }>('/api/boards').then((data) => data.boards || []),
  get: (id: string) => apiJson<{ board: StoredBoard }>(`/api/boards/${encodeURIComponent(id)}`).then((data) => data.board),
  create: (name: string) => apiJson<{ board: StoredBoard }>('/api/boards', { method: 'POST', ...json({ name }) }).then((data) => data.board),
  rename: (id: string, name: string) => apiJson<{ board: StoredBoard }>(`/api/boards/${encodeURIComponent(id)}`, { method: 'PATCH', ...json({ name }) }).then((data) => data.board),
  remove: (id: string) => apiJson(`/api/boards/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Resolves to the saved board, or rejects with a BoardConflict carrying the board as it is now. */
  async save(id: string, board: ReturnType<typeof fromFlow>, baseRevision: number, { keepalive = false } = {}) {
    let response: Response;
    try {
      response = await apiFetch(`/api/boards/${encodeURIComponent(id)}`, { method: 'PUT', keepalive, ...json({ board, baseRevision }) });
    } catch {
      throw new Error('Can’t reach HEISS UI. Your board will save when it’s back.');
    }
    const data = await response.json().catch(() => ({}));
    if (response.status === 409 && data.board) throw new BoardConflict(data.board);
    if (!response.ok) throw new ApiError(typeof data.error === 'string' ? data.error : 'Couldn’t save the board', response.status, '');
    return data.board as StoredBoard;
  }
};

export class BoardConflict extends Error {
  constructor(readonly board: StoredBoard) {
    super('This board changed on another device.');
    this.name = 'BoardConflict';
  }
}

const acceptedTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
export const maxUploadMb = 25;

/** Why a file can't go on the board, or '' when it can. */
export function fileProblem(file: File) {
  if (!acceptedTypes.has(file.type)) return `${file.name || 'That file'} isn’t a PNG, JPEG or WebP image.`;
  if (file.size > maxUploadMb * 1024 * 1024) return `${file.name || 'That image'} is over ${maxUploadMb} MB.`;
  if (!file.size) return `${file.name || 'That image'} is empty.`;
  return '';
}

const lastBoardKey = 'heiss-ui:whiteboard';
export function rememberedBoard() {
  try { return localStorage.getItem(lastBoardKey) || ''; } catch { return ''; }
}
export function rememberBoard(id: string) {
  try { if (id) localStorage.setItem(lastBoardKey, id); else localStorage.removeItem(lastBoardKey); } catch { /* it just opens the newest board next time */ }
}
