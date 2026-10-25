import { useSyncExternalStore } from 'react';
import { apiFetch, apiJson } from './api';
import type { HeissNodesState } from './heissNodes';

/**
 * Prompt enhance (server/prompt-enhance.js): a local vision LLM, running in
 * ComfyUI, turns a few words into the prompt the selected model wants, reads
 * a picture into one, or writes the motion for an image-to-video start frame.
 * This holds whether it is set up, opens setup when it isn't, and streams one
 * enhancement.
 */

export type EnhanceTarget = 'image' | 'tags' | 'describe' | 'tags-describe' | 'edit' | 'video' | 'motion';

export type EnhanceChoice = { id: string; file: string; label: string; note: string; bytes: number; listed: boolean; onDisk: boolean };
export type EnhanceSettings = { model: string; instructions: string; creativity: number };
export type EnhanceStatus = {
  ready: boolean;
  nodes: { state: HeissNodesState; ready: boolean };
  model: string;
  choices: EnhanceChoice[];
  settings: EnhanceSettings;
};

type Store = { status: EnhanceStatus | null; offline: boolean; setup: { then?: () => void } | null };
let store: Store = { status: null, offline: false, setup: null };
const listeners = new Set<() => void>();

function set(patch: Partial<Store>) {
  store = { ...store, ...patch };
  listeners.forEach((listener) => listener());
}

export async function loadEnhanceStatus({ fresh = false } = {}) {
  try {
    const status = await apiJson<EnhanceStatus>(`/api/enhance/status${fresh ? '?fresh=1' : ''}`);
    set({ status, offline: false });
    return status;
  } catch {
    set({ offline: true });
    return null;
  }
}

export function useEnhance() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => store);
}

/** Runs `then` when enhance is ready (checked afresh), else opens setup, which runs it once ready. */
export async function requireEnhance(then?: () => void) {
  const status = store.status?.ready ? store.status : await loadEnhanceStatus({ fresh: true });
  if (status?.ready) {
    then?.();
    return true;
  }
  set({ setup: { then } });
  return false;
}

export function openEnhanceSetup() {
  set({ setup: {} });
  loadEnhanceStatus({ fresh: true });
}

export function closeEnhanceSetup({ run = false } = {}) {
  const then = store.setup?.then;
  set({ setup: null });
  if (run) then?.();
}

export async function saveEnhanceSettings(patch: Partial<EnhanceSettings>) {
  const { settings } = await apiJson<{ settings: EnhanceSettings }>('/api/enhance/settings', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch)
  });
  if (store.status) set({ status: { ...store.status, settings } });
  loadEnhanceStatus();
  return settings;
}

export type EnhanceRequest = { prompt: string; kind: 'image' | 'video'; family: string; variant: string; editing: boolean; image?: { assetId: string } | null; again?: boolean };

/**
 * What a run should take, learned on the server (enhance-timing.js), sent when
 * ComfyUI starts it: until the first words, and from them to the last.
 */
export type EnhanceExpectation = { situation: 'cold' | 'warm' | 'after-render' | 'idle'; startMs: number; writeMs: number; words: number; learned: boolean };

export type EnhanceEvent =
  | { type: 'start'; target: EnhanceTarget }
  | { type: 'queued' } | { type: 'loading'; expect?: EnhanceExpectation }
  | { type: 'text'; text: string } | { type: 'done'; text: string }
  | { type: 'error'; error: string };

/**
 * One enhancement, its events handed to `onEvent` as the server sends them.
 * Resolves with the finished prompt; throws with a readable message. Aborting
 * `signal` stops the run in ComfyUI too.
 */
export async function streamEnhance(request: EnhanceRequest, onEvent: (event: EnhanceEvent) => void, signal?: AbortSignal) {
  const response = await apiFetch('/api/enhance', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal
  }).catch((error) => {
    if (error?.name === 'AbortError') throw error;
    throw new Error('Can’t reach HEISS UI. Make sure it’s running, then try again.');
  });
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    // Set up elsewhere since this page last looked, or taken down: ask again next time.
    if (data?.reason === 'setup') loadEnhanceStatus({ fresh: true });
    throw Object.assign(new Error(typeof data?.error === 'string' ? data.error : 'Prompt enhance failed.'), { reason: data?.reason || '' });
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let finished = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const line = chunk.split('\n').find((item) => item.startsWith('data: '));
      if (!line) continue;
      let event: EnhanceEvent;
      try { event = JSON.parse(line.slice(6)); } catch { continue; }
      if (event.type === 'error') throw new Error(event.error);
      if (event.type === 'done') finished = event.text;
      onEvent(event);
    }
  }
  if (!finished) throw new Error('Prompt enhance stopped before it finished.');
  return finished;
}

/** What the button does right now, in words, from what the composer holds. */
export function enhanceVerb({ kind, hasImage, hasText, editing }: { kind: 'image' | 'video'; hasImage: boolean; hasText: boolean; editing: boolean }) {
  if (kind === 'video') return hasImage ? (hasText ? 'Write the motion' : 'Imagine the motion') : 'Enhance prompt';
  if (hasImage && !hasText) return 'Describe the picture';
  if (hasImage && editing) return 'Sharpen the edit';
  return 'Enhance prompt';
}

/** While it works: what it is doing, for the line under the prompt. */
export function enhanceWorking(target: EnhanceTarget | '', phase: 'queued' | 'loading' | 'writing') {
  if (phase === 'queued') return 'Waiting for the current render';
  const reading = target === 'describe' || target === 'tags-describe' || target === 'motion' || target === 'edit';
  if (phase === 'loading') return reading ? 'Looking at your picture' : 'Thinking';
  return target === 'motion' ? 'Writing the motion' : target === 'tags' || target === 'tags-describe' ? 'Writing tags' : 'Writing';
}
