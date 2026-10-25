import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// A ComfyUI of our own, before the modules read where it is.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "heiss-nodes-"));
process.env.HEISS_COMFY_ROOT = path.join(scratch, "ComfyUI");
process.env.HEISS_DATA_DIR = path.join(scratch, "data");
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const { heissFeatures, heissLoadFailureFrom, heissNodesSettings, heissNodesStatusFrom, loadFailureReason, localHeissCopy, saveHeissNodesSettings } = await import("./heiss-nodes.js");
const { nodePacks } = await import("./node-packs.js");
const { packInstallPlan } = await import("./node-install.js");
const { packCopies, packFastForwardable, packInstallState, packVersionOnDisk, startPackInstall } = await import("./pack-installer.js");
const { execFileSync } = await import("node:child_process");

const root = path.join(scratch, "ComfyUI");
const folder = path.join(root, "custom_nodes", nodePacks.heiss.folder);
const nodes = (...names) => Object.fromEntries(names.map((name) => [name, {}]));
const allNodes = nodes(...nodePacks.heiss.nodes);
const report = (version) => ({ pack: "heiss-ui-nodes", version, commit: "", nodes: [] });
const writeCopy = (version, { git = false } = {}) => {
  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(folder, { recursive: true });
  if (version) fs.writeFileSync(path.join(folder, "heiss_info.py"), `"""docs"""\n\nPACK_VERSION = ${version}\n`);
  if (git) {
    fs.mkdirSync(path.join(folder, ".git"));
    fs.writeFileSync(path.join(folder, ".git", "HEAD"), `${nodePacks.heiss.commit}\n`);
  }
};

test("every feature on the pack needs a version the pinned pack has", () => {
  for (const feature of heissFeatures) {
    assert.ok(feature.version <= nodePacks.heiss.version, feature.id);
    for (const node of feature.nodes) assert.ok(nodePacks.heiss.nodes.includes(node), `${feature.id}: ${node}`);
  }
  // The pin may be newer than every feature needs: pack 9 only improves Rapid's pictures, and older copies keep Rapid.
  assert.ok(Math.max(...heissFeatures.map((feature) => feature.version)) <= nodePacks.heiss.version);
});

test("install, update, restart and ready, from what ComfyUI loaded and what's on disk", () => {
  const fresh = heissNodesStatusFrom({ info: {}, local: { present: false, git: false, head: "", version: 0 } });
  assert.equal(fresh.state, "install");
  assert.ok(fresh.features.every((feature) => !feature.ready));

  // A Rapid-only copy from before the version route: Rapid still runs, RTX, the inpaint stitch and prompt enhance wait for the update.
  const old = heissNodesStatusFrom({ info: nodes("HeissRapid", "HeissRapidGuidance"), report: null, local: { present: true, git: true, head: "abc", version: 0 } });
  assert.deepEqual([old.state, old.loadedVersion], ["update", 2]);
  assert.deepEqual(old.features.map((feature) => [feature.id, feature.ready]), [["rapid", true], ["rtx", false], ["inpaint", false], ["enhance", false]]);
  assert.equal(heissNodesStatusFrom({ info: nodes("HeissRapid"), local: null }).loadedVersion, 1);

  // Updated on disk, ComfyUI not restarted yet.
  const waiting = heissNodesStatusFrom({ info: nodes("HeissRapid", "HeissRapidGuidance"), local: { present: true, git: true, head: nodePacks.heiss.commit, version: nodePacks.heiss.version } });
  assert.deepEqual([waiting.state, waiting.local.onPin], ["restart", true]);

  const ready = heissNodesStatusFrom({ info: allNodes, report: report(nodePacks.heiss.version), local: null });
  assert.equal(ready.state, "ready");
  assert.ok(ready.features.every((feature) => feature.ready));
  // A newer pack than HEISS knows (someone updated it) is fine.
  assert.equal(heissNodesStatusFrom({ info: allNodes, report: report(nodePacks.heiss.version + 1) }).state, "ready");
  // ComfyUI elsewhere: nothing on disk to look at, the loaded nodes decide.
  assert.equal(heissNodesStatusFrom({ info: {}, local: null }).state, "install");
});

