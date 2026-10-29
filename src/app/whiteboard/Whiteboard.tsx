import React from 'react';
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  useStore,
  type Connection,
  type EdgeChange,
  type FinalConnectionState,
  type IsValidConnection,
  type NodeChange,
  type OnBeforeDelete,
  type Viewport
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { ArrowLeft, Check, ChevronDown, CloudOff, GalleryHorizontalEnd, ImagePlus, LoaderCircle, Maximize, Minus, Pencil, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { apiFetch, apiJson } from '../api';
import { Tip } from '../components';
import { SafeImg } from '../SafeImg';
import { cn } from '../format';
import { uploadReferenceAsset } from '../api';
import type { ConfirmAction, PromptText } from '../useConfirmation';
import type { ShowToast } from '../toast';
import type { GalleryItem, Job, Progress, ReferenceAsset } from '../types';
import {
  BoardConflict,
  boardApi,
  boardAspects,
  edgeFor,
  fileProblem,
  fromFlow,
  generateNodeWidth,
  imageHeight,
  imageNodeWidth,
  lineageOf,
  maxReferences,
  newId,
  referencesOf,
  rememberBoard,
  rememberedBoard,
  reorderReferences,
  toFlow,
  type BoardEdge,
  type BoardNode,
  type BoardSummary,
  type GenerateNode,
  type ImageNode,
  type ImageNodeData,
  type StoredBoard
} from './board';
import { BoardActionsContext, BoardLineageContext, BoardProgressContext, BoardReferencesContext, edgeTypes, nodeTypes, type BoardActions, type ReferenceList } from './nodes';
import { GalleryPicker } from './GalleryPicker';

export type WhiteboardProps = {
  onClose: () => void;
  confirmAction: ConfirmAction;
  promptText: PromptText;
  showToast: ShowToast;
  /** Why generating can't happen right now (another engine, signed out), or ''. */
  blocked: string;
};

/**
 * The whiteboard: an infinite canvas of pictures and prompt nodes. Links from
 * pictures into a prompt are its references, in order; Generate sends them to
 * /api/generate and lays what comes back next to the prompt, linked to it, so
 * any result can feed the next prompt. Everything lands in the gallery too.
 */
export function Whiteboard(props: WhiteboardProps) {
  const { showToast, confirmAction, promptText } = props;
  const [boards, setBoards] = React.useState<BoardSummary[]>([]);
  const [board, setBoard] = React.useState<StoredBoard | null>(null);
  const [loadError, setLoadError] = React.useState('');
  const [attempt, setAttempt] = React.useState(0);
  const flushRef = React.useRef<(() => Promise<void>) | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoadError('');
    (async () => {
      try {
        let list = await boardApi.list();
        const wanted = rememberedBoard();
        let target = list.find((item) => item.id === wanted) || list[0];
        if (!target) {
          const created = await boardApi.create('My board');
          list = [{ id: created.id, name: created.name, updatedAt: created.updatedAt, createdAt: created.createdAt, nodeCount: 0 }];
          target = list[0];
        }
        const loaded = await boardApi.get(target.id);
        if (cancelled) return;
        setBoards(list);
        setBoard(loaded);
        rememberBoard(loaded.id);
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : 'Couldn’t open the whiteboard.');
      }
    })();
    return () => { cancelled = true; };
  }, [attempt]);

  const switchTo = React.useCallback(async (id: string) => {
    if (id === board?.id) return;
    await flushRef.current?.().catch(() => null);
    try {
      const loaded = await boardApi.get(id);
      setBoard(loaded);
      rememberBoard(loaded.id);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Couldn’t open that board', 'error');
      setBoards(await boardApi.list().catch(() => boards));
    }
  }, [board?.id, boards, showToast]);

  const createNew = React.useCallback(async () => {
    const name = await promptText({ title: 'New board', label: 'Board name', initialValue: `Board ${boards.length + 1}`, action: 'Create' });
    if (!name) return;
    await flushRef.current?.().catch(() => null);
    try {
      const created = await boardApi.create(name);
      setBoards((current) => [{ id: created.id, name: created.name, updatedAt: created.updatedAt, createdAt: created.createdAt, nodeCount: 0 }, ...current]);
      setBoard(created);
      rememberBoard(created.id);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Couldn’t make a new board', 'error');
    }
  }, [boards.length, promptText, showToast]);

  const removeCurrent = React.useCallback(async () => {
    if (!board) return;
    const ok = await confirmAction({
      title: `Delete “${board.name}”?`,
      description: 'The board and its layout go for good. Its pictures stay in your gallery and uploads.',
      action: 'Delete board',
      destructive: true,
      irreversible: true
    });
    if (!ok) return;
    try {
      flushRef.current = null;
      await boardApi.remove(board.id);
      const rest = boards.filter((item) => item.id !== board.id);
      if (rest.length) {
        setBoards(rest);
        const next = await boardApi.get(rest[0].id);
        setBoard(next);
        rememberBoard(next.id);
      } else {
        const created = await boardApi.create('My board');
        setBoards([{ id: created.id, name: created.name, updatedAt: created.updatedAt, createdAt: created.createdAt, nodeCount: 0 }]);
        setBoard(created);
        rememberBoard(created.id);
      }
      showToast('Board deleted', 'removed');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Couldn’t delete the board', 'error');
    }
  }, [board, boards, confirmAction, showToast]);

  const close = React.useCallback(async () => {
    await flushRef.current?.().catch(() => null);
    props.onClose();
  }, [props]);

  return (
    <div className="wb-root" role="dialog" aria-modal="true" aria-label="Whiteboard" data-whiteboard>
      {board ? (
        <ReactFlowProvider key={board.id}>
          <Canvas
            {...props}
            initial={board}
            boards={boards}
            onRenamed={(id, name) => setBoards((current) => current.map((item) => item.id === id ? { ...item, name } : item))}
            onSaved={(saved) => setBoards((current) => current.map((item) => item.id === saved.id ? { ...item, name: saved.name, updatedAt: saved.updatedAt, nodeCount: saved.nodes.length } : item))}
            onSwitch={switchTo}
            onCreate={createNew}
            onDelete={removeCurrent}
            onClose={close}
            flushRef={flushRef}
          />
        </ReactFlowProvider>
      ) : (
        <div className="wb-loading">
          {loadError ? (
            <div className="wb-empty-card" role="alert">
              <CloudOff size={20} />
              <h2>The whiteboard didn’t open</h2>
              <p>{loadError}</p>
              <div className="wb-empty-actions">
                <button type="button" className="btn is-primary" onClick={() => setAttempt((value) => value + 1)}>Try again</button>
                <button type="button" className="btn" onClick={props.onClose}>Back to the gallery</button>
              </div>
            </div>
          ) : <LoaderCircle className="wb-spin" size={22} aria-label="Opening the whiteboard" />}
        </div>
      )}
    </div>
  );
}

