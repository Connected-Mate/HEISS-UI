// HEISS Rapid in the composer (docs/rapid.md): what the next run asks for, and
// what the composer says about it. Rapid is two parts, switched on and off on
// their own: the half-size start (HeissRapid) and Rapid Guidance
// (HeissRapidGuidance: CFG only while the noise is high). Plain JavaScript so
// `node --test` can check it without a build step; types in rapid.d.ts.
//
// Both change how a seed comes out, so a fixed seed and Rapid only go together
// when the seed came from a picture made with Rapid ("Use settings"): then the
// same picture comes back. A seed you typed, or one from a picture made
// without Rapid, makes the run without it. A random seed always gets it.

/**
 * @param {{ capabilities?: Record<string, boolean> } | null | undefined} profile
 * @param {{ rapidAll?: boolean, rapid?: boolean, rapidGuidance?: boolean }} prefs (rapidAll: the whole of Rapid)
 * @param {string} seed the composer's seed ("" is random)
 * @param {string} rapidSeed the seed "Use settings" restored from a Rapid picture, or ""
 * @param {{ kind?: string, startImage?: boolean, inpaint?: boolean, cfg?: number }} [run]
 * @returns {{ use: boolean, guidance: boolean, status: string }}
 */
export function rapidState(profile, prefs, seed, rapidSeed, run = {}) {
  const capabilities = profile?.capabilities || {};
  const off = (status) => ({ use: false, guidance: false, status });
  if (run.kind === "video" || (!capabilities.rapid && !capabilities.rapidGuidance && !capabilities.rapidInstall)) return off("model");
  if (!capabilities.rapid && !capabilities.rapidGuidance) return off("install");
  if (prefs?.rapidAll === false) return off("off");
  const startOn = Boolean(capabilities.rapid) && prefs?.rapid !== false;
  const guidanceOn = Boolean(capabilities.rapidGuidance) && prefs?.rapidGuidance !== false;
  if (!startOn && !guidanceOn) return off("parts");
  const fixed = String(seed || "").trim();
  if (fixed && fixed !== String(rapidSeed || "").trim()) return off("seed");
  // A start picture or a mask sets the layout itself; guidance only saves where there is CFG to save.
  const use = startOn && !run.startImage && !run.inpaint;
  // Guidance too only from noise: a low-strength start image would begin below its cut-off.
  const guidance = guidanceOn && Number(run.cfg ?? 2) > 1 && !run.startImage && !run.inpaint;
  if (use || guidance) return { use, guidance, status: "on" };
  if ((startOn || guidanceOn) && (run.startImage || run.inpaint)) return off("image");
  // What's left is guidance at CFG 1: say so, unless the half-size start would have applied but is switched off.
  return off(capabilities.rapid && prefs?.rapid === false && !run.startImage && !run.inpaint ? "parts" : "idle");
}

/** The composer's word for it: what Rapid does, or why it isn't doing it for the next run. */
export function rapidLabel(status) {
  return {
    on: "Up to twice as fast",
    off: "Off",
    // Its parts are switched off underneath (scripts and old settings): to the composer that's just off.
    parts: "Off",
    seed: "Paused for a fixed seed",
    image: "Not used with a start image",
    idle: "",
    install: "Faster pictures",
    model: ""
  }[status] || "";
}

/** The seed "Use settings" should remember for Rapid: the picture's own, when Rapid made it. */
export function rapidSeedFrom(settings, { vary = false } = {}) {
  if (vary || !(settings?.rapid || settings?.rapidGuidance)) return "";
  const seed = String(settings.seed || "").trim();
  return /^\d+$/.test(seed) ? seed : "";
}

const SPEED_LABELS = { careful: "Careful", faster: "Faster" };

// The node's own reasons for skipping (heiss_rapid.py), in a few words.
const SKIP_WORDS = [
  [/mask|inpaint|full-size image/, "inpainting"],
  [/starts at noise|image to image|upscale/, "start image"],
  [/too few steps/, "too few steps"],
  [/too small/, "picture too small"]
];

/**
 * The details panel's Rapid row: whether it helped make this picture, in one
 * line ("" when Rapid had no part in it). How it ran stays in the settings.
 * @param {Record<string, unknown> | null | undefined} settings the picture's recorded settings
 * @returns {string}
 */
export function rapidSummary(settings) {
  const s = settings || {};
  if ((s.rapid && !s.rapidSkipped) || s.rapidGuidance) return `On · ${SPEED_LABELS[String(s.rapidSpeed)] || "Balanced"}`;
  if (s.rapidSkipped) {
    const reason = String(s.rapidSkipped);
    return `Not used: ${SKIP_WORDS.find(([pattern]) => pattern.test(reason))?.[1] || "not for this run"}`;
  }
  return "";
}
