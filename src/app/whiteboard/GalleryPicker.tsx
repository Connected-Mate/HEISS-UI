import React from 'react';
import { Check, GalleryHorizontalEnd, LoaderCircle } from 'lucide-react';
import { listReferenceAssets } from '../api';
import { Modal } from '../Modal';
import { SafeImg } from '../SafeImg';
import { cn } from '../format';
import type { ShowToast } from '../toast';
import type { ReferenceAsset } from '../types';

type Source = 'generation' | 'upload';
type Page = { items: ReferenceAsset[]; cursor: string; hasMore: boolean; loaded: boolean; loading: boolean; error: string };
const emptyPage = (): Page => ({ items: [], cursor: '', hasMore: false, loaded: false, loading: false, error: '' });

/**
 * Pictures from the gallery or earlier uploads, picked several at a time, for
 * the whiteboard. Hidden stays out: a board is kept in the open data folder.
 */
export function GalleryPicker({ open, onOpenChange, onAdd, showToast }: { open: boolean; onOpenChange: (open: boolean) => void; onAdd: (assets: ReferenceAsset[]) => void; showToast: ShowToast }) {
  const [source, setSource] = React.useState<Source>('generation');
  const [pages, setPages] = React.useState<Record<Source, Page>>({ generation: emptyPage(), upload: emptyPage() });
  const [chosen, setChosen] = React.useState<Map<string, ReferenceAsset>>(new Map());

  const load = React.useCallback(async (which: Source, more = false) => {
    let cursor = '';
    setPages((current) => {
      cursor = more ? current[which].cursor : '';
      return { ...current, [which]: { ...current[which], loading: true, error: '' } };
    });
    try {
      const page = await listReferenceAssets(which, cursor, 60);
      setPages((current) => ({ ...current, [which]: { items: more ? [...current[which].items, ...page.items] : page.items, cursor: page.nextCursor || '', hasMore: Boolean(page.hasMore), loaded: true, loading: false, error: '' } }));
    } catch (error) {
      setPages((current) => ({ ...current, [which]: { ...current[which], loading: false, error: error instanceof Error ? error.message : 'Couldn’t load the pictures' } }));
    }
  }, []);

  React.useEffect(() => {
    if (!open) return;
    setChosen(new Map());
    setPages({ generation: emptyPage(), upload: emptyPage() });
  }, [open]);
  React.useEffect(() => {
    if (open && !pages[source].loaded && !pages[source].loading && !pages[source].error) void load(source);
  }, [open, source, pages, load]);

  const page = pages[source];
  const toggle = (asset: ReferenceAsset) => setChosen((current) => {
    const next = new Map(current);
    if (next.has(asset.id)) next.delete(asset.id); else next.set(asset.id, asset);
    return next;
  });
  const add = () => {
    if (!chosen.size) return;
    onAdd([...chosen.values()]);
    showToast(chosen.size === 1 ? 'Added to the board' : `${chosen.size} images added to the board`, 'success');
    onOpenChange(false);
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="wide"
      icon={<GalleryHorizontalEnd size={17} />}
      title="Add pictures to the board"
      description="Pick as many as you like. They stay where they are; the board shows them."
      className="wb-picker"
      footer={
        <>
          <button type="button" className="btn" onClick={() => onOpenChange(false)}>Cancel</button>
          <button type="button" className="btn is-primary" disabled={!chosen.size} onClick={add}>{chosen.size ? `Add ${chosen.size}` : 'Add'}</button>
        </>
      }
    >
      <div className="wb-picker-body">
      <div className="wb-picker-tabs" role="tablist" aria-label="Where from">
        {(['generation', 'upload'] as Source[]).map((which) => (
          <button key={which} type="button" role="tab" aria-selected={source === which} className={cn('wb-picker-tab', source === which && 'is-on')} onClick={() => setSource(which)}>
            {which === 'generation' ? 'Generated' : 'Uploads'}
          </button>
        ))}
      </div>
      <div className="wb-picker-grid" role="listbox" aria-multiselectable="true" aria-label={source === 'generation' ? 'Generated pictures' : 'Uploaded pictures'}>
        {page.items.map((asset) => {
          const on = chosen.has(asset.id);
          return (
            <button key={asset.id} type="button" role="option" aria-selected={on} className={cn('wb-picker-item', on && 'is-on')} onClick={() => toggle(asset)} title={asset.name}>
              <SafeImg src={asset.thumbnailUrl || asset.url} alt={asset.name} loading="lazy" decoding="async" fallback={<span className="wb-image-gone" aria-label={`${asset.name}: image not found`} />} />
              {on ? <i aria-hidden><Check size={12} /></i> : null}
            </button>
          );
        })}
      </div>
      {page.loading ? <p className="wb-picker-note"><LoaderCircle className="wb-spin" size={14} /> Loading…</p> : null}
      {page.error ? <p className="wb-picker-note is-error" role="alert">{page.error} <button type="button" className="btn" onClick={() => void load(source)}>Try again</button></p> : null}
      {page.loaded && !page.items.length ? <p className="wb-picker-note">{source === 'generation' ? 'Nothing generated yet.' : 'No uploads yet. Drop images on the board to add some.'}</p> : null}
      {page.hasMore && !page.loading ? <button type="button" className="btn wb-picker-more" onClick={() => void load(source, true)}>Load more</button> : null}
      </div>
    </Modal>
  );
}
