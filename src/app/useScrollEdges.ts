import { useEffect, type RefObject } from 'react';

/**
 * Marks a scrolling box with where it has more to show: data-more is "above",
 * "below" or "both", and absent while everything fits. CSS fades that edge, so
 * rows slide under a soft edge instead of being cut off at a hard line.
 */
export function useScrollEdges(ref: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    const box = ref.current;
    if (!active || !box) return;
    const update = () => {
      const above = box.scrollTop > 1;
      const below = box.scrollTop + box.clientHeight < box.scrollHeight - 1;
      const more = above && below ? 'both' : above ? 'above' : below ? 'below' : '';
      if (more) box.dataset.more = more;
      else delete box.dataset.more;
    };
    update();
    box.addEventListener('scroll', update, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(box);
    // A search adds and drops rows while the box itself may keep its size.
    const rows = new MutationObserver(update);
    rows.observe(box, { childList: true, subtree: true });
    return () => {
      box.removeEventListener('scroll', update);
      resize.disconnect();
      rows.disconnect();
    };
  }, [ref, active]);
}