type SaveState = 'saved' | 'saving' | 'offline';

type CanvasProps = WhiteboardProps & {
  initial: StoredBoard;
  boards: BoardSummary[];
  onRenamed: (id: string, name: string) => void;
  onSaved: (board: StoredBoard) => void;
  onSwitch: (id: string) => void;
  onCreate: () => void;
  onDelete: () => void;
  flushRef: React.MutableRefObject<(() => Promise<void>) | null>;
};

const gap = 28;
// Fit leaves room for the board bar, the tool dock and the overview map.
const fitOptions = { padding: { top: '96px', bottom: '96px', left: '48px', right: typeof window !== 'undefined' && window.innerWidth > 1100 ? '220px' : '48px' }, duration: 240, maxZoom: 1.5 } as const;
const thumbFor = (url: string) => url.startsWith('/comfy/view?') ? url.replace('/comfy/view?', '/comfy/thumb?') : url;
type Box = { x: number; y: number; w: number; h: number };
const boxOf = (node: BoardNode): Box => ({ x: node.position.x, y: node.position.y, w: node.width || node.measured?.width || imageNodeWidth, h: node.height || node.measured?.height || 320 });
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
/**
 * The nearest spot to `want` where a w×h node covers nothing, kept inside `bounds`
 * (what's on screen) when given; `want` itself when nothing there is free.
 */
export function freeSpot(nodes: BoardNode[], want: { x: number; y: number }, w: number, h: number, bounds?: Box): { x: number; y: number } {
  const boxes = nodes.map(boxOf);
  const fits = (x: number, y: number) => !boxes.some((box) => overlaps({ x, y, w, h }, box));
  const inside = (x: number, y: number) => !bounds || (x >= bounds.x && y >= bounds.y && x + w <= bounds.x + bounds.w && y + h <= bounds.y + bounds.h);
  if (fits(want.x, want.y)) return want;
  const step = 40;
  let best: { x: number; y: number; d: number } | null = null;
  for (let dx = -40; dx <= 40; dx += 1) {
    for (let dy = -40; dy <= 40; dy += 1) {
      const x = want.x + dx * step;
      const y = want.y + dy * step;
      const d = dx * dx + dy * dy * 1.6;
      if (best && d >= best.d) continue;
      if (inside(x, y) && fits(x, y)) best = { x, y, d };
    }
  }
  if (best) return { x: best.x, y: best.y };
  // Nothing free on screen: the nearest free spot anywhere (the caller brings it into view).
  return bounds ? freeSpot(nodes, want, w, h) : want;
}
const within = (point: { x: number; y: number }, w: number, h: number, bounds?: Box) => !bounds || (point.x >= bounds.x && point.y >= bounds.y && point.x + w <= bounds.x + bounds.w && point.y + h <= bounds.y + bounds.h);
const isTyping = (target: EventTarget | null) => target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));

