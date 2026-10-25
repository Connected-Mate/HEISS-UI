import React, { useEffect, useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { Modal } from './Modal';
import { EmberGlyph, EnhanceAura, EnhanceWords, useEnhanceDemo } from './EnhanceComposer';
import { NodeInstall } from './NodeInstall';
import { ComfyRestart } from './ComfyRestart';
import { CellBar, Watcher } from './UpscaleDialogs';
import { useThisComputer } from './device';
import { cn } from './format';
import { loadHeissNodes, useHeissNodes } from './heissNodes';
import { closeEnhanceSetup, loadEnhanceStatus, saveEnhanceSettings, useEnhance, type EnhanceChoice, type EnhanceStatus } from './promptEnhance';
import { downloadFor, useModelDownloads } from './useModelDownloads';
import { formatBytes } from './useUpscale';
import type { ShowToast } from './toast';

/**
 * Setting up prompt enhance, start to finish in one place: HEISS UI Nodes 8
 * (the node that runs the model and streams its words), then one local
 * vision model, then it is ready, and whatever was waiting runs. The hero
 * shows what it does while the rest happens.
 */
type Stage = 'checking' | 'offline' | 'nodes' | 'restart' | 'model' | 'downloading' | 'ready';

const STEPS = [
  { label: 'Nodes', stages: ['checking', 'offline', 'nodes', 'restart'] },
  { label: 'Model', stages: ['model', 'downloading'] },
  { label: 'Ready', stages: [] as string[] }
];

function stageOf(status: EnhanceStatus | null, offline: boolean, downloading: boolean): Stage {
  if (!status) return offline ? 'offline' : 'checking';
  if (status.ready) return 'ready';
  if (!status.nodes.ready) return status.nodes.state === 'restart' ? 'restart' : 'nodes';
  return downloading ? 'downloading' : 'model';
}

function Steps({ stage }: { stage: Stage }) {
  const current = stage === 'ready' ? STEPS.length : STEPS.findIndex((step) => step.stages.includes(stage));
  return (
    <ol className="upscale-stepper" aria-label="Setup steps">
      {STEPS.map((step, index) => {
        const state = index < current ? 'done' : index === current ? 'active' : 'todo';
        return (
          <li key={step.label} className={`is-${state}`} aria-current={state === 'active' ? 'step' : undefined}>
            <i aria-hidden="true">{state === 'done' ? <Check size={10} strokeWidth={3} /> : null}</i>
            <span>{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

const DEMO_IDEA = 'a fox in the snow at dusk';
const DEMO_PROMPT = 'A red fox stands alert in deep fresh snow at the edge of a pine forest, amber eyes fixed past the camera, frost catching in its fur. Low sun from the left rims its coat in gold while the snow falls blue into shadow. Medium shot at eye level, 85mm lens, shallow depth of field; quiet, cold, 35mm film photograph.';

/** The feature, shown: a few words, the fuse going round, and the prompt they become, again and again. */
function EnhanceHero({ stage }: { stage: Stage }) {
  const words = DEMO_PROMPT.split(' ');
  const shown = useEnhanceDemo(words.length);
  const writing = shown > 0 && shown < words.length;
  return (
    <div className="upscale-hero-wrap enhance-hero" data-stage={stage} aria-hidden="true">
      <div className={cn('enhance-hero-card', writing && 'is-writing', shown === 0 && 'is-idea')}>
        {writing ? <EnhanceAura phase="writing" pulse={shown} idle="fuse" /> : null}
        <p>
          {shown === 0
            ? <span className="enhance-hero-idea">{DEMO_IDEA}</span>
            : <EnhanceWords text={words.slice(0, shown).join(' ')} cursor={writing} />}
        </p>
        <span className="enhance-hero-spark"><EmberGlyph size={13} lit={writing} /></span>
      </div>
      <Steps stage={stage} />
    </div>
  );
}

function copyFor(stage: Stage, nodeState: string) {
  switch (stage) {
    case 'checking': return { title: 'Prompt enhance', description: 'Checking ComfyUI…' };
    case 'offline': return { title: 'Waiting for ComfyUI', description: 'Start ComfyUI, and this carries on by itself.' };
    case 'nodes': return {
      title: 'Write prompts like a pro, on this computer',
      description: `A few words become the prompt your model wants. A picture becomes a prompt. A start frame gets its motion. It runs privately in ComfyUI, uncensored, with nothing sent anywhere. ${nodeState === 'failed' ? 'First, a repair: ComfyUI couldn’t load the small add-on it runs on.' : `First, ${nodeState === 'update' ? 'an update to' : 'the small add-on for'} ComfyUI it runs on.`}`
    };
    case 'restart': return { title: 'Restart ComfyUI to continue', description: 'The new HEISS UI Nodes are in place. ComfyUI loads them when it restarts.' };
    case 'model': return { title: 'Choose the model that writes', description: 'A vision model that reads your words and pictures. It runs inside ComfyUI and makes room for your image models by itself.' };
    case 'downloading': return { title: 'Downloading the model', description: 'A one-time download. It carries on if you close this.' };
    case 'ready': return { title: 'Prompt enhance is ready', description: 'Press the flame in the prompt bar, or Ctrl+E while you type. Undo is one click away.' };
  }
}

function ModelChoice({ choice, picked, recommended, onPick, disabled }: { choice: EnhanceChoice; picked: boolean; recommended: boolean; onPick: () => void; disabled: boolean }) {
  return (
    <li className={cn('enhance-choice', picked && 'is-picked')}>
      <button type="button" role="radio" aria-checked={picked} onClick={onPick} disabled={disabled}>
        <i aria-hidden="true">{picked ? <Check size={10} strokeWidth={3} /> : null}</i>
        <div>
          <strong>{choice.label}{recommended ? <em>Recommended</em> : null}</strong>
          <span>{choice.note}</span>
        </div>
        <small>{choice.onDisk ? 'Downloaded' : formatBytes(choice.bytes)}</small>
      </button>
    </li>
  );
}

export function EnhanceSetupDialog({ showToast }: { showToast: ShowToast }) {
  const { status, offline, setup } = useEnhance();
  const nodes = useHeissNodes();
  const admin = useThisComputer();
  const open = Boolean(setup);
  const downloads = useModelDownloads({
    onDone: (item) => { if (item.id.startsWith('enhancer:')) loadEnhanceStatus({ fresh: true }); },
    onError: (item) => { if (item.id.startsWith('enhancer:')) showToast(item.error || 'The model download stopped.', 'error'); }
  });
  const [pick, setPick] = useState('');
  const choices = status?.choices || [];
  const chosen = choices.find((choice) => choice.id === pick) || choices[0];
  const active = choices.map((choice) => downloadFor(downloads.state, choice.file)).find((item) => item && (item.status === 'downloading' || item.status === 'queued'));
  const stage = stageOf(status, offline, Boolean(active));
  const { title, description } = copyFor(stage, status?.nodes.state || '');

  // While open and not ready: look again every few seconds (an install, a restart, a download landing).
  useEffect(() => {
    if (!open || stage === 'ready') return;
    if (stage === 'nodes' || stage === 'restart') loadHeissNodes({ fresh: true });
    const timer = window.setInterval(() => {
      loadEnhanceStatus({ fresh: stage !== 'downloading' });
      if (stage === 'nodes' || stage === 'restart') loadHeissNodes();
    }, stage === 'downloading' ? 5000 : 3000);
    return () => window.clearInterval(timer);
  }, [open, stage]);

  const download = async () => {
    if (!chosen) return;
    try {
      await downloads.start(chosen.id, { kind: 'setup', subject: 'Prompt enhance' });
      // The model to use from now on, whichever builds are on disk.
      await saveEnhanceSettings({ model: chosen.file }).catch(() => null);
      loadEnhanceStatus({ fresh: true });
    } catch (error) {
      showToast((error as Error).message || 'The download didn’t start.', 'error');
    }
  };

  let body: React.ReactNode = null;
  let footer: React.ReactNode = (
    <>
      <button className="btn is-ghost" onClick={() => closeEnhanceSetup()}>Not now</button>
      <button className="btn" onClick={() => loadEnhanceStatus({ fresh: true })}><RefreshCw size={13} /> Check again</button>
    </>
  );
  if (stage === 'checking') {
    body = <Watcher>Checking ComfyUI…</Watcher>;
  } else if (stage === 'offline') {
    body = <Watcher>Waiting for ComfyUI</Watcher>;
  } else if (stage === 'nodes') {
    body = nodes.status?.setup ? (
      <NodeInstall
        pack={nodes.status.setup.pack}
        plan={nodes.status.setup}
        managerHint={nodes.status.setup.manager}
        autoInstall={nodes.status.setup.autoInstall}
        showToast={showToast}
        onRestarted={() => { loadHeissNodes({ fresh: true }); loadEnhanceStatus({ fresh: true }); }}
        afterRestart="Then choose the model."
        verb={status?.nodes.state === 'failed' ? 'Repair' : status?.nodes.state === 'update' ? 'Update' : 'Install'}
        resumeFinished={false}
      />
    ) : <Watcher>Checking HEISS UI Nodes…</Watcher>;
  } else if (stage === 'restart') {
    body = (
      <>
        <ComfyRestart className="upscale-restart" onBack={() => loadEnhanceStatus({ fresh: true })} />
        <Watcher>Waiting for ComfyUI to load the new nodes…</Watcher>
      </>
    );
  } else if (stage === 'model') {
    body = (
      <ul className="enhance-choices" role="radiogroup" aria-label="Model">
        {choices.map((choice, index) => (
          <ModelChoice key={choice.id} choice={choice} picked={choice.id === chosen?.id} recommended={index === 0} onPick={() => setPick(choice.id)} disabled={!admin} />
        ))}
      </ul>
    );
    footer = (
      <>
        <button className="btn is-ghost" onClick={() => closeEnhanceSetup()}>Not now</button>
        {admin
          ? <button className="btn is-primary" onClick={download} disabled={!chosen}>{chosen?.onDisk ? 'Use it' : `Download ${formatBytes(chosen?.bytes)}`}</button>
          : <span className="upscale-fine">Download it on the computer running HEISS UI.</span>}
      </>
    );
  } else if (stage === 'downloading' && active) {
    const total = active.totalBytes || chosen?.bytes || 0;
    const speed = active.bytesPerSecond ? `${formatBytes(active.bytesPerSecond)}/s` : '';
    body = (
      <ul className="upscale-files is-live">
        <li>
          <div>
            <strong>{choices.find((choice) => choice.file === active.file)?.label || active.label}<em>{active.status === 'queued' ? 'Waiting' : active.verifying ? 'Checking the file' : speed}</em></strong>
            <CellBar value={total ? active.receivedBytes / total : 0} />
          </div>
          <span>{formatBytes(active.receivedBytes)} of {formatBytes(total)}</span>
        </li>
      </ul>
    );
    footer = <button className="btn" onClick={() => closeEnhanceSetup()}>Close</button>;
  } else if (stage === 'ready') {
    footer = setup?.then
      ? <button className="btn is-primary" onClick={() => closeEnhanceSetup({ run: true })}><EmberGlyph size={13} /> Enhance my prompt</button>
      : <button className="btn is-primary" onClick={() => closeEnhanceSetup()}>Done</button>;
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => { if (!next) closeEnhanceSetup(); }}
      size="form"
      className="upscale-modal enhance-setup-modal"
      hero={<EnhanceHero stage={stage} />}
      title={title}
      description={description}
      footer={footer}
    >
      <div className="upscale-body" key={stage}>{body}</div>
    </Modal>
  );
}
