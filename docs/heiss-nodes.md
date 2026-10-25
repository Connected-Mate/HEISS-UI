# HEISS UI Nodes: installing and keeping the pack current

HEISS's own ComfyUI pack ([ComfyUI-HEISS-UI-Nodes](https://github.com/tristmeister/ComfyUI-HEISS-UI-Nodes)) carries every feature that needs custom nodes: Rapid, Rapid Guidance, RTX video upscale and the inpaint stitch so far. People install it once, the first time they touch one of those features, and HEISS offers an update whenever a newer HEISS needs a newer pack.

## The pieces

| Where | What |
|---|---|
| Pack: `heiss_info.py` | `PACK_VERSION`, one integer that goes up whenever HEISS needs something new from the pack. `GET /heiss/nodes` returns `{ version, commit, nodes }`. |
| `server/node-packs.js` (`heiss`) | The reviewed `commit` HEISS installs, and its `version`. Both ship with HEISS, so a release zip and a git clone of HEISS ask for the same pack. |
| `server/heiss-nodes.js` | `heissFeatures`: each feature, its nodes and the pack version it needs. The pack's state comes from what ComfyUI loaded and what's on disk. |
| `GET /api/heiss-nodes` | That state, the features and the install panel. `/api/rapid/status` and RTX's nodes stage read from it. |
| `src/app/heissNodes.ts` | `requireHeissNodes(feature, then)`: runs `then` when the feature is ready, else opens the dialog and runs it once the feature is. |
| `src/app/HeissNodesDialog.tsx` | The dialog: Install (or Update) → Restart → Ready, with what the pack brings. |
| Settings › Features › HEISS UI Nodes | Where it stands, one button for what's next (Set up / Update / Repair / Restart… / Details), and **Keep them up to date**. Rapid, RTX and inpaint rows use the same words (`heissNodesAction`). |
| `server/heiss-nodes.js` (`autoUpdateHeissNodes`) | The quiet update, below. Its switch is saved in `data/heiss-nodes.json`. |
| `POST /heiss/models/rescan` (pack 8) | Drops ComfyUI's cached model lists, so a model HEISS just downloaded is listed on drives whose folders never change their modified time (exFAT). Prompt enhance's setup calls it ([prompt-enhance.md](prompt-enhance.md)). |

## States

- **ready**: loaded, at the version HEISS needs or newer. Someone who updated the pack themselves is fine.
- **restart**: the right version is on disk (or HEISS just repaired it), but ComfyUI hasn't restarted yet.
- **failed**: there, but ComfyUI couldn't import it when it last started. HEISS reads why from ComfyUI's own log (`/internal/logs/raw`, "Cannot import … module for custom nodes"), says it in a sentence (a missing Python package, a ComfyUI too old, or ComfyUI's words), and offers **Repair**: the same one-click install, which reinstalls its packages. Once files or packages changed after the failure, it's **restart** again. A restart alone would loop, which is why this state exists; it works for a ComfyUI on another computer too. The log keeps 300 lines, so a failure long scrolled out reads as before.
- **update**: loaded or on disk, but older. Features the older pack has keep working. Packs from before version 3 had no version route, so their nodes tell them apart (Rapid only = 1, with Rapid Guidance = 2).
- **install**: not there.

## How each install situation is handled

| Situation | What happens |
|---|---|
| ComfyUI on this computer, no pack | One click: clone at the reviewed commit and install `requirements.txt` with ComfyUI's Python, PyTorch held. Then the ComfyUI restart. |
| Older git checkout | One click: fetch, then check out the reviewed commit. Left alone if it has local edits (it says so) or is already past the pin. |
| Older copy without git (a zip, Manager's registry) | One click: it's renamed to `ComfyUI-HEISS-UI-Nodes-v<N>-<time>.disabled`, which ComfyUI skips, and installed fresh. Nothing is deleted. |
| ComfyUI on another computer | The terminal command for that machine. It works whether an older copy is there or not: clone if missing, fetch, check out the pin, pip. |
| Installed by hand or in Manager while the dialog is open | The dialog checks every 4 s and moves on by itself. |
| Restart | ComfyUI-Manager's restart, or "restart it yourself"; the dialog waits for the new version to load. |
| A copy under another folder name (a GitHub zip's `-main`, Manager's lowercase registry folder) | Found by `signature` (`heiss_rapid.py`, in every version). A git checkout there is updated where it is; a copy without git is set aside and the pack installed in its own folder. |
| Two copies at once | Both register the same nodes and the older can win. The install keeps one and sets the others aside (renamed `.disabled`, never deleted); the dialog says so. |
| ComfyUI couldn't import it | **failed**, above: Repair, then restart. |
| HEISS needs a newer pack, and the copy is a clean git checkout simply behind the pin with the same requirements | Updated in the background (`git checkout` of the pin, no pip), once per pin, unless **Keep them up to date** is off. ComfyUI keeps running the loaded version; the app says once "HEISS UI Nodes updated" with **Restart…**, and the restart stays the person's call. Features the loaded version has keep working meanwhile. Anything else (edits, a zip copy, new requirements, ComfyUI elsewhere) waits for the dialog. HEISS looks 20 s after it starts, every 30 minutes, and whenever the app asks. |

Tested end to end against a real ComfyUI and the real pack on GitHub: a fresh install, an update from a version 2 git checkout, an update from a version 2 copy without git, each through restart to ready.

## Keeping old and new working together

A HEISS and a pack meet in every combination: an old HEISS with a pack someone updated, a new HEISS with a pack from last year. So the pack only ever adds:

- Never remove or rename a node, an input or an output. ComfyUI drops inputs a node doesn't declare, so a newer HEISS sending a new input to an older node is fine; an older HEISS that doesn't send a new **required** input is not. New inputs are optional, with the old behaviour as their default.
- A change in what a node does is a new `PACK_VERSION`, and the feature that needs it names that version in `heissFeatures`. Features the loaded pack already has keep running on it; only the one that needs more asks.
- Pin commits that are on the pack's `main` (or a tag). A commit only on a feature branch disappears when the branch is cleaned up, and every new install then fails.
- Keep `pyproject.toml`'s version in step, so Manager's registry doesn't hand out an old one.

## Adding a feature that needs nodes

1. Add the node to the pack, and raise `PACK_VERSION` in `heiss_info.py`.
2. Push it to the pack's `main`. Pin that commit and the new `version` in `node-packs.js` (`heiss`, and `heissrtx`, which shares the folder).
3. Add the feature to `heissFeatures`, with its nodes and that version.
4. In the app, call `requireHeissNodes('<id>', then)` wherever the feature is first used.

Anyone on an older pack gets the Update dialog the first time they touch the new feature, and only then.
