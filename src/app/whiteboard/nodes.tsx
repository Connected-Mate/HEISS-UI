import React from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, Handle, NodeResizer, Position, type EdgeProps, type NodeProps } from '@xyflow/react';
import { ChevronLeft, ChevronRight, ImageOff, Minus, Plus, Sparkles, Square, X } from 'lucide-react';
import { cn } from '../format';
import { boardAspects, maxCount, maxReferences, type BoardAspect, type BoardEdge, type GenerateNode, type ImageNode, type ImageNodeData } from './board';

export type BoardActions = {
  generate: (nodeId: string) => void;
  cancel: (nodeId: string) => void;
  updateGenerate: (nodeId: string, patch: Partial<GenerateNode['data']>) => void;
  moveReference: (nodeId: string, edgeId: string, step: -1 | 1) => void;
  unlink: (edgeId: string) => void;
  openImage: (data: ImageNodeData) => void;
  /** Why generating can't happen at all right now (wrong engine, signed out), or ''. */
  blocked: string;
};
export type ReferenceList = Array<{ edge: BoardEdge; node: ImageNode }>;
export type Lineage = { nodes: Set<string>; links: Set<string> } | null;

// Three contexts, so dragging a node (new positions every frame) re-renders none of the others:
// the actions are stable, the references change only with links and pictures, lineage with selection.
export const BoardActionsContext = React.createContext<BoardActions | null>(null);
export const BoardReferencesContext = React.createContext<Map<string, ReferenceList>>(new Map());
export const BoardLineageContext = React.createContext<Lineage>(null);
const useActions = () => React.useContext(BoardActionsContext)!;
const noReferences: ReferenceList = [];
const useReferences = (nodeId: string) => React.useContext(BoardReferencesContext).get(nodeId) || noReferences;
const useLineage = () => React.useContext(BoardLineageContext);

function useNow(active: boolean) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

const expectedMs = 45_000;
/** The same curve the server's ticker draws (server/jobs.js runGptJob): honest about "about 40 s", never at 100 before it's done. */
export function runShare(startedAt: number | undefined, now: number) {
  if (!startedAt) return 0.02;
  return Math.max(0.02, Math.min(0.97, 1 - Math.exp(-(now - startedAt) / expectedMs)));
}

function Thumb({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [src]);
  if (failed || !src) {
    return <span className="wb-image-gone" role="img" aria-label={`${alt}: image not found`}><ImageOff size={18} /><span>Image not found</span></span>;
  }
  return <img src={src} alt={alt} draggable={false} loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}

export const ImageNodeView = React.memo(function ImageNodeView({ id, data, selected }: NodeProps<ImageNode>) {
  const actions = useActions();
  const lineage = useLineage();
  const label = data.prompt ? data.prompt : data.name || 'Image';
  const dim = lineage && !lineage.nodes.has(id);
  return (
    <div
      className={cn('wb-image', selected && 'is-selected', dim && 'is-dim', data.fromNode && 'is-result')}
      onDoubleClick={() => actions.openImage(data)}
      title={label}
    >
      <NodeResizer isVisible={selected} keepAspectRatio minWidth={96} minHeight={60} maxWidth={2400} maxHeight={2400} color="rgb(255 255 255 / .55)" handleClassName="wb-resize-handle" lineClassName="wb-resize-line" />
      <Handle type="target" id="from" position={Position.Left} isConnectable={false} className="wb-handle is-quiet" />
      <Thumb src={data.thumbnailUrl || data.url} alt={label} />
      <span className="wb-image-caption">{data.fromNode ? <Sparkles size={11} aria-hidden /> : null}<span>{label}</span></span>
      <Handle type="source" id="out" position={Position.Right} className="wb-handle" aria-label="Drag to a prompt to use this image as a reference" />
    </div>
  );
});

