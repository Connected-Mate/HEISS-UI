import React, { useEffect, useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { Modal } from './Modal';
import { NodeInstall } from './NodeInstall';
import { ComfyRestart } from './ComfyRestart';
import { HeatMark } from './HeatMark';
import { Watcher } from './UpscaleDialogs';
import { cn } from './format';
import { closeHeissNodes, featureReady, finishHeissNodesRequest, loadHeissNodes, openHeissNodes, useHeissNodes, type HeissNodesFeature, type HeissNodesStatus } from './heissNodes';
import { useRtxOffered } from './rtx';
import type { ShowToast } from './toast';

/**
 * HEISS UI Nodes, installed or brought up to date in one place (heissNodes.ts):
 * opened the first time someone touches a feature that runs on the pack, and
 * again when this HEISS needs a newer pack than ComfyUI has. One install
 * brings every feature, so it's asked for once. While open it keeps checking,
 * so an install done by hand, in Manager or on another computer is noticed.
 * Mounted all the time, it also says once when HEISS updated the pack by
 * itself (a restart finishes it) or when ComfyUI couldn't load it.
 */
const STEPS = ['Install', 'Restart', 'Ready'] as const;

type Stage = 'checking' | 'offline' | 'install' | 'update' | 'failed' | 'restart' | 'ready';

function stageOf(status: HeissNodesStatus | null, offline: boolean, feature: string): Stage {
  if (!status) return offline ? 'offline' : 'checking';
  if (feature ? featureReady(status, feature) : status.state === 'ready') return 'ready';
  return status.state === 'ready' ? 'update' : status.state;
}

function Steps({ stage, first }: { stage: Stage; first: 'Install' | 'Update' | 'Repair' }) {
  const current = stage === 'ready' ? 3 : stage === 'restart' ? 1 : 0;
  return (
    <ol className="upscale-stepper" aria-label="Setup steps">
      {STEPS.map((step, index) => {
        const state = index < current ? 'done' : index === current ? 'active' : 'todo';
        return (
          <li key={step} className={`is-${state}`} aria-current={state === 'active' ? 'step' : undefined}>
            <i aria-hidden="true">{state === 'done' ? <Check size={10} strokeWidth={3} /> : null}</i>
            <span>{index === 0 ? first : step}</span>
          </li>
        );
      })}
    </ol>
  );
}

function copyFor(stage: Stage, feature: HeissNodesFeature | undefined, status: HeissNodesStatus | null) {
  const name = feature?.label || '';
  switch (stage) {
    case 'checking': return { title: 'HEISS UI Nodes', description: 'Checking ComfyUI…' };
    case 'offline': return { title: 'Waiting for ComfyUI', description: 'Start ComfyUI, and this carries on by itself.' };
    case 'install': return {
      title: name ? `${name} needs HEISS UI Nodes` : 'Add HEISS UI Nodes to ComfyUI',
      description: 'HEISS’s own small add-on for ComfyUI. Install it once and every feature below works, now and as new ones arrive.'
    };
    case 'update': return {
      title: 'Update HEISS UI Nodes',
      description: `${name ? `${name} needs` : 'This HEISS needs'} a newer version. Everything you use now keeps working.`
    };
    case 'failed': return {
      title: 'HEISS UI Nodes didn’t load',
      description: `${status?.failure?.reason || 'ComfyUI couldn’t load them when it started.'} Repair puts them right, then ComfyUI restarts to load them.`
    };
    case 'restart': return status?.autoUpdated
      ? { title: 'Restart ComfyUI to finish', description: 'HEISS updated its nodes in the background. ComfyUI loads them the next time it starts; until then everything works as before.' }
      : { title: 'Restart ComfyUI to finish', description: 'The new HEISS UI Nodes are in place. ComfyUI loads them when it restarts.' };
    case 'ready': return { title: name ? `${name} is ready` : 'HEISS UI Nodes are ready', description: 'Everything below runs on this ComfyUI now.' };
  }
}

/** Said once, outside the dialog: an update HEISS made by itself, or a pack ComfyUI couldn't load. */
const told = new Set<string>();
function tellOnce(key: string) {
  if (told.has(key)) return false;
  told.add(key);
  try {
    if (window.localStorage.getItem(key)) return false;
    window.localStorage.setItem(key, '1');
  } catch { /* private window: once per visit is enough */ }
  return true;
}

export function HeissNodesDialog({ showToast }: { showToast: ShowToast }) {
  const { status, offline, checkedAt, request } = useHeissNodes();
  const nvidia = useRtxOffered();
  const open = Boolean(request);
  const featureId = request?.feature || '';
  const stage = stageOf(status, offline, featureId);
  const feature = status?.features.find((item) => item.id === featureId);
  const [held, setHeld] = useState(false);
  // Install, update or repair, as it was when the dialog opened: the first step keeps its word through restart and ready.
  const [first, setFirst] = useState<'Install' | 'Update' | 'Repair'>('Install');
  useEffect(() => {
    if (!open) { setFirst('Install'); return; }
    if (stage === 'update' || (stage === 'restart' && status?.autoUpdated)) setFirst('Update');
    if (stage === 'failed') setFirst('Repair');
  }, [open, stage, status?.autoUpdated]);

  // Closed, it still looks now and then: a background update or a failed load is worth one quiet word.
  useEffect(() => {
    loadHeissNodes();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') loadHeissNodes(); }, 5 * 60_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (open || !status) return;
    if (status.autoUpdated && status.state === 'restart' && tellOnce(`heiss-nodes:updated:${status.requiredVersion}`)) {
      showToast('HEISS UI Nodes updated', 'success', {
        description: 'They load the next time ComfyUI restarts. Everything works as before until then.',
        action: { label: 'Restart…', onClick: () => openHeissNodes() },
        duration: 12_000
      });
    } else if (status.state === 'failed' && status.failure && tellOnce(`heiss-nodes:failed:${status.failure.error}`)) {
      showToast('HEISS UI Nodes didn’t load', 'warning', {
        description: status.failure.reason,
        action: { label: 'Repair…', onClick: () => openHeissNodes() },
        duration: 12_000
      });
    }
  }, [open, status, showToast]);

  // While open and not ready: look again every few seconds (an install by hand, a restart elsewhere).
  useEffect(() => {
    if (!open || stage === 'ready') return;
    const timer = window.setInterval(() => loadHeissNodes(), 4000);
    return () => window.clearInterval(timer);
  }, [open, stage]);

  // Ready for what was waiting: hold the moment for a beat, then carry on with it.
  useEffect(() => {
    if (!open || stage !== 'ready' || !request?.then || held) return;
    setHeld(true);
    const timer = window.setTimeout(() => { setHeld(false); finishHeissNodesRequest(); }, 1300);
    return () => window.clearTimeout(timer);
  }, [open, stage, request, held]);

  const { title, description } = copyFor(stage, feature, status);
  // NVIDIA-only features show only where they can run; the one that opened this always shows.
  const features = (status?.features || []).filter((item) => !item.nvidia || nvidia || item.id === featureId);
  const newer = (item: HeissNodesFeature) => stage === 'update' && item.version > (status?.loadedVersion || 0);
  const pending = stage === 'restart' ? 'After restart' : stage === 'failed' ? 'After repair' : stage === 'update' ? 'With the update' : 'With the install';
  const later = <button className="btn is-ghost" onClick={closeHeissNodes}>Not now</button>;
  const recheck = <button className="btn" onClick={() => loadHeissNodes({ fresh: true })}><RefreshCw size={13} /> Check again</button>;

  let action: React.ReactNode = null;
  let footer: React.ReactNode = <>{later}{recheck}</>;
  if (stage === 'checking') {
    action = <Watcher>Checking ComfyUI…</Watcher>;
    footer = later;
  } else if (stage === 'offline') {
    action = <Watcher lastChecked={checkedAt}>Waiting for ComfyUI</Watcher>;
  } else if ((stage === 'install' || stage === 'update' || stage === 'failed') && status?.setup) {
    action = (
      <>
        <NodeInstall
          pack={status.setup.pack}
          plan={status.setup}
          managerHint={status.setup.manager}
          autoInstall={status.setup.autoInstall}
          showToast={showToast}
          onRestarted={() => loadHeissNodes({ fresh: true })}
          afterRestart={feature ? `Then ${feature.label} is ready.` : ''}
          verb={stage === 'failed' ? 'Repair' : stage === 'update' ? 'Update' : 'Install'}
          resumeFinished={false}
        />
        {status.local?.present && !status.local.git && stage === 'update'
          ? <p className="upscale-fine">The copy in ComfyUI wasn’t installed with git, so it’s set aside (renamed, not deleted) and the new one installed in its place.</p>
          : null}
        {status.local?.others && stage !== 'install'
          ? <p className="upscale-fine">There’s more than one copy in ComfyUI’s custom_nodes. The extra ones are set aside (renamed, not deleted), so only one loads.</p>
          : null}
        {stage === 'failed' && status.failure?.error
          ? <details className="upscale-fine"><summary>What ComfyUI said</summary><code>{status.failure.error}</code></details>
          : null}
      </>
    );
  } else if (stage === 'restart') {
    action = (
      <>
        <ComfyRestart className="upscale-restart" onBack={() => loadHeissNodes({ fresh: true })} />
        <Watcher lastChecked={checkedAt}>Waiting for ComfyUI to load the new nodes…</Watcher>
      </>
    );
  } else if (stage === 'ready') {
    footer = request?.then ? null : <button className="btn is-primary" onClick={closeHeissNodes}>Done</button>;
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => { if (!next) closeHeissNodes(); }}
      size="form"
      className="upscale-modal heiss-nodes-modal"
      hero={
        <div className="upscale-hero-wrap heiss-nodes-hero" data-stage={stage}>
          <HeatMark className="heiss-nodes-mark" />
          <Steps stage={stage} first={first} />
        </div>
      }
      title={title}
      description={description}
      footer={footer}
    >
      <div className="upscale-body" key={stage}>
        {features.length ? (
          <ul className="upscale-files heiss-nodes-features" aria-label="What HEISS UI Nodes bring">
            {features.map((item) => (
              <li key={item.id} className={cn(item.ready && 'is-done', item.id === featureId && 'is-asked')}>
                <div>
                  <strong>{item.label}{item.nvidia ? <em>NVIDIA RTX</em> : null}</strong>
                  <span className="heiss-nodes-blurb">{item.blurb}</span>
                </div>
                <span>{item.ready ? <><Check size={12} strokeWidth={3} /> Ready</> : newer(item) ? 'New' : pending}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {action ? <div className="heiss-nodes-action">{action}</div> : null}
        {stage === 'install' || stage === 'update'
          ? <p className="upscale-fine">{stage === 'update' && status?.loadedVersion ? `Version ${status.loadedVersion} → ${status.requiredVersion}. ` : ''}A few hundred KB, at the version this HEISS was made for. It never changes ComfyUI’s PyTorch.</p>
          : null}
      </div>
    </Modal>
  );
}