test("the copy on disk is read for its version, git or not", () => {
  const pick = ({ present, git, head, version, folder, others }) => ({ present, git, head, version, folder, others });
  writeCopy(2);
  assert.deepEqual(pick(localHeissCopy(root)), { present: true, git: false, head: "", version: 2, folder: nodePacks.heiss.folder, others: 0 });
  assert.ok(localHeissCopy(root).changedAt > 0);
  writeCopy(3, { git: true });
  assert.deepEqual(pick(localHeissCopy(root)), { present: true, git: true, head: nodePacks.heiss.commit, version: 3, folder: nodePacks.heiss.folder, others: 0 });
  writeCopy(0);
  assert.equal(packVersionOnDisk(folder, nodePacks.heiss), 0);
  fs.rmSync(folder, { recursive: true, force: true });
  assert.equal(localHeissCopy(root).present, false);
  assert.equal(localHeissCopy(""), null);
});

test("the terminal command works with or without an older copy there", () => {
  const remote = packInstallPlan(nodePacks.heiss, "", "linux").commands[0].command;
  assert.match(remote, /\{ \[ -d "ComfyUI-HEISS-UI-Nodes" \] \|\| git clone https:\/\/github\.com\/tristmeister\/ComfyUI-HEISS-UI-Nodes\.git; \} && git -c "safe\.directory=\*" -C ComfyUI-HEISS-UI-Nodes fetch origin && git -c "safe\.directory=\*" -C ComfyUI-HEISS-UI-Nodes checkout --detach [0-9a-f]{40}/);
  const [powershell, cmd] = packInstallPlan(nodePacks.heiss, "", "win32").commands;
  assert.match(powershell.command, /if \(-not \(Test-Path -LiteralPath "ComfyUI-HEISS-UI-Nodes"\)\) \{ git clone /);
  assert.match(cmd.command, /\(if not exist "ComfyUI-HEISS-UI-Nodes" git clone [^)]+\) && git -c "safe\.directory=\*" -C ComfyUI-HEISS-UI-Nodes fetch origin/);
  // A pack that doesn't move with HEISS keeps its plain clone.
  assert.doesNotMatch(packInstallPlan(nodePacks.seedvr2, "", "linux").commands[0].command, /\[ -d/);
});

test("an older copy without git is set aside (never deleted) and the reviewed one installed", { skip: process.platform === "win32" }, async () => {
  // Our own ComfyUI Python, and a `git` that only pretends, so nothing is downloaded.
  const python = path.join(root, ".venv", "bin", "python");
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(python, "#!/bin/sh\necho pip \"$@\"\n", { mode: 0o755 });
  const bin = path.join(scratch, "bin");
  fs.mkdirSync(bin, { recursive: true });
  // HEISS passes "-c safe.directory=<folder>" first (gitArgsIn); the subcommand comes after.
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh
while [ "$1" = "-c" ]; do shift 2; done
case "$1" in
  clone) mkdir -p "$4/.git"; echo "${nodePacks.heiss.commit}" > "$4/.git/HEAD"; printf 'PACK_VERSION = 3\\n' > "$4/heiss_info.py" ;;
  rev-parse) echo "${nodePacks.heiss.commit}" ;;
esac
exit 0
`, { mode: 0o755 });
  const before = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${before}`;
  try {
    writeCopy(2);
    fs.writeFileSync(path.join(folder, "mine.txt"), "kept");
    let state = await startPackInstall("heiss");
    for (let i = 0; i < 100 && state.status === "running"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state = packInstallState("heiss");
    }
    assert.equal(state.status, "done", state.error);
    const aside = fs.readdirSync(path.join(root, "custom_nodes")).find((name) => name.endsWith(".disabled"));
    assert.match(aside, /^ComfyUI-HEISS-UI-Nodes-v2-\d+\.disabled$/);
    assert.equal(fs.readFileSync(path.join(root, "custom_nodes", aside, "mine.txt"), "utf8"), "kept");
    assert.equal(packVersionOnDisk(folder, nodePacks.heiss), 3);
  } finally {
    process.env.PATH = before;
  }
});

