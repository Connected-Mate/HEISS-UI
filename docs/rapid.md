# Rapid

Rapid makes a picture in roughly half the time on the models that support it, with the same VRAM. It works out the noisy first part of a run on a half-size latent, then switches to full size before any fine detail is drawn. It's based on SPEED ("Spectral Progressive Diffusion for Efficient Image and Video Generation", Xiao, Chao, Yariv and Wetzstein, 2026). Branch: `feature/rapid`.

## What it does

In a run, the noise level falls from 1 (pure noise) to 0 (the finished picture).

- **Early steps:** while the picture is mostly noise, they only settle layout, pose, light and colour. Full resolution adds nothing yet, so Rapid samples those steps on a latent half as wide and half as tall. That's about a quarter of the work per step, and attention cost falls even more.
- **The switch:** at the switch point, the small latent is padded back to full size in its frequency (cosine) spectrum. The missing high frequencies are filled with fresh noise at the current noise level. The state and noise level are then rescaled so the full-size sampler continues on the same schedule (Eq. 5/6 of the paper).
- **Late steps:** the rest of the run, and always its last steps, happen at full size. So every bit of fine detail is drawn by the model at full resolution.

Same step count, same peak VRAM, cheaper early steps. The trade-off is that a seed frames a little differently with Rapid on than off.

## Prior work we build on (all MIT)

| | LC Speed Boost (LC123 nodes) | ComfyUI-SPEED, SwarmNeo fork (aoleg) | ComfyUI-SPEED (ruwwww) / the paper authors' node |
|---|---|---|---|
| Maths | torch, on the GPU (DCT as matmuls) | numpy + scipy on the CPU | same |
| Flow models (Krea 2, Z-Image, Flux, Qwen, Wan) | yes | yes | yes |
| SDXL family (eps / v-pred) | yes: compares on the flow scale t = σ/(1+σ), rescales by r | soft (their doc explains why; not fixed) | no |
| Skips inpaint / img2img | yes | only in its Forge/Swarm glue | no |
| Always finishes at full size | yes | caps the coarse share at 80% | no |
| Switch point | one noise level (0.7 flow, 0.6 SDXL) | per-model presets from the VAE spectrum, measured for Flux | from the paper |

**What we take:**
- LC's sampler wrapper, since it's the most complete.
- SwarmNeo's findings:
  - The quality limit is a noise level, not a step count.
  - Small text breaks first. Flux.1 renders text correctly only when it switches at about 0.96, while skin and hands are fine at 0.7.
  - A coarse share capped as a backstop.

So the switch point is set **per family, from our own measurements**, rather than one number for everything.

## Parts

### 1. `ComfyUI-HEISS-UI-Nodes`: our node pack (new repo)

