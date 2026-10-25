import { Zap } from 'lucide-react';
import { cn } from './format';
import { Switch } from './SettingsControls';
import { Tip } from './components';
import { rapidLabel, type RapidStatus } from './rapid.js';
import { requireHeissNodes } from './heissNodes';

/**
 * HEISS Rapid in the composer (docs/rapid.md): the switch, and why it is off
 * for the next run when it is. Hidden for models it isn't for, and where it has
 * nothing to speed up. Its two parts stay prefs for scripts; here it's one switch.
 */
type RapidView = {
  rapid: { use: boolean; guidance: boolean; status: RapidStatus };
  setPrefs: (next: { rapidAll: boolean; rapid?: boolean; rapidGuidance?: boolean }) => void;
  openSettings?: (section: 'features') => void;
};

const explainer = 'Makes pictures up to twice as fast, with the same look. A seed you type yourself runs without it, so it keeps giving the same picture.';

/** Rows only for models Rapid is for, and only while it has something to speed up. */
const hidden = (status: RapidStatus) => status === 'model' || status === 'idle';

/** The switch: on unless Rapid, or every part of it underneath, is switched off. */
const enabled = (rapid: RapidView['rapid']) => rapid.status !== 'off' && rapid.status !== 'parts';

/** Switching on brings back its parts too, so on always means on. */
const switchTo = (setPrefs: RapidView['setPrefs'], next: boolean) => setPrefs(next ? { rapidAll: true, rapid: true, rapidGuidance: true } : { rapidAll: false });

/** "Set up": the HEISS Nodes dialog installs the pack, then Rapid is on. */
const setUp = (setPrefs: RapidView['setPrefs']) => requireHeissNodes('rapid', () => switchTo(setPrefs, true));

export function SidebarRapidRow({ view }: { view: RapidView }) {
  const { rapid, setPrefs } = view;
  if (hidden(rapid.status)) return null;
  const label = rapidLabel(rapid.status);
  return (
    <div className={cn('rapid-row', rapid.status === 'on' && 'is-on')}>
      <Tip content={explainer}>
        <span className="rapid-row-copy" tabIndex={0} aria-label={`Rapid: ${label}. ${explainer}`}>
          <strong><Zap size={13} aria-hidden="true" /> Rapid</strong>
          <small>{label}</small>
        </span>
      </Tip>
      {rapid.status === 'install'
        ? <button type="button" className="btn is-ghost rapid-row-setup" onClick={() => setUp(setPrefs)}>Set up</button>
        : <Switch size="sm" label={`Rapid, ${label}`} checked={enabled(rapid)} onChange={(next) => switchTo(setPrefs, next)} />}
    </div>
  );
}

export function PhoneRapidRow({ view }: { view: RapidView }) {
  const { rapid, setPrefs } = view;
  if (hidden(rapid.status)) return null;
  if (rapid.status === 'install') {
    return (
      <div className="phone-group">
        <button type="button" className="phone-row" onClick={() => setUp(setPrefs)}>
          <Zap size={20} /><span>Rapid<small className="is-setup">Faster pictures · tap to set up</small></span>
        </button>
      </div>
    );
  }
  const on = enabled(rapid);
  return (
    <div className="phone-group">
      <button type="button" role="switch" aria-checked={on} className="phone-row" onClick={() => switchTo(setPrefs, !on)}>
        <Zap size={20} /><span>Rapid<small>{rapidLabel(rapid.status)}</small></span>
        <span className={cn('phone-switch', on && 'is-on')} aria-hidden="true"><i /></span>
      </button>
    </div>
  );
}
