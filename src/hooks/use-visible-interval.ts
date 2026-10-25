import { useEffect, useRef } from "react";

/**
 * Runs `callback` every `ms` while the tab is visible. A background tab stops
 * polling, and runs it once as soon as it is shown again, so it catches up at once.
 * A poll that fails is dropped quietly: the next one tries again, and saying
 * that something is down is the job of the surface that shows it, not the poll.
 */
export function useVisibleInterval(callback: () => unknown, ms: number, enabled = true) {
  const latest = useRef(callback);
  latest.current = callback;

  useEffect(() => {
    if (!enabled) return;
    let timer = 0;
    const run = () => {
      try {
        const result = latest.current();
        if (result instanceof Promise) result.catch(() => null);
      } catch { /* the next tick tries again */ }
    };
    const start = () => {
      window.clearInterval(timer);
      if (!document.hidden) timer = window.setInterval(run, ms);
    };
    const onVisibility = () => {
      if (!document.hidden) run();
      start();
    };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ms, enabled]);
}