function Canvas({ initial, boards, onClose, onRenamed, onSaved, onSwitch, onCreate, onDelete, flushRef, confirmAction, promptText, showToast, blocked }: CanvasProps) {
  const flow = useReactFlow<BoardNode, BoardEdge>();
  const start = React.useMemo(() => toFlow(initial), [initial]);
  const [nodes, setNodes] = React.useState<BoardNode[]>(start.nodes);
  const [edges, setEdges] = React.useState<BoardEdge[]>(start.edges);
  const [name, setName] = React.useState(initial.name);
  const [saveState, setSaveState] = React.useState<SaveState>('saved');
  const [uploading, setUploading] = React.useState(0);
  const [dropping, setDropping] = React.useState(false);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [preview, setPreview] = React.useState<ImageNodeData | null>(null);
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const zoom = useStore((state) => state.transform[2]);

  // Latest state for callbacks that must stay stable (the node contexts).
  const nodesRef = React.useRef(nodes);
  const edgesRef = React.useRef(edges);
  const nameRef = React.useRef(name);
  nodesRef.current = nodes;
  edgesRef.current = edges;
  nameRef.current = name;
  const viewportRef = React.useRef<Viewport>(initial.viewport);
  const revisionRef = React.useRef(initial.revision);
  const savedTextRef = React.useRef(JSON.stringify(fromFlow(start.nodes, start.edges, initial.viewport, initial.name)));
  const mountedRef = React.useRef(true);
  React.useEffect(() => () => { mountedRef.current = false; }, []);

  // ---- Saving: debounced, one at a time, never an older copy over a newer one.
  const saving = React.useRef<Promise<void> | null>(null);
  const again = React.useRef(false);
  const timer = React.useRef(0);
  const retryTimer = React.useRef(0);

  const adopt = React.useCallback((board: StoredBoard) => {
    const next = toFlow(board);
    revisionRef.current = board.revision;
    savedTextRef.current = JSON.stringify(fromFlow(next.nodes, next.edges, board.viewport, board.name));
    setNodes(next.nodes);
    setEdges(next.edges);
    setName(board.name);
  }, []);

  const saveNow = React.useCallback(async ({ keepalive = false } = {}): Promise<void> => {
    window.clearTimeout(timer.current);
    if (saving.current) { again.current = true; return saving.current; }
    const payload = fromFlow(nodesRef.current, edgesRef.current, viewportRef.current, nameRef.current);
    const text = JSON.stringify(payload);
    if (text === savedTextRef.current) { if (mountedRef.current) setSaveState('saved'); return; }
    if (mountedRef.current) setSaveState('saving');
    const run = (async () => {
      try {
        const saved = await boardApi.save(initial.id, payload, revisionRef.current, { keepalive });
        revisionRef.current = saved.revision;
        savedTextRef.current = text;
        if (mountedRef.current) { setSaveState('saved'); onSaved(saved); }
      } catch (error) {
        if (error instanceof BoardConflict) {
          if (mountedRef.current) {
            adopt(error.board);
            setSaveState('saved');
            showToast('This board changed on another device. Showing the latest version.', 'warning');
          }
          return;
        }
        if (mountedRef.current) {
          setSaveState('offline');
          window.clearTimeout(retryTimer.current);
          retryTimer.current = window.setTimeout(() => { void saveNow(); }, 4000);
        }
      } finally {
        saving.current = null;
      }
    })();
    saving.current = run;
    await run;
    if (again.current) { again.current = false; await saveNow({ keepalive }); }
  }, [adopt, initial.id, onSaved, showToast]);

  const scheduleSave = React.useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void saveNow(); }, 700);
  }, [saveNow]);

  React.useEffect(() => { scheduleSave(); }, [nodes, edges, name, scheduleSave]);
  React.useEffect(() => {
    flushRef.current = () => saveNow({ keepalive: true });
    const onHide = () => { if (document.visibilityState === 'hidden') void saveNow({ keepalive: true }); };
    const onUnload = () => { void saveNow({ keepalive: true }); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onUnload);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onUnload);
      window.clearTimeout(timer.current);
      window.clearTimeout(retryTimer.current);
    };
  }, [flushRef, saveNow]);

  // ---- Placing things.
  /** The part of the board on screen, inside the bars at the top and bottom. */
  const visible = React.useCallback((): Box | undefined => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) return undefined;
    const a = flow.screenToFlowPosition({ x: rect.left + 24, y: rect.top + 84 });
    const b = flow.screenToFlowPosition({ x: rect.right - 24, y: rect.bottom - 84 });
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  }, [flow]);

  const centre = React.useCallback(() => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  }, [flow]);

  const imageNode = (asset: Pick<ReferenceAsset, 'id' | 'url' | 'thumbnailUrl' | 'name' | 'width' | 'height' | 'source' | 'galleryItemId'>, position: { x: number; y: number }): ImageNode => {
    const data: ImageNodeData = {
      assetId: asset.id,
      url: asset.url || asset.thumbnailUrl,
      thumbnailUrl: asset.thumbnailUrl || asset.url,
      name: asset.name,
      width: asset.width,
      height: asset.height,
      source: asset.source === 'generation' ? 'generation' : 'upload',
      ...(asset.galleryItemId ? { galleryItemId: asset.galleryItemId } : {})
    };
    return { id: newId('img'), type: 'image', position, data, width: imageNodeWidth, height: imageHeight(imageNodeWidth, data) };
  };

  /** Lays pictures out in rows from `at`, so a drop of ten doesn't land in one pile. */
  const addAssets = React.useCallback((assets: ReferenceAsset[], at?: { x: number; y: number }) => {
    if (!assets.length) return;
    const perRow = Math.min(4, assets.length);
    const rows = Math.ceil(assets.length / perRow);
    const blockW = perRow * (imageNodeWidth + gap);
    const view = visible();
    const blockH = rows * (imageNodeWidth + gap);
    const origin = at || (() => { const c = centre(); return freeSpot(nodesRef.current, { x: c.x - blockW / 2, y: c.y - 120 }, blockW, blockH, view); })();
    if (!at && !within(origin, blockW, blockH, view)) flow.setCenter(origin.x + blockW / 2, origin.y + blockH / 2, { duration: 260, zoom: flow.getZoom() });
    const placed = assets.map((asset, index) => imageNode(asset, {
      x: origin.x + (index % perRow) * (imageNodeWidth + gap),
      y: origin.y + Math.floor(index / perRow) * (imageNodeWidth + gap)
    }));
    setNodes((current) => [...current.map((node) => node.selected ? { ...node, selected: false } : node), ...placed.map((node) => ({ ...node, selected: true }))]);
  }, [centre, flow, visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const uploadFiles = React.useCallback(async (files: File[], at?: { x: number; y: number }) => {
    const problems = files.map(fileProblem).filter(Boolean);
    const good = files.filter((file) => !fileProblem(file));
    if (problems.length) showToast(problems.length === 1 ? problems[0] : `${problems.length} files were skipped: only PNG, JPEG or WebP images up to 25 MB go on the board.`, 'warning');
    if (!good.length) return;
    setUploading((value) => value + good.length);
    const assets: ReferenceAsset[] = [];
    const failures: string[] = [];
    // Three at a time: a drop of forty images shouldn't open forty uploads.
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, good.length) }, async () => {
      while (next < good.length) {
        const file = good[next++];
        try {
          assets.push(await uploadReferenceAsset(file));
        } catch (error) {
          failures.push(error instanceof Error ? error.message : 'Upload failed');
        } finally {
          if (mountedRef.current) setUploading((value) => Math.max(0, value - 1));
        }
      }
    }));
    if (!mountedRef.current) return;
    addAssets(assets.sort((a, b) => good.findIndex((file) => file.name === a.name) - good.findIndex((file) => file.name === b.name)), at);
    if (failures.length) showToast(failures.length === 1 ? `Couldn’t add the image: ${failures[0]}` : `${failures.length} images couldn’t be added. ${failures[0]}`, 'error');
  }, [addAssets, showToast]);

  const addPrompt = React.useCallback((at?: { x: number; y: number }, links: string[] = []) => {
    const view = visible();
    const position = at || (() => { const c = centre(); return freeSpot(nodesRef.current, { x: c.x - generateNodeWidth / 2, y: c.y - 150 }, generateNodeWidth, 320, view); })();
    if (!within(position, generateNodeWidth, 320, view)) flow.setCenter(position.x + generateNodeWidth / 2, position.y + 160, { duration: 260, zoom: flow.getZoom() });
    const id = newId('gen');
    const node: GenerateNode = { id, type: 'generate', position, width: generateNodeWidth, data: { prompt: '', aspect: '1:1', count: 1, status: 'idle' }, selected: true };
    setNodes((current) => [...current.map((item) => item.selected ? { ...item, selected: false } : item), node]);
    if (links.length) setEdges((current) => [...current, ...links.slice(0, maxReferences).map((source, order) => edgeFor(source, id, 'reference', order))]);
    window.setTimeout(() => document.getElementById(`wb-prompt-${id}`)?.focus({ preventScroll: true }), 60);
    return id;
  }, [centre, flow, visible]);

  // ---- Generating.
  const posting = React.useRef(new Set<string>());
  // Kept beside the nodes, not in them: a tick of progress isn't a change to the board to save.
  const [progress, setProgress] = React.useState<Map<string, Progress>>(new Map());
  const noteProgress = React.useCallback((genId: string, value: Progress | undefined) => {
    setProgress((current) => {
      if (!value && !current.has(genId)) return current;
      const next = new Map(current);
      if (value) next.set(genId, value); else next.delete(genId);
      return next;
    });
  }, []);
  const polling = React.useRef(new Set<string>());
  const patchGenerate = React.useCallback((id: string, patch: Partial<GenerateNode['data']>) => {
    setNodes((current) => current.map((node) => node.id === id && node.type === 'generate' ? { ...node, data: { ...node.data, ...patch } } as GenerateNode : node));
  }, []);

  const placeResults = React.useCallback((genId: string, outputs: GalleryItem[], prompt: string) => {
    const done = outputs.filter((item) => item.type === 'image' && item.url);
    if (!done.length) return;
    {
      const current = nodesRef.current;
      const gen = current.find((node) => node.id === genId);
      if (!gen) return;
      const earlier = current.filter((node) => node.type === 'image' && node.data.fromNode === genId);
      const known = new Set(earlier.map((node) => (node.data as ImageNodeData).assetId));
      const fresh = done.filter((item) => !known.has(item.url));
      if (!fresh.length) return;
      // Each run gets its own column to the right of the prompt, newest furthest out.
      const columns = new Set(earlier.map((node) => Math.round(node.position.x))).size;
      const x = gen.position.x + (gen.width || generateNodeWidth) + 72 + columns * (imageNodeWidth + gap);
      let y = gen.position.y;
      const placed: ImageNode[] = [];
      const made: ImageNode[] = fresh.map((item) => {
        const data: ImageNodeData = { assetId: item.url, url: item.url, thumbnailUrl: item.thumbnailUrl || thumbFor(item.url), name: item.outputName || item.filename, width: item.width, height: item.height, source: 'generation', galleryItemId: item.id || item.url, prompt, fromNode: genId };
        const height = imageHeight(imageNodeWidth, data);
        const position = freeSpot([...current, ...placed], { x, y }, imageNodeWidth, height);
        const node: ImageNode = { id: newId('img'), type: 'image', position, data, width: imageNodeWidth, height };
        placed.push(node);
        y = position.y + height + gap;
        return node;
      });
      setNodes((nodes) => [...nodes, ...made]);
      setEdges((links) => [...links, ...made.map((node) => edgeFor(genId, node.id, 'result'))]);
    }
  }, []);

  const poll = React.useCallback(async (genId: string, jobId: string, prompt: string) => {
    if (polling.current.has(jobId)) return;
    polling.current.add(jobId);
    let misses = 0;
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => setTimeout(resolve, 1500 * Math.min(4, 1 + misses)));
        if (!mountedRef.current) return;
        const gen = nodesRef.current.find((node) => node.id === genId);
        // Deleted from the board, or started again: this job isn't the node's any more.
        if (!gen || gen.type !== 'generate' || gen.data.jobId !== jobId || gen.data.status !== 'running') return;
        let job: Job;
        try {
          job = await apiJson<Job>(`/api/jobs/${encodeURIComponent(jobId)}`);
          misses = 0;
        } catch {
          misses += 1;
          if (misses < 12) continue;
          patchGenerate(genId, { status: 'error', error: 'Lost the connection to HEISS UI. The image may still finish in the gallery.' });
          return;
        }
        if (job.status === 'queued' || job.status === 'running') { noteProgress(genId, job.progress); continue; }
        noteProgress(genId, undefined);
        if (job.status === 'done') {
          placeResults(genId, job.outputs || [], prompt);
          patchGenerate(genId, { status: 'done', error: undefined });
          return;
        }
        if (job.status === 'error') { patchGenerate(genId, { status: 'error', error: job.error || 'The image couldn’t be made. Try again.' }); return; }
        if (job.status === 'canceled' || job.status === 'canceling') { patchGenerate(genId, { status: 'canceled' }); return; }
        if (job.status === 'missing') { patchGenerate(genId, { status: 'error', error: 'This run was interrupted when HEISS UI restarted. Try again.' }); return; }
      }
    } finally {
      polling.current.delete(jobId);
      if (mountedRef.current) noteProgress(genId, undefined);
    }
  }, [noteProgress, patchGenerate, placeResults]);

  // A board opened while its prompts were running picks the runs back up.
  React.useEffect(() => {
    for (const node of nodesRef.current) {
      if (node.type === 'generate' && node.data.status === 'running' && node.data.jobId) void poll(node.id, node.data.jobId, node.data.prompt);
    }
  }, [poll]);

  const generate = React.useCallback(async (genId: string) => {
    const gen = nodesRef.current.find((node) => node.id === genId);
    if (!gen || gen.type !== 'generate') return;
    // A double click, or Generate while it runs, starts nothing new.
    if (gen.data.status === 'running' || posting.current.has(genId)) return;
    const prompt = gen.data.prompt.trim();
    if (!prompt) { patchGenerate(genId, { status: 'error', error: 'Write a prompt first.' }); return; }
    const references = referencesOf(genId, nodesRef.current, edgesRef.current);
    const size = boardAspects.find((item) => item.value === gen.data.aspect) || boardAspects[0];
    posting.current.add(genId);
    const clientJobId = newId('wb');
    patchGenerate(genId, { status: 'running', jobId: clientJobId, startedAt: Date.now(), error: undefined });
    try {
      const response = await apiJson<{ jobId: string }>('/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'image',
          model: 'gpt-image',
          profileId: 'gpt-image',
          prompt,
          width: size.width,
          height: size.height,
          count: gen.data.count,
          referenceAssets: references.map(({ node }) => ({ assetId: node.data.assetId })),
          clientJobId
        })
      });
      const jobId = response.jobId || clientJobId;
      patchGenerate(genId, { jobId });
      // The ref still holds the pre-patch node until React re-renders; let it catch up.
      window.setTimeout(() => { void poll(genId, jobId, prompt); }, 0);
    } catch (error) {
      patchGenerate(genId, { status: 'error', jobId: undefined, error: error instanceof Error ? error.message : 'Couldn’t start the generation. Try again.' });
    } finally {
      posting.current.delete(genId);
    }
  }, [patchGenerate, poll]);

  const cancel = React.useCallback(async (genId: string) => {
    const gen = nodesRef.current.find((node) => node.id === genId);
    if (!gen || gen.type !== 'generate' || !gen.data.jobId) return;
    const jobId = gen.data.jobId;
    patchGenerate(genId, { status: 'canceled' });
    const response = await apiFetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }).catch(() => null);
    if (!response?.ok) showToast('Couldn’t reach HEISS UI to stop it. It may still finish in the gallery.', 'error');
  }, [patchGenerate, showToast]);

  // ---- Links.
  const isValidConnection: IsValidConnection<BoardEdge> = React.useCallback((connection) => {
    const source = nodesRef.current.find((node) => node.id === connection.source);
    const target = nodesRef.current.find((node) => node.id === connection.target);
    if (source?.type !== 'image' || target?.type !== 'generate' || connection.targetHandle !== 'refs') return false;
    if (target.data.status === 'running') return false;
    const into = edgesRef.current.filter((edge) => edge.target === target.id && edge.data?.kind !== 'result');
    return into.length < maxReferences && !into.some((edge) => edge.source === source.id);
  }, []);

  const onConnect = React.useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    setEdges((current) => {
      const into = current.filter((edge) => edge.target === connection.target && edge.data?.kind !== 'result');
      if (into.length >= maxReferences || into.some((edge) => edge.source === connection.source)) return current;
      const order = into.reduce((max, edge) => Math.max(max, (edge.data?.order ?? 0) + 1), 0);
      return [...current, edgeFor(connection.source, connection.target, 'reference', order)];
    });
  }, []);

  // Letting go of a link over empty canvas starts a new prompt there, already linked.
  const onConnectEnd = React.useCallback((event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    if (state.isValid || state.toNode || !state.fromNode || state.fromNode.type !== 'image') return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest('.react-flow__pane')) return;
    const point = 'changedTouches' in event ? event.changedTouches[0] : event;
    const at = flow.screenToFlowPosition({ x: point.clientX, y: point.clientY });
    addPrompt({ x: at.x + 8, y: at.y - 150 }, [state.fromNode.id]);
  }, [addPrompt, flow]);

  const moveReference = React.useCallback((genId: string, edgeId: string, step: -1 | 1) => {
    setEdges((current) => {
      const ordered = referencesOf(genId, nodesRef.current, current).map((item) => item.edge.id);
      const index = ordered.indexOf(edgeId);
      const swap = index + step;
      if (index < 0 || swap < 0 || swap >= ordered.length) return current;
      [ordered[index], ordered[swap]] = [ordered[swap], ordered[index]];
      return reorderReferences(current, genId, ordered);
    });
  }, []);

  const unlink = React.useCallback((edgeId: string) => {
    setEdges((current) => current.filter((edge) => edge.id !== edgeId));
  }, []);

  // ---- Deleting: the app's confirm, saying the pictures themselves stay.
  const onBeforeDelete: OnBeforeDelete<BoardNode, BoardEdge> = React.useCallback(async ({ nodes: gone, edges: links }) => {
    if (!gone.length) return { nodes: gone, edges: links };
    const running = gone.filter((node) => node.type === 'generate' && node.data.status === 'running').length;
    const ok = await confirmAction({
      title: gone.length === 1 ? 'Remove this from the board?' : `Remove ${gone.length} items from the board?`,
      description: `The pictures stay in your gallery and uploads.${running ? ' A run that’s going keeps going and lands in the gallery.' : ''}`,
      action: 'Remove',
      destructive: true
    });
    return ok ? { nodes: gone, edges: links } : false;
  }, [confirmAction]);

  const onNodesChange = React.useCallback((changes: NodeChange<BoardNode>[]) => setNodes((current) => applyNodeChanges(changes, current)), []);
  const onEdgesChange = React.useCallback((changes: EdgeChange<BoardEdge>[]) => setEdges((current) => applyEdgeChanges(changes, current)), []);

  const duplicateSelection = React.useCallback(() => {
    const chosen = nodesRef.current.filter((node) => node.selected);
    if (!chosen.length) return;
    const ids = new Map(chosen.map((node) => [node.id, newId(node.type === 'image' ? 'img' : 'gen')]));
    const copies = chosen.map((node) => ({
      ...node,
      id: ids.get(node.id)!,
      position: { x: node.position.x + 36, y: node.position.y + 36 },
      selected: true,
      dragging: false,
      // A copied prompt starts fresh: it isn't the run its original is waiting on.
      data: node.type === 'generate' ? { ...node.data, status: 'idle', jobId: undefined, error: undefined, startedAt: undefined } : { ...node.data }
    } as BoardNode));
    // A copied prompt keeps its references (a variation), pointing at copies where those were copied too.
    const links = edgesRef.current
      .filter((edge) => edge.data?.kind !== 'result' && ids.has(edge.target))
      .map((edge) => edgeFor(ids.get(edge.source) || edge.source, ids.get(edge.target)!, 'reference', edge.data?.order || 0));
    setNodes((current) => [...current.map((node) => node.selected ? { ...node, selected: false } : node), ...copies]);
    setEdges((current) => [...current, ...links]);
  }, []);

  // ---- Keys: ⌘D duplicates, ⌘A selects all, N adds a prompt, Esc steps back out.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('[role="alertdialog"], [role="dialog"]:not([data-whiteboard]):not([data-wb-preview])')) return;
      const mod = event.metaKey || event.ctrlKey;
      if (event.key === 'Escape') {
        if (isTyping(event.target)) { (event.target as HTMLElement).blur(); event.preventDefault(); event.stopImmediatePropagation(); return; }
        event.preventDefault();
        event.stopImmediatePropagation();
        if (preview) { setPreview(null); return; }
        if (menuOpen) { setMenuOpen(false); return; }
        if (nodesRef.current.some((node) => node.selected) || edgesRef.current.some((edge) => edge.selected)) {
          setNodes((current) => current.map((node) => node.selected ? { ...node, selected: false } : node));
          setEdges((current) => current.map((edge) => edge.selected ? { ...edge, selected: false } : edge));
          return;
        }
        onClose();
        return;
      }
      if (isTyping(event.target)) return;
      if (mod && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicateSelection(); return; }
      if (mod && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        setNodes((current) => current.map((node) => ({ ...node, selected: true })));
        return;
      }
      if (!mod && !event.altKey && event.key.toLowerCase() === 'n') { event.preventDefault(); addPrompt(); }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [addPrompt, duplicateSelection, menuOpen, onClose, preview]);

  // Pasting an image (a screenshot, a copied picture) puts it in the middle of the view.
  React.useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (isTyping(event.target) || document.querySelector('[role="alertdialog"], [role="dialog"]:not([data-whiteboard]):not([data-wb-preview])')) return;
      const files = Array.from(event.clipboardData?.files || []);
      if (!files.length) return;
      event.preventDefault();
      void uploadFiles(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [uploadFiles]);

  // ---- What the nodes read.
  const actions = React.useMemo<BoardActions>(() => ({
    generate: (id) => { void generate(id); },
    cancel: (id) => { void cancel(id); },
    updateGenerate: patchGenerate,
    moveReference,
    unlink,
    openImage: setPreview,
    blocked
  }), [blocked, cancel, generate, moveReference, patchGenerate, unlink]);

  // References per prompt, rebuilt only when links or the pictures they point at change, not on every drag frame.
  const referencesCache = React.useRef<Map<string, ReferenceList>>(new Map());
  const referenceMap = React.useMemo(() => {
    const map = new Map<string, ReferenceList>();
    for (const node of nodes) if (node.type === 'generate') map.set(node.id, referencesOf(node.id, nodes, edges));
    const previous = referencesCache.current;
    const same = previous.size === map.size && [...map].every(([id, list]) => {
      const old = previous.get(id);
      return old && old.length === list.length && list.every((item, index) => item.edge === old[index].edge && item.node.data === old[index].node.data);
    });
    if (same) return previous;
    referencesCache.current = map;
    return map;
  }, [nodes, edges]);

  const selectedId = React.useMemo(() => {
    const chosen = nodes.filter((node) => node.selected);
    return chosen.length === 1 ? chosen[0].id : '';
  }, [nodes]);
  const lineage = React.useMemo(() => {
    if (!selectedId) return null;
    const found = lineageOf(selectedId, edges);
    return found.links.size ? found : null;
  }, [selectedId, edges]);

  const empty = nodes.length === 0;
  const running = nodes.filter((node) => node.type === 'generate' && node.data.status === 'running').length;

  const rename = async () => {
    setMenuOpen(false);
    const next = await promptText({ title: 'Rename board', label: 'Board name', initialValue: name, action: 'Rename' });
    const clean = next?.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!clean || clean === name) return;
    setName(clean);
    onRenamed(initial.id, clean);
  };

  const onDragOver = (event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDropping(true);
  };
  const onDrop = (event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    setDropping(false);
    const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    void uploadFiles(Array.from(event.dataTransfer.files), at);
  };

  return (
    <BoardActionsContext.Provider value={actions}>
    <BoardReferencesContext.Provider value={referenceMap}>
    <BoardLineageContext.Provider value={lineage}>
    <BoardProgressContext.Provider value={progress}>
      <div
        ref={wrapperRef}
        className={cn('wb-canvas', dropping && 'is-dropping', zoom < 0.4 && 'is-far')}
        onDragOver={onDragOver}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false); }}
        onDrop={onDrop}
      >
        <ReactFlow<BoardNode, BoardEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          isValidConnection={isValidConnection}
          onBeforeDelete={onBeforeDelete}
          onMoveEnd={(_, viewport) => { viewportRef.current = viewport; scheduleSave(); }}
          defaultViewport={initial.viewport}
          minZoom={0.08}
          maxZoom={4}
          deleteKeyCode={['Backspace', 'Delete']}
          multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
          selectionKeyCode="Shift"
          panOnScroll
          zoomOnPinch
          panActivationKeyCode="Space"
          onlyRenderVisibleElements
          connectionRadius={36}
          proOptions={{ hideAttribution: true }}
          colorMode="dark"
          aria-label="Whiteboard canvas"
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="rgb(255 255 255 / .14)" />
          {empty ? null : <MiniMap
            className="wb-minimap"
            style={{ width: 168, height: 112 }}
            pannable
            zoomable
            ariaLabel="Board overview"
            bgColor="rgb(14 14 14 / .9)"
            maskColor="rgb(0 0 0 / .55)"
            nodeColor={(node) => node.type === 'generate' ? 'rgb(255 154 82 / .7)' : 'rgb(255 255 255 / .28)'}
            nodeBorderRadius={3}
          />}
        </ReactFlow>

        <div className="wb-top">
          <div className="wb-island">
            <Tip content="Back to the gallery (Esc)"><button type="button" className="wb-icon" aria-label="Back to the gallery" onClick={onClose}><ArrowLeft size={16} /></button></Tip>
            <div className="wb-board-menu">
              <button type="button" className="wb-board-name" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}>
                <span>{name}</span><ChevronDown size={14} />
              </button>
              {menuOpen ? (
                <>
                  <button type="button" className="wb-menu-dismiss" aria-hidden tabIndex={-1} onClick={() => setMenuOpen(false)} />
                  <div className="wb-menu" role="menu" aria-label="Boards">
                    <div className="wb-menu-list">
                      {boards.map((item) => (
                        <button key={item.id} type="button" role="menuitemradio" aria-checked={item.id === initial.id} className={cn('wb-menu-item', item.id === initial.id && 'is-current')} onClick={() => { setMenuOpen(false); onSwitch(item.id); }}>
                          <span>{item.id === initial.id ? name : item.name}</span>
                          <em>{item.id === initial.id ? nodes.length : item.nodeCount}</em>
                          {item.id === initial.id ? <Check size={13} /> : null}
                        </button>
                      ))}
                    </div>
                    <div className="wb-menu-sep" role="separator" />
                    <button type="button" role="menuitem" className="wb-menu-item" onClick={() => { setMenuOpen(false); onCreate(); }}><Plus size={13} /><span>New board</span></button>
                    <button type="button" role="menuitem" className="wb-menu-item" onClick={rename}><Pencil size={13} /><span>Rename…</span></button>
                    <button type="button" role="menuitem" className="wb-menu-item is-danger" onClick={() => { setMenuOpen(false); onDelete(); }}><Trash2 size={13} /><span>Delete board…</span></button>
                  </div>
                </>
              ) : null}
            </div>
            <span className={cn('wb-save', `is-${saveState}`)} role="status" aria-live="polite">
              {saveState === 'saving' ? 'Saving…' : saveState === 'offline' ? <><CloudOff size={12} /> Not saved yet</> : 'Saved'}
            </span>
          </div>
          {uploading || running ? (
            <div className="wb-island wb-activity" role="status" aria-live="polite">
              <LoaderCircle className="wb-spin" size={13} />
              <span>{[uploading ? `Adding ${uploading} image${uploading > 1 ? 's' : ''}` : '', running ? `${running} generating` : ''].filter(Boolean).join(' · ')}</span>
            </div>
          ) : null}
        </div>

        <div className="wb-dock wb-island" role="toolbar" aria-label="Board tools">
          <Tip content="Upload images" side="top"><button type="button" className="wb-tool" aria-label="Upload images" onClick={() => fileRef.current?.click()}><ImagePlus size={16} /><span>Upload</span></button></Tip>
          <Tip content="Add from the gallery" side="top"><button type="button" className="wb-tool" aria-label="Add from the gallery" onClick={() => setPickerOpen(true)}><GalleryHorizontalEnd size={16} /><span>Gallery</span></button></Tip>
          <Tip content="New prompt (N)" side="top"><button type="button" className="wb-tool is-prompt" aria-label="New prompt" onClick={() => addPrompt()}><Sparkles size={16} /><span>Prompt</span></button></Tip>
          <span className="wb-dock-sep" aria-hidden />
          <Tip content="Zoom out" side="top"><button type="button" className="wb-icon" aria-label="Zoom out" onClick={() => flow.zoomOut({ duration: 160 })}><Minus size={15} /></button></Tip>
          <Tip content="Fit everything" side="top"><button type="button" className="wb-zoom" aria-label={`Zoom ${Math.round(zoom * 100)} percent. Fit everything`} onClick={() => flow.fitView(fitOptions)}>{Math.round(zoom * 100)}%</button></Tip>
          <Tip content="Zoom in" side="top"><button type="button" className="wb-icon" aria-label="Zoom in" onClick={() => flow.zoomIn({ duration: 160 })}><Plus size={15} /></button></Tip>
          <Tip content="Fit everything" side="top"><button type="button" className="wb-icon" aria-label="Fit everything" onClick={() => flow.fitView(fitOptions)}><Maximize size={14} /></button></Tip>
        </div>

        {empty ? (
          <div className="wb-empty">
            <div className="wb-empty-card">
              <h2>Start your board</h2>
              <p>Drop images from Finder, paste one, or start with a prompt. Drag from an image’s dot into a prompt to use it as a reference.</p>
              <div className="wb-empty-actions">
                <button type="button" className="btn" onClick={() => fileRef.current?.click()}><ImagePlus size={14} /> Upload images</button>
                <button type="button" className="btn" onClick={() => setPickerOpen(true)}><GalleryHorizontalEnd size={14} /> From the gallery</button>
                <button type="button" className="btn is-primary" onClick={() => addPrompt()}><Sparkles size={14} /> New prompt</button>
              </div>
            </div>
          </div>
        ) : null}

        {dropping ? <div className="wb-drop" aria-hidden><span><ImagePlus size={18} /> Drop to add to the board</span></div> : null}

        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          hidden
          onChange={(event) => { const files = Array.from(event.target.files || []); event.target.value = ''; void uploadFiles(files); }}
        />

        {preview ? (
          <div className="wb-preview" data-wb-preview role="dialog" aria-modal="true" aria-label="Image preview" onClick={() => setPreview(null)}>
            <SafeImg src={preview.url} alt={preview.prompt || preview.name || 'Image'} onClick={(event) => event.stopPropagation()} fallback={<p className="wb-preview-prompt">This image isn’t there any more.</p>} />
            {preview.prompt ? <p className="wb-preview-prompt" onClick={(event) => event.stopPropagation()}>{preview.prompt}</p> : null}
            <button type="button" className="wb-icon wb-preview-close" aria-label="Close preview" autoFocus onClick={() => setPreview(null)}><X size={16} /></button>
          </div>
        ) : null}
      </div>
      <GalleryPicker open={pickerOpen} onOpenChange={setPickerOpen} onAdd={(assets) => addAssets(assets)} showToast={showToast} />
    </BoardProgressContext.Provider>
    </BoardLineageContext.Provider>
    </BoardReferencesContext.Provider>
    </BoardActionsContext.Provider>
  );
}

export { ReactFlowProvider };