test("a copy under another folder name is found, and a second copy counted", () => {
  const customNodes = path.join(root, "custom_nodes");
  const zip = path.join(customNodes, "ComfyUI-HEISS-UI-Nodes-main");
  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(zip, { recursive: true });
  fs.writeFileSync(path.join(zip, "heiss_rapid.py"), "");
  fs.writeFileSync(path.join(zip, "heiss_info.py"), "PACK_VERSION = 7\n");
  // ComfyUI skips these, so they don't count.
  fs.mkdirSync(path.join(customNodes, "ComfyUI-HEISS-UI-Nodes-v2-1.disabled"), { recursive: true });
  fs.writeFileSync(path.join(customNodes, "ComfyUI-HEISS-UI-Nodes-v2-1.disabled", "heiss_rapid.py"), "");
  assert.deepEqual(packCopies(customNodes, nodePacks.heiss), ["ComfyUI-HEISS-UI-Nodes-main"]);
  assert.deepEqual([localHeissCopy(root).folder, localHeissCopy(root).version, localHeissCopy(root).others], ["ComfyUI-HEISS-UI-Nodes-main", 7, 0]);
  writeCopy(9);
  assert.deepEqual(packCopies(customNodes, nodePacks.heiss), [nodePacks.heiss.folder, "ComfyUI-HEISS-UI-Nodes-main"]);
  assert.deepEqual([localHeissCopy(root).folder, localHeissCopy(root).others], [nodePacks.heiss.folder, 1]);
  fs.rmSync(zip, { recursive: true, force: true });
  fs.rmSync(path.join(customNodes, "ComfyUI-HEISS-UI-Nodes-v2-1.disabled"), { recursive: true, force: true });
  fs.rmSync(folder, { recursive: true, force: true });
});

test("a pack ComfyUI couldn't import is 'failed' until something changes, then a restart", () => {
  const at = Date.parse("2026-10-25T10:00:00");
  const entries = [
    { t: "2026-10-25T09:59:58.000", m: "Import times for custom nodes:\n" },
    { t: "2026-10-25T10:00:00.000", m: "Cannot import /c/ComfyUI/custom_nodes/ComfyUI-HEISS-UI-Nodes module for custom nodes: No module named 'cv2'\n" },
    { t: "2026-10-25T10:00:01.000", m: "Cannot import /c/ComfyUI/custom_nodes/other-pack module for custom nodes: boom\n" }
  ];
  const failure = heissLoadFailureFrom(entries, [nodePacks.heiss.folder]);
  assert.deepEqual(failure, { folder: nodePacks.heiss.folder, error: "No module named 'cv2'", at });
  // Windows paths and a copy under another name.
  assert.equal(heissLoadFailureFrom([{ t: "2026-10-25T10:00:00", m: "Cannot import C:\\ComfyUI\\custom_nodes\\comfyui-heiss-ui-nodes module for custom nodes: x" }], []).folder, "comfyui-heiss-ui-nodes");
  assert.equal(heissLoadFailureFrom(entries.slice(2), [nodePacks.heiss.folder]), null);

  const local = { present: true, git: true, head: nodePacks.heiss.commit, version: nodePacks.heiss.version, changedAt: at - 60_000 };
  const failed = heissNodesStatusFrom({ info: {}, local, failure });
  assert.equal(failed.state, "failed");
  assert.match(failed.failure.reason, /cv2/);
  // ComfyUI elsewhere: the log is all HEISS has, and it says the same.
  assert.equal(heissNodesStatusFrom({ info: {}, local: null, failure }).state, "failed");
  // Repaired (packages installed) or updated after the failure: the next restart loads it.
  assert.equal(heissNodesStatusFrom({ info: {}, local, failure, installedAt: at + 1000 }).state, "restart");
  assert.equal(heissNodesStatusFrom({ info: {}, local: { ...local, changedAt: at + 1000 }, failure }).state, "restart");
  // Removed since: an install, not a repair. Loaded (another copy, or the log is old): the failure doesn't matter.
  assert.equal(heissNodesStatusFrom({ info: {}, local: { present: false, version: 0 }, failure }).state, "install");
  assert.equal(heissNodesStatusFrom({ info: allNodes, report: report(nodePacks.heiss.version), local, failure }).state, "ready");

  assert.match(loadFailureReason("cannot import name 'foo' from 'comfy.model_management'"), /Update ComfyUI/);
  assert.match(loadFailureReason("something odd"), /ComfyUI said: something odd/);
});

