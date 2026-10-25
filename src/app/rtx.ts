import { useEffect, useSyncExternalStore } from 'react';
import { apiJson } from './api';
import { requireHeissNodes } from './heissNodes';
import type { AutoUpscale, NodePackInfo, PackAutoInstall, ShellPlan } from './types';

/**
 * RTX video upscaling (docs/rtx-video.md, server/rtx.js): whether this machine
 * has it, shared by every place that shows it. Asked once per page; settings
 * and setup ask again. On anything but an NVIDIA card `offered` stays false
 * and nothing anywhere mentions it.
 */
export type RtxStage = 'unsupported' | 'nodes' | 'checking' | 'package' | 'restart' | 'error' | 'ready';

export type RtxStatus = {
  offered: boolean;
  ready: boolean;
  stage: RtxStage;
  reason: string;
  nodesInstalled: boolean;
  packageInstalled: boolean;
  frameGeneration: boolean;
  device: { name: string; capability: number[]; vram: number } | null;
  torch: string;
  cuda: string;
  /** The install for the missing part (nodes, or NVIDIA's package), the same panel every pack gets. */
  setup?: ShellPlan & { pack: NodePackInfo; manager?: boolean; autoInstall?: PackAutoInstall; exact?: boolean; cloned?: boolean; needsGit?: boolean; customNodesDir?: string; python?: string };
};

let current: RtxStatus | null = null;
let loading: Promise<RtxStatus | null> | null = null;
const listeners = new Set<() => void>();

function publish(next: RtxStatus | null) {
  current = next;
  listeners.forEach((listener) => listener());
}

export function loadRtxStatus({ fresh = false, probe = false } = {}): Promise<RtxStatus | null> {
  if (loading && !fresh && !probe) return loading;
  const query = [fresh ? 'fresh=1' : '', probe ? 'probe=1' : ''].filter(Boolean).join('&');
  loading = apiJson<RtxStatus>(`/api/rtx/status${query ? `?${query}` : ''}`)
    .then((status) => { publish(status); return status; })
    .catch(() => current)
    .finally(() => { loading = null; });
  return loading;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The latest answer, asked for on first use. */
export function useRtxStatus() {
  const status = useSyncExternalStore(subscribe, () => current, () => null);
  useEffect(() => {
    if (!current) loadRtxStatus();
  }, []);
  return status;
}

/** An NVIDIA card is there: videos get the upscale arrow and video models the 2K/4K tabs, set up or not. */
export function rtxOffered() {
  return Boolean(current?.offered);
}

export function useRtxOffered() {
  return Boolean(useRtxStatus()?.offered);
}

/** The size menu's tabs for video models: the same words as Smart upscale's for pictures. */
export const rtxVideoTiers: { value: AutoUpscale; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: '2k', label: '2K' },
  { value: '4k', label: '4K' }
];

/**
 * Picking a video tier, from the desktop size menu or the phone's size sheet:
 * on a ComfyUI without HEISS UI Nodes, the HEISS Nodes dialog first, then the tier is on.
 */
export async function chooseVideoTier(tier: AutoUpscale, setPrefs: (next: { videoUpscale: AutoUpscale }) => void) {
  if (tier === 'none') return setPrefs({ videoUpscale: tier });
  const rtx = await loadRtxStatus();
  if (rtx?.stage === 'nodes') return requireHeissNodes('rtx', () => setPrefs({ videoUpscale: tier }));
  setPrefs({ videoUpscale: tier });
}

/** One line on where setup stands, for Settings and a refused upscale. */
export function rtxStageLine(status: RtxStatus | null) {
  if (!status) return 'Checking…';
  switch (status.stage) {
    case 'ready': return status.frameGeneration ? 'Ready · upscaling and smoothing' : 'Ready · upscaling (smoothing needs an RTX 40-series or newer)';
    case 'nodes': return 'Needs the newest HEISS UI Nodes';
    case 'package': return 'Needs NVIDIA’s RTX video package (about 0.5 GB)';
    case 'restart': return status.reason || 'Restart ComfyUI, then update NVIDIA’s RTX video package';
    case 'checking': return 'ComfyUI didn’t answer the check';
    case 'error': return status.reason || 'Installed, but didn’t run';
    default: return status.reason;
  }
}
