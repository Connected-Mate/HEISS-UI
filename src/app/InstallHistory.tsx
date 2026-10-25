import React, { useState } from 'react';
import { Undo2 } from 'lucide-react';
import { Modal } from './Modal';
import { apiJson } from './api';
import type { ShowToast } from './toast';

type InstallRecord = { id: string; at: string; reason: string; packs: Array<{ name: string }>; status: string; canUndo: boolean };

function relativeTime(value = "") {
  const time = Date.parse(value);
  if (!time) return "";
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(time).toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * Add-ons installed for imported workflows, newest first, each with an undo.
 * Lives in Settings (not in the import picker): it's for the rare day an
 * add-on needs taking back, not part of bringing a workflow in.
 */
export function InstallHistoryButton({ showToast, onUndone }: { showToast: ShowToast; onUndone: () => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<InstallRecord[] | null>(null);
  const [working, setWorking] = useState("");
  const load = () => apiJson<{ installs: InstallRecord[] }>("/api/installs").then((data) => setItems(data.installs || [])).catch(() => setItems([]));
  const undo = async (id: string) => {
    setWorking(id);
    try {
      await apiJson("/api/workflows/setup/undo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ snapshotId: id }) });
      showToast("Undone. ComfyUI is restarting with what it had before.", "success");
      onUndone();
      await load();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn’t undo the install", "error");
    } finally {
      setWorking("");
    }
  };
  return (
    <>
      <button type="button" className="btn is-ghost" onClick={() => { setOpen(true); load(); }}>Show</button>
      <Modal open={open} onOpenChange={setOpen} title="Add-ons for workflows" description="What importing workflows installed in ComfyUI, newest first." busy={Boolean(working)}>
        {items === null ? <p className="wf-pick-hint">Loading…</p> : !items.length ? <p className="wf-pick-hint">Nothing yet.</p> : (
          <ul className="wf-saved">
            {items.map((item) => (
              <li key={item.id} className="wf-install-row">
                <span>{item.packs.map((pack) => pack.name).join(", ") || item.reason}</span>
                <em>{item.status === "undone" ? "undone" : relativeTime(item.at)}</em>
                {item.canUndo && item.status !== "undone" ? <button type="button" className="btn is-ghost" disabled={Boolean(working)} onClick={() => undo(item.id)}><Undo2 size={12} /> Undo</button> : null}
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </>
  );
}