test("keeping the pack up to date by itself is on until switched off", () => {
  assert.equal(heissNodesSettings().autoUpdate, true);
  saveHeissNodesSettings({ autoUpdate: false });
  assert.equal(heissNodesSettings().autoUpdate, false);
  saveHeissNodesSettings({ autoUpdate: "yes" });
  assert.equal(heissNodesSettings().autoUpdate, false);
  saveHeissNodesSettings({ autoUpdate: true });
  assert.equal(heissNodesSettings().autoUpdate, true);
});

test("only a clean checkout simply behind the pin, with the same requirements, updates by itself", { skip: process.platform === "win32" }, async () => {
  const repo = path.join(scratch, "ff-repo");
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q");
  fs.writeFileSync(path.join(repo, "requirements.txt"), "a\n");
  fs.writeFileSync(path.join(repo, "heiss_info.py"), "PACK_VERSION = 1\n");
  git("add", "."); git("commit", "-qm", "one");
  const one = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(repo, "heiss_info.py"), "PACK_VERSION = 2\n");
  git("commit", "-qam", "two");
  const two = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(repo, "requirements.txt"), "a\nb\n");
  git("commit", "-qam", "three");
  const three = git("rev-parse", "HEAD");
  git("checkout", "-q", "--detach", one);

  assert.equal(await packFastForwardable(repo, { commit: two }), true);
  // New Python packages: the dialog, where pip runs in view.
  assert.equal(await packFastForwardable(repo, { commit: three }), false);
  // Already there, or past it.
  assert.equal(await packFastForwardable(repo, { commit: one }), false);
  git("checkout", "-q", "--detach", two);
  assert.equal(await packFastForwardable(repo, { commit: one }), false);
  // Someone's edits are never moved.
  git("checkout", "-q", "--detach", one);
  fs.writeFileSync(path.join(repo, "heiss_info.py"), "PACK_VERSION = 1 # mine\n");
  assert.equal(await packFastForwardable(repo, { commit: two }), false);
});

test("a zip copy under another name is set aside too, so only one copy loads", { skip: process.platform === "win32" }, async () => {
  // The fake git and Python from the set-aside test above.
  const bin = path.join(scratch, "bin");
  const before = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${before}`;
  const customNodes = path.join(root, "custom_nodes");
  for (const name of fs.readdirSync(customNodes)) fs.rmSync(path.join(customNodes, name), { recursive: true, force: true });
  const zip = path.join(customNodes, "ComfyUI-HEISS-UI-Nodes-main");
  fs.mkdirSync(zip, { recursive: true });
  fs.writeFileSync(path.join(zip, "heiss_rapid.py"), "");
  fs.writeFileSync(path.join(zip, "heiss_info.py"), "PACK_VERSION = 5\n");
  try {
    let state = await startPackInstall("heiss");
    for (let i = 0; i < 100 && state.status === "running"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state = packInstallState("heiss");
    }
    assert.equal(state.status, "done", state.error);
    const names = fs.readdirSync(customNodes).sort();
    assert.equal(names.length, 2);
    assert.ok(names.includes(nodePacks.heiss.folder));
    assert.match(names.find((name) => name !== nodePacks.heiss.folder), /^ComfyUI-HEISS-UI-Nodes-main-v5-\d+\.disabled$/);
    assert.deepEqual(packCopies(customNodes, nodePacks.heiss), [nodePacks.heiss.folder]);
  } finally {
    process.env.PATH = before;
  }
});
