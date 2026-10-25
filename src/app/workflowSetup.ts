import { useEffect, useSyncExternalStore } from 'react';
import { apiJson } from './api';
import type { ShowToast } from './toast';
import type { WorkflowSetupState } from './types';

/**
 * An imported workflow's add-on setup (server/workflow-setup.js), followed
 * from anywhere in the app: it runs on after the Workflows window closes, so
 * the news that it finished, or that it broke something, can't depend on that
 * window being open. The window shows the same state as its strip.
 */
let store: WorkflowSetupState | null = null;
const listeners = new Set<() => void>();

export function setWorkflowSetup(next: WorkflowSetupState | null) {
  store = next;
  for (const listener of listeners) listener();
}

export function useWorkflowSetup() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => store);
}

/** How it ended has been seen (OK, Keep it anyway, Undo): no window or reload brings it back. */
export function dismissWorkflowSetup() {
  const id = store?.id || '';
  setWorkflowSetup(null);
  apiJson('/api/workflows/setup/seen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }).catch(() => undefined);
}

/** What news an ended setup still owes: a finished one says itself once, the rest wait to be seen. */
const pending = (setup: WorkflowSetupState | null) => Boolean(setup && setup.status !== 'done' && setup.status !== 'undone' && !setup.seen);

/**
 * Mounted once, on the computer running HEISS: picks up a setup already under
 * way (or one that ended badly while nobody looked), follows it while it runs,
 * and says how it ended: "ready" quietly, anything else with a way to it.
 */
export function useWorkflowSetupWatch({ enabled, showToast, onSettled, onReview }: { enabled: boolean; showToast: ShowToast; onSettled: () => void; onReview: () => void }) {
  const setup = useWorkflowSetup();
  const running = setup?.status === 'running';
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer = 0;
    const poll = async () => {
      const data = await apiJson<{ setup: WorkflowSetupState | null }>('/api/workflows/setup').catch(() => null);
      if (!alive) return;
      const next = data?.setup || null;
      const was = store;
      if (was?.status === 'running' && next && next.status !== 'running') {
        onSettled();
        if (next.status === 'done') {
          showToast(`${next.workflowName || 'Your workflow'} is ready`, 'success', { group: 'workflow-setup' });
          dismissWorkflowSetup();
          return;
        }
        showToast(next.status === 'needs-restart' ? 'Restart ComfyUI to finish setting up' : `${next.workflowName || 'A workflow'}’s setup needs a look`, next.status === 'needs-restart' ? 'warning' : 'error', { group: 'workflow-setup', duration: Infinity, action: { label: 'Review', onClick: onReview } });
      }
      setWorkflowSetup(next?.status === 'running' || pending(next) ? next : null);
      if (next?.status === 'running') timer = window.setTimeout(poll, 1500);
    };
    poll();
    return () => { alive = false; window.clearTimeout(timer); };
    // A setup started here flips `running`, which starts following it.
  }, [enabled, running]);
}