function formatSeconds(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

export const GenerateNodeView = React.memo(function GenerateNodeView({ id, data, selected }: NodeProps<GenerateNode>) {
  const actions = useActions();
  const references = useReferences(id);
  const lineage = useLineage();
  const running = data.status === 'running';
  const empty = !data.prompt.trim();
  const dim = lineage && !lineage.nodes.has(id);
  const now = useNow(running);
  const share = running ? runShare(data.startedAt, now) : 0;
  const reason = actions.blocked || (empty ? 'Write a prompt first' : '');
  const promptId = `wb-prompt-${id}`;
  return (
    <div className={cn('wb-generate', selected && 'is-selected', dim && 'is-dim', running && 'is-running', data.status === 'error' && 'is-error')}>
      <Handle type="target" id="refs" position={Position.Left} className="wb-handle is-refs" aria-label={`References: drop up to ${maxReferences} image links here`} />
      <header className="wb-generate-head">
        <label htmlFor={promptId}>Prompt</label>
        <span className="wb-generate-meta">{references.length ? `${references.length} reference${references.length > 1 ? 's' : ''}` : 'No references'}</span>
      </header>
      {references.length ? (
        <ol className="wb-refs nodrag" aria-label="References, in the order the model sees them">
          {references.map(({ edge, node }, index) => (
            <li key={edge.id} className="wb-ref">
              <span className="wb-ref-thumb"><Thumb src={node.data.thumbnailUrl || node.data.url} alt={`Reference ${index + 1}`} /></span>
              <i className="wb-ref-index" aria-hidden>{index + 1}</i>
              <span className="wb-ref-tools">
                <button type="button" aria-label={`Move reference ${index + 1} earlier`} disabled={index === 0 || running} onClick={() => actions.moveReference(id, edge.id, -1)}><ChevronLeft size={12} /></button>
                <button type="button" aria-label={`Remove reference ${index + 1}`} disabled={running} onClick={() => actions.unlink(edge.id)}><X size={12} /></button>
                <button type="button" aria-label={`Move reference ${index + 1} later`} disabled={index === references.length - 1 || running} onClick={() => actions.moveReference(id, edge.id, 1)}><ChevronRight size={12} /></button>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="wb-refs-empty">Drag from an image’s dot to here to use it as a reference.</p>
      )}
      <textarea
        id={promptId}
        className="wb-prompt nodrag nowheel nopan"
        value={data.prompt}
        placeholder={references.length ? 'What to change, or what to make from these…' : 'Describe the image…'}
        rows={4}
        maxLength={4000}
        disabled={running}
        onChange={(event) => actions.updateGenerate(id, { prompt: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (!reason) actions.generate(id);
          }
          // Typing never reaches the board's own shortcuts (Delete removes nodes).
          event.stopPropagation();
        }}
      />
      <div className="wb-generate-row nodrag">
        <div className="wb-aspects" role="radiogroup" aria-label="Shape">
          {boardAspects.map((aspect) => (
            <button
              key={aspect.value}
              type="button"
              role="radio"
              aria-checked={data.aspect === aspect.value}
              aria-label={`${aspect.label} ${aspect.value}`}
              title={`${aspect.label} · ${aspect.width}×${aspect.height}`}
              className={cn('wb-aspect', data.aspect === aspect.value && 'is-on')}
              disabled={running}
              onClick={() => actions.updateGenerate(id, { aspect: aspect.value as BoardAspect })}
            >
              <i style={{ aspectRatio: `${aspect.width} / ${aspect.height}` }} aria-hidden />
            </button>
          ))}
        </div>
        <div className="wb-count" role="group" aria-label="Number of images">
          <button type="button" aria-label="Fewer images" disabled={running || data.count <= 1} onClick={() => actions.updateGenerate(id, { count: Math.max(1, data.count - 1) })}><Minus size={12} /></button>
          <output aria-live="polite" aria-label={`${data.count} image${data.count > 1 ? 's' : ''}`}>×{data.count}</output>
          <button type="button" aria-label="More images" disabled={running || data.count >= maxCount} onClick={() => actions.updateGenerate(id, { count: Math.min(maxCount, data.count + 1) })}><Plus size={12} /></button>
        </div>
      </div>
      {running ? (
        <div className="wb-progress nodrag" role="status">
          <div className="wb-progress-track" aria-hidden><i style={{ transform: `scaleX(${share})` }} /></div>
          <span className="wb-progress-text">Generating{data.count > 1 ? ` ${data.count} images` : ''} · {formatSeconds(now - (data.startedAt || now))}</span>
          <button type="button" className="wb-cancel" onClick={() => actions.cancel(id)}><Square size={10} fill="currentColor" /> Stop</button>
        </div>
      ) : (
        <>
          {data.status === 'error' && data.error ? <p className="wb-error" role="alert">{data.error}</p> : null}
          {data.status === 'canceled' ? <p className="wb-note">Stopped.</p> : null}
          <button
            type="button"
            className="wb-go nodrag"
            disabled={Boolean(reason)}
            title={reason || 'Generate (⌘/Ctrl + Enter)'}
            onClick={() => actions.generate(id)}
          >
            <Sparkles size={14} />
            {data.status === 'error' ? 'Try again' : data.status === 'done' ? 'Generate again' : 'Generate'}
          </button>
          {actions.blocked ? <p className="wb-note">{actions.blocked}</p> : null}
        </>
      )}
      <Handle type="source" id="out" position={Position.Right} isConnectable={false} className="wb-handle is-quiet" />
    </div>
  );
});

export function ReferenceEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, target, selected, markerEnd }: EdgeProps<BoardEdge>) {
  const lineage = useLineage();
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const index = useReferences(target).findIndex((item) => item.edge.id === id);
  const lit = lineage?.links.has(id);
  const dim = lineage && !lit;
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className={cn('wb-edge', selected && 'is-selected', lit && 'is-lit', dim && 'is-dim')} interactionWidth={18} />
      {index >= 0 ? (
        <EdgeLabelRenderer>
          <span className={cn('wb-edge-order', selected && 'is-selected', dim && 'is-dim')} style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }} aria-hidden>{index + 1}</span>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export function ResultEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }: EdgeProps<BoardEdge>) {
  const lineage = useLineage();
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const lit = lineage?.links.has(id);
  return <BaseEdge id={id} path={path} className={cn('wb-edge is-result', lit && 'is-lit', lineage && !lit && 'is-dim')} />;
}

export const nodeTypes = { image: ImageNodeView, generate: GenerateNodeView };
export const edgeTypes = { reference: ReferenceEdgeView, result: ResultEdgeView };