Our own ComfyUI node pack, so that later HEISS features have a home (`https://github.com/tristmeister/ComfyUI-HEISS-UI-Nodes`). It has two nodes: **HEISS Rapid** (`HeissRapid`, below) and **HEISS Rapid Guidance** (`HeissRapidGuidance`, see [Rapid Guidance](#rapid-guidance-2026-10-08)). HEISS Rapid takes a `SAMPLER` and returns a `SAMPLER`, and goes between `KSamplerSelect` and `SamplerCustomAdvanced`.

**Inputs:**
- `sampler`
- `switch_at`: a noise level on the 0..1 flow scale, 0.3 to 0.99; HEISS sets it per family
- `scale`: start size, default 0.5
- `min_full_steps`: default 2
- `smooth_switch`: the extra step after the switch (see [The smooth switch](#the-smooth-switch-found-while-testing)), default on

**Behaviour:**
- Works out the model kind itself:
  - **flow** (`CONST`): state = (1−t)·x0 + t·ε
  - **sigma** (`EPS`, `V_PREDICTION` and its subclass `EDM`, `COSMOS_RFLOW`): state = x0 + σ·ε, compared on t = σ/(1+σ), rescaled by r
- Image (4D) and video (5D) latents. The DCT runs over the last two axes, and so does the padding.
- The coarse size is rounded to the model's grid: even on both sides (UNets handle any size; DiTs patch in 2s).
- It turns itself off, and says so, when there's:
  - an inpaint mask
  - conditioning made at full size: an image concatenated to the latent (inpaint models, Fill, image to video, InstructPix2Pix), or masked or area conditioning
  - a run starting below noise 0.9 (img2img / upscale)
  - an unknown model kind (including `IMG_TO_IMG` samplings)
  - a latent that isn't 4D or 5D, or is smaller than 8 on a side
  - too few steps
- The last `min_full_steps` always run at full size. At most 80% of the steps run small.
- At the switch it resets the model's caches that are keyed by latent size (Qwen-Image 2.1's prefix cache crashed on its second size).
- It reports what it did over the socket (`heiss.rapid`: steps small and full, switch noise, or why it was skipped), only to the client that queued the run, so the app can show and record the real outcome. A run queued without a client gets the console line only.
- Fresh noise is seeded from the run's seed, so a seed with Rapid on gives the same picture every time.
- Has Python tests. The main one is an exact Gaussian-data denoiser: for x0 ~ N(0, P) in the DCT basis, E[x0 | x_t] is known in closed form. Sampling with Rapid on must reproduce the data's per-frequency variance just as sampling with it off does, for both flow and sigma models. A wrong rescale shows up as wrong variance, which is a sharper check than "looks fine".

The pack is pinned in `server/node-packs.js` like every other pack. The existing install panel, the ComfyUI Manager Git-URL route and the terminal command all work unchanged. Updates are reviewed changes to the pinned commit.

### 2. Which families support it (`family-catalog.js`)

Each family can carry `rapid: { at }`, and a variant can override or disable it with `rapid: false`. That's the only place that decides support; the rest is generic.

**First values, to be checked and adjusted against the Windows benchmark:**

| Family | `at` | Basis |
|---|---|---|
| Krea 2 Raw | 0.7 | LC's tests: 2×, detail holds |
| Krea 2 Turbo | 0.45 | measured 2026-10-14: 6 of 8 steps small, 1.5× at 1024², 1.8× at 1536², pictures as at 0.7 |
| Z-Image | 0.7 | LC |
| Flux.2 Klein / Dev | 0.7 | LC (1.3× at 4 steps) |
| Qwen-Image | 0.7 | LC lists it; measure it |
| Qwen-Image 2.1 | step reuse instead (`cache: 0.3, cacheFrom: 0.5`) | measured 2026-10-14: the half-size start spots its skin; see Step reuse below |
| Flux.1, Chroma | 0.85 to start | SwarmNeo: text breaks below about 0.94 at 40 steps. We measure with the text probe and choose. |
| SDXL / Pony / Illustrious | 0.6 | LC's sweep (5 checkpoints, 4 samplers, 4 schedulers) |

- **Off:**
  - SD 1.5 / 2.x: a 512 native size halves to 256, below what the model handles.
  - The few-step SDXL variants: Turbo, DMD2, LCM, Lightning, Hyper.
  - MiniMax H3 and LTX: they don't work with it.
- **Not yet, until measured:** Sana, Ideogram 4, MageFlow, AuraFlow, SD3, HiDream, Lumina.
- **Video (Wan pair, Hunyuan): phase 2.** The node handles 5D latents, but the high/low pair graph needs its own wiring, and video needs its own measurements.

### 3. Server

- **`node-packs.js`:** the pack is pinned (`heiss`, both nodes listed). `update: true` brings an older installed copy to the pinned commit, so a copy with Rapid but without Rapid Guidance gets the update panel (`pack-installer.js`), unless someone has edited it.
- **`family-profiles.js` (`rapidCapability`):** three capabilities:
  - `capabilities.rapid`: `HeissRapid` is loaded and the family or variant supports it
  - `capabilities.rapidGuidance`: `HeissRapidGuidance` is loaded and the family isn't a few-step variant
  - `capabilities.rapidInstall`: either part only lacks the pack

  Families with their own graph, own loaders or a runner never get it. A quantized checkpoint's own loader (NF4) doesn't get the half-size start, since its kernels are untested at other latent sizes; it can still use Rapid Guidance.
- **`validation.js`:** `sanitizeRapid` and `sanitizeRapidGuidance` keep each part only when:
  - it was asked for (the client's preference and seed rule)
  - the profile has it ready
  - the run is text-to-image: no inpaint, no start image, no reference images (edit mode is unmeasured)
  - for Rapid Guidance also: CFG above 1 and a family with a negative pass

  The body carries `rapid: { at, smooth }` and `rapidGuidance: { until }`:
  - `at` and `until` come from the catalog, moved by the **speed choice** (`prefs.rapidSpeed`): Careful moves `at` up by 0.1 and `until` down by 0.1, Faster the other way. The results are clamped to 0.45–0.95 for `at` and 0.1–0.6 for `until`.
  - `smooth` is on from 12 steps (`SMOOTH_FROM_STEPS`). The node has its own floor of 8 steps; below 12, HEISS already sends it off.
  - `rapidAt`, `rapidSmooth` and `rapidCfgUntil` in the request override all of this. They're for the benchmark and for retries, and accept 0.3–0.99 for `at`.
- **`family-graph.js`:**
  - `customSampler` wraps `KSamplerSelect` in `HeissRapid` when `body.rapid` is set.
  - `cfgGuider` uses `HeissRapidGuidance` in place of `CFGGuider` when `body.rapidGuidance` is set and CFG is above 1.
  - Families on a plain `KSampler` switch, only while either part is on, to the equivalent `RandomNoise + CFGGuider + BasicScheduler + KSamplerSelect → SamplerCustomAdvanced`.
  - Own graphs (H3, Ideogram, Mage, Sana), the video pair graph and imported workflows never get it.
- **`jobs.js`:** catches the node's `heiss.rapid` message and keeps it on the run as `rapidReport`.
- **`gallery-store.js` (`generationSettings`):**
  - Records `rapid: true`, `rapidAt` and `rapidSmooth` on pictures where the node really ran, plus what the node reported: `rapidSmallSteps`, `rapidFullSteps` and `rapidSwitchNoise` (where it really switched). Rapid Guidance records `rapidGuidance: true` with `rapidCfgUntil`. A speed choice other than Balanced is kept as `rapidSpeed` (passed through by `validation.js`).
  - If the node reports a skip, records `rapidSkipped` with the reason instead, so the details panel tells the truth.
- **`generation-timing.js`:** Rapid runs are tagged (`rapid` only when the node really ran, `guidance`), and estimates use runs made the same way. Until there are enough, the other runs stand in, scaled by 0.75 (`RAPID_SHARE`), so time estimates for runs with and without it don't get averaged together.
- **`civitai.js`:** the A1111 parameters text gets `HEISS Rapid: switch <at>` and `HEISS Rapid Guidance: CFG until <until>`.
- **`index.js`:** `/api/rapid/status` says whether every node of the pack is loaded and, if not, returns the shared install plan.

### 4. Client

- **Preferences** (`constants.ts`, all default on):
  - `prefs.rapidAll`: the master switch over both parts. The sidebar and phone rows switch this.
  - `prefs.rapid`: the half-size start.
  - `prefs.rapidGuidance`: Rapid Guidance.
  - `prefs.rapidSpeed`: `careful`, `balanced` (default) or `faster`.
- **Settings › Features › Rapid:** a drawer with one switch (its description carries the seed rule), the Speed choice, and the user's models that have it. The two parts have no switches of their own on screen: nobody picks between them, and a "parts off" state was a dead end. Switching Rapid on brings both parts back. When the pack is missing, it lists the models waiting for it and a button that opens the HEISS Nodes dialog.
- **Seed rule** (`src/app/rapid.js`, `rapidState`; client side, since only the client knows how a seed got there). A part runs when all of these hold:
  - `prefs.rapidAll` and that part's own preference are on
  - the model's capability for that part is ready
  - either no seed is pinned, or the pinned seed is the one restored from a picture made with Rapid (`rapidSeed`)
  - the run has no start image, reference images or inpaint mask
  - for Rapid Guidance also: CFG above 1
- **How that plays out:**
  - "Use settings" on a Rapid picture restores its seed and sets `rapidSeed` (`rapidSeedFrom`), so the same picture comes back.
  - Typing your own seed, or reusing a picture made without Rapid, turns it off for those runs.
  - "Vary" clears the seed, so Rapid is back on.
  - Clearing the seed clears `rapidSeed`. Undo (`restoreDraft`) carries `rapidSeed` too.
- **Composer:**
  - The sidebar shows a small **Rapid** row (`RapidRow.tsx`) with the switch and the benefit, not the mechanism: "Up to twice as fast", or why it isn't helping the next run ("Paused for a fixed seed", "Not used with a start image"). When only the pack is missing it says "Faster pictures" with "Set up", which opens the HEISS Nodes dialog. It's hidden for models that can't use it, and where there's nothing to speed up (guidance alone at CFG 1).
  - Phone: the same row as a switch in the phone's settings.
  - The model menu shows a Rapid bolt on models that can use it, while Rapid is on.
- **Retry** (`retry.ts`): reruns with the original run's parts, switch points and speed (`rapidAt`, `rapidSmooth`, `rapidCfgUntil`, `rapidSpeed`).
- **Details panel** (`rapidSummary` in `rapid.js`, shown by `format.ts`): one **Rapid** row under Sampling, only on pictures Rapid had a part in: "On · Balanced" (the speed), or "Not used:" and the node's reason in a few words (inpainting, start image, too few steps, picture too small). Switch points and step counts stay in the picture's settings for the bench and retries, not on screen.

### The smooth switch (found while testing)

After the grow, the paper realigns the noise level upwards (0.70 → 0.82 for a half-size start). Its code, LC Speed Boost and ComfyUI-SPEED then take one long step from there to the schedule's next level.

An exact Gaussian denoiser (`tests/test_rapid.py` in the pack) shows what that costs. The lowest frequencies, i.e. the picture's broad contrast and colour, come out 6–9% weaker than with Rapid off, and this happens at every step count (8 to 400). So it's a systematic loss, not a discretisation error that more steps would fix.

The fix is **`smooth_switch`**: one extra full-size step in the middle of that jump. It brings those frequencies back to within 2–3.5% of a run with Rapid off, for the price of one step.

Other approaches tried:
- Re-spacing the remaining schedule: loses mid and high detail.
- Easing back over 2–3 steps: only closes half the gap.

HEISS uses the smooth switch from 12 steps (`SMOOTH_FROM_STEPS` in validation.js); below that the extra step eats most of the gain (see the measurements). The node has its own floor of 8 steps for anyone wiring it by hand. The benchmark's `fast` mode (no smoothing step) compares the two.

### 5. Benchmark (`scripts/bench-rapid.mjs`)

- Drives HEISS's own `inferModels → sanitizeGenerateBody → imageGraph` against a real ComfyUI.
- Times sampler and decode from the progress socket, and polls peak VRAM with nvidia-smi.
- Probes: skin, hands, small text and a wide street scene, on fixed seeds, at 1024² and 1536².
- **Baseline (off) first; then on vs off once the pack is in.** The images go side by side for an A/B on the same seeds, to pick each family's `at` value.

## Order of work

1. ✅ Branch, benchmark script, Windows baseline prompt.
2. ✅ The node pack: the node, the Python tests (Gaussian oracle, plan, guards, 4D/5D, MPS), README with credits.
3. ✅ HEISS server: pack entry, catalog values, capability, validation, graph, settings record, timing key, tests (`rapid`, `contract`).
4. ✅ HEISS client: preference, settings card with install, seed rule (`src/app/rapid.js`, tested), sidebar and phone row, retry, details panel.
5. ✅ Publish the pack repo, then pin its commit in `node-packs.js`.
6. Windows: install the pack, run on vs off, compare pictures, set each family's `at`, update MODELS.md and CHANGELOG.
   - ✅ Krea 2 Turbo and Flux.2 Klein 9B measured on the 3070 (below); MODELS.md and CHANGELOG updated.
   - Still to measure: Qwen-Image and Qwen-Image 2.1, Flux.1 and Chroma (their 0.85 is a starting guess), Z-Image, SDXL, and the Rapid Guidance cut-off.
7. Video (Wan 2.2 pair), Anima and the other flow families, each after measuring.

## Measurements

### RTX 3070 (8 GB), 2026-10-07, ComfyUI 0.37.0

Median sampling time on the seed-42 runs. The first run after each prompt change also paid for reloading the model, so the 1234567 runs aren't a fair comparison; the benchmark now runs one untimed warm-up per prompt and size.

| Model | Steps | Size | Off | On (smoothing step) | Fast (no smoothing) |
|---|---|---|---|---|---|
| Krea 2 Turbo fp8 | 8 | 1024² | ~28 s | ~24.5 s (1.15×) | ~21 s (1.35×) |
| Krea 2 Turbo fp8 | 8 | 1536² | ~59 s | ~43.5 s (1.35×) | ~36.5 s (1.6×) |
| Flux.2 Klein 9B fp8 | 4 | 1024² | 8.2 s | ~8.5 s (1.0×) | ~6.3 s (1.3×) |
| Flux.2 Klein 9B fp8 | 4 | 1536² | 17.1 s | 15.8 s (1.08×) | 11.6 s (1.47×) |

What this shows:

- **Less speed-up than LC's 5090 figures.** These weights don't fit in 8 GB (6.7 GiB peak), so every step also streams weights, and that cost doesn't shrink at half size. Bigger cards and bigger pictures gain more.
- **The smoothing step costs one full-size step.** On a 4–8 step distill that eats most of the gain. So HEISS now adds it only from 12 steps up (`SMOOTH_FROM_STEPS` in validation.js), where it's a few percent of the run. The picture comparison of fast against on still decides whether that's right.
- **Qwen-Image 2.1 had no Rapid entry.** Its "on" runs were the same graph again, answered from ComfyUI's cache. It now has `at: 0.7`, still to be measured, and the benchmark skips Rapid modes for models without Rapid.

### What the pictures show (contact sheets from that run)

- **Krea 2 Turbo:** skin, freckles, hands and the sign text hold up. The chalkboard text is at least as good with Rapid as without, and sometimes better: "Croisant 2.50" where the off run has "Croisast" or "Croienst". The shot frames tighter and closer, sometimes as a quite different composition at 1536². Switch points 0.6 to 0.9 all read fine; above 0.7 only small things in the scene change.
- **Flux.2 Klein 9B (4 steps):** text is correct with Rapid and framing changes a lot (corner shot vs front shot). The raindrops on the window come out fewer and softer in some portraits, which is the one detail loss seen so far. The switch-point sweep made identical pictures: with 4 steps, every value lands on the same step (2 small, 2 full), so few-step models can't be tuned through `at`.
- **On vs fast:** close to identical on both models. At 4–8 steps the smoothing step shows no visible benefit, which backs turning it off below 12 steps.
- **Qwen-Image 2.1:** not measured yet. Those runs had no Rapid in the graph and came back from ComfyUI's cache.

### Run A/B medians as reported (3070, before the warm-up fix)

| Model | 1024² on / fast | 1536² on / fast |
|---|---|---|
| Krea 2 Turbo (8 steps) | 1.21× / 1.39× | 1.39× / 1.65× |
| Flux.2 Klein 9B (4 steps) | 0.97× / 1.26× | 1.27× / 1.74× |

Below 12 steps HEISS now runs the fast variant (no smoothing step), so these models get the **fast** numbers.

Where the switch actually happened, from the ComfyUI log:
- Krea: at 0.655 (5 of 8 steps small) for `at` 0.6 and 0.7, and at 0.84 or 0.905 for 0.8 and 0.9.
- Klein: always at 0.883 (2 of 4 steps small), whatever `at` asks for.

The agent judged 0.6 indistinguishable from off on both models. For these schedules 0.6 and 0.7 land on the same step, so the catalog keeps 0.7.


## Rapid Guidance (2026-10-08)

The second part of Rapid, with its own switch: **HEISS Rapid Guidance** (`HeissRapidGuidance`, in the same pack) replaces `CFGGuider`.
- It keeps CFG while the noise level is at or above `until` (`rapid.cfgUntil` per family, default 0.3).
- Below that it samples at CFG 1, where ComfyUI skips the second, prompt-less model pass, so those steps cost half.
- It applies to every image family on the shared graph, but only on runs with CFG above 1. Video, own graphs and runners are left out.
- It's on by default. Its own preference (`prefs.rapidGuidance`, like `prefs.rapid` for the start) stays for scripts but has no switch on screen; the Rapid switch (`prefs.rapidAll`) covers both, and switching it on turns both parts back on.
- The same seed rule applies to both parts.
- Benchmark: `--rapid guide` (alone), `--with-guidance` (with on/fast), `--cfg-until a,b` (sweep).

The pack moves with HEISS: `update: true` in node-packs.js brings an older installed copy to the pinned commit (one-click install and terminal steps), unless someone has edited it.


## Step reuse, and one accelerator per model (2026-10-14)

Rapid's first part is now one of two accelerators, chosen per family in `family-catalog.js`, never both:
- **The half-size start** (`rapid: { at }`), for most families and every few-step distill.
- **Step reuse** (`rapid: { cache, cacheFrom }`), ComfyUI's own `EasyCache`: on a step where the model's input barely moved, it reuses the model's last change instead of running it. It is for a family the half-size start breaks. It needs no node pack, only a ComfyUI that has `EasyCache` (capabilities say `false` otherwise). Speed moves where it begins, ±0.1 of the schedule, as it moves the switch.

Measured on the RTX 3070 (8 GB), seed 42, portrait and text prompts. Sampling times; `--cache`, `--cache-start`, `--cache-end`, `--rapid-scale`, `--rapid-min-full`, `--sampler` and `--cfg` in the benchmark sweep these.

| Model | Size | Off | Half-size start | Step reuse |
|---|---|---|---|---|
| Qwen-Image 2.1 (25 steps) | 1024² | 17.1s | 12.5s, spotted skin and a glitchy sign | 10.7s (0.3 from 0.4), clean at sheet scale |
| Qwen-Image 2.1 | 1536² | 43.3s | 36.6s at 0.85 (no spots, still degraded) | 26.2s (0.3 from 0.4): menu clean, "1987" reads "1937"; **31.3s (0.3 from 0.5), text as off: shipped, 1.39×** |
| Krea 2 Turbo (8 steps) | 1024² | 30.5s | 20.4s at 0.45 (22.2s at 0.7) | ≈25.5s: skips 1-2 of 8 |
| Krea 2 Turbo | 1536² | 56.5s | 31.4s at 0.45 (35.5s at 0.7) | – |
| Flux.2 Klein 9B (4 steps) | 1024² / 1536² | 7.9s / 16.4s | 6.3s / 11.2s | – |
| Z-Image Turbo (8 steps) | 1024² | 13.4s | 10.1s | skips 0-2 of 8 |
| Qwen-Image 2.1, shipped (0.3 from 0.5) | 1024² | 17.1s | – | 12.7s (1.35×), as off |
| Krea 2 Edit merge int4 (8 steps) | 1024² | 8.7s | 5.4s at 0.45 (1.62×), tighter framing, text as its off | – |
| Pony (SDXL, 25 steps, euler_ancestral, CFG 7) | 1024² | 12.0s | 9.3s (1.29×) | skips none |
| Z-Image Turbo | 1536² | 28.0s | 18.8s (1.49×), text and skin hold; 0.45 at 1024² broke the chalkboard layout, so it keeps 0.7 | – |
| Pony (SDXL, 25 steps, CFG 5, euler) | 1024² | 11.8s | – | 6.7s, but text smears |

What the pictures showed:
- **Step reuse from the default 15% of the schedule garbles small text** at 1536² (the chalkboard's "1.80" turned into "1.20" with doubled strokes) at every threshold from 0.15 to 0.3, and ending it at 80% did not help. Starting it at 40% keeps the menu as the run without it, at 0.2 and 0.3 alike, but the sign's small "EST. 1987" reads "1937" at both; 0.25 from 30% already ghosts a menu digit. From 50% (0.3) both read as off, at 1.39×: the catalog uses that, and Faster moves it back to 40% (1.65×). 0.12 from 40% is about as clean at 1.47×. Every setting leaves the face a touch darker than off, a small tonal shift, not damage. The pictures at 1024² looked the same as off at sheet scale, so look at text crops.
- **The half-size start breaks Qwen-Image 2.1 at 0.7**: leopard-like spots on skin and a doubled outline on the sign, with or without the smoothing step. At 0.85 the spots are gone but the picture is still worse (harsh, over-sharpened skin, an invented header and a lost digit on the chalkboard) and it saves little.
- **Step reuse does nothing on few-step distills** (Krea Turbo, Z-Image Turbo): there are no steps similar enough to skip. **With an ancestral sampler** (Pony's euler_ancestral) it skips none, since the fresh noise each step moves the input.
- **On SDXL with euler it skips half the steps but smears text**, so SDXL keeps the half-size start.
- **Together they destroy the picture** (Qwen 2.1 and Pony): EasyCache resets at the size change and reuses stale changes after it.
- **ComfyUI's LazyCache** (`--cache-node LazyCache`) is faster than EasyCache on Qwen-Image 2.1 (1536²: 27.8s at 0.3 from 0.5, 1.56×) and keeps the text, but the sign's plaster turns blotchy with a purple cast and the chalk frame washes out. EasyCache stays. `QwenImage21Cache` only sets where the prompt prefix's KV cache lives; its default (auto) is already right.
- **Krea 2 Turbo at 0.45** looks as at 0.7, text included. Its chalkboard is garbled with and without Rapid.
- **Rejected**: a 0.375 start size (Krea text breaks), and one full-size step instead of two on Klein (1.97×, but softer, fewer raindrops and "BAKERRY"; a candidate for Faster only).

**The grow with the run's own noise** (node pack `feature/rapid-v2`, 19d066f, PACK_VERSION 9, not pushed yet): at the switch the new high frequencies come from the noise the seed drew, not from a fresh draw. Same speed. At 1024² it keeps Rapid pictures closer to off: Krea 2 Turbo's portrait gets its raindrops back, and Flux.2 Klein's chalkboard reads "Croisant 2.50 / Coffee 1.80 / Pretzel 1.20" where the fresh draw gave duplicated, jumbled rows. Once pushed, `node-packs.js` pins that commit. At 1536² it is neutral to better (Krea the same; Klein's sign reads "EST 1987" where the fresh draw squashed it), and on the Krea 2 Edit int4 merge and Pony it changes nothing visible. Measured as SSIM against the run without Rapid (grey, 512²), it moves closer in 11 of 12 cases: Krea 2 Turbo portrait 0.47 → 0.61 (1024²) and 0.45 → 0.60 (1536²), Klein portrait 0.56 → 0.64, Klein text at 1536² 0.36 → 0.44; the one step back is Pony's text, 0.321 → 0.312. PSNR hardly moves (Rapid reframes, so pixels don't line up either way).

**Step reuse on a long run with CFG**, measured on Qwen-Image 2.1 at CFG 4 as a stand-in (25 steps, two passes a step), 1024²: off 33.4s; step reuse (0.3 from 0.5) 23.8s, 1.41×, pictures as off; Rapid Guidance alone 22.5s, 1.48×; both 22.6s. Once Guidance has dropped CFG, the late steps are single passes, and those are the steps step reuse skips, so the two don't add up. The long-step CFG families (Krea 2 Raw, Z-Image Base, Qwen-Image, Flux.2 Dev, Chroma) already get this from Rapid Guidance and keep their half-size start; none of them were on this machine to confirm directly.
