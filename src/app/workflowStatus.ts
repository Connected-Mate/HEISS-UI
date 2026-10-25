import type { WorkflowValidation } from './types';

/**
 * The one vocabulary for workflow health, used by the gallery, the detail
 * panel and the import review so the same state always reads the same way:
 * every problem reads "Needs setup" at a glance, and its detail says which.
 */
export type WorkflowState = 'ready' | 'unchecked' | 'missing-nodes' | 'needs-setup';

export function workflowState(validation?: WorkflowValidation, comfyRestarting = false): { state: WorkflowState; label: string; detail: string } {
  const missing = validation?.missingNodes?.length || 0;
  const files = validation?.missingFiles?.length || 0;
  const packs = validation?.missingPacks || [];
  if (validation && !validation.ok && validation.outdatedComfy) {
    return { state: 'missing-nodes', label: 'Needs setup', detail: 'It needs a newer ComfyUI. Update ComfyUI, then check again.' };
  }
  if (validation && !validation.ok && packs.length) {
    return { state: 'missing-nodes', label: 'Needs setup', detail: `It needs ${packs.join(' and ')}, which ComfyUI doesn’t include.` };
  }
  if (validation && !validation.ok && files) {
    return { state: 'needs-setup', label: 'Needs setup', detail: files === 1 ? 'A file it needs isn’t here yet.' : `${files} files it needs aren’t here yet.` };
  }
  if (validation && !validation.ok && missing) {
    return { state: 'missing-nodes', label: 'Needs setup', detail: missing === 1 ? 'It uses a node ComfyUI doesn’t have yet.' : `It uses ${missing} nodes ComfyUI doesn’t have yet.` };
  }
  if (validation && !validation.ok) {
    const missingFiles = (validation.issues || []).filter((issue) => /^Missing (diffusion model|checkpoint|text encoder|VAE|upscale model|file):/.test(issue)).length;
    if (missingFiles && missingFiles === validation.issues.length) {
      return { state: 'needs-setup', label: 'Needs setup', detail: 'Some files it needs aren’t in ComfyUI’s models folders yet. Add each one where it says, then check again.' };
    }
    return { state: 'needs-setup', label: 'Needs setup', detail: 'Something in the workflow needs fixing before it can run.' };
  }
  if (validation?.unverified) {
    return comfyRestarting
      ? { state: 'unchecked', label: 'Checking soon', detail: 'ComfyUI is restarting. Checked again when it’s back.' }
      : { state: 'unchecked', label: 'Not checked', detail: 'ComfyUI is offline, so its nodes can’t be checked yet.' };
  }
  return { state: 'ready', label: 'Ready', detail: 'Everything this workflow needs is installed.' };
}
