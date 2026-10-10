// throttle.ts — `run` at most once every `ms`: the first call goes through at once, and one that falls
// inside the wait is not lost but runs when the wait is over, so what the page shows is the latest.

import { useEffect, useRef } from "preact/hooks";

interface Throttled {
  (): void;
  /** Drops the call that is waiting (the component went away). */
  cancel(): void;
}

function throttle(run: () => unknown, ms: number): Throttled {
  let last = 0, timer: number | undefined;
  const fire = () => {
    timer = undefined;
    last = Date.now();
    void run();
  };
  const call = (() => {
    if (timer !== undefined) return;
    const wait = last + ms - Date.now();
    if (wait <= 0) fire();
    else timer = setTimeout(fire, wait);
  }) as Throttled;
  call.cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  return call;
}

/** A throttled `run` for a component, stable across renders and dropped when it goes away. `run` is the
 *  latest one given, so it may read the state of the render it was last drawn in. */
export function useThrottled(run: () => unknown, ms: number): () => void {
  const latest = useRef(run);
  latest.current = run;
  const t = useRef<Throttled | undefined>(undefined);
  t.current ??= throttle(() => latest.current(), ms);
  useEffect(() => () => t.current?.cancel(), []);
  return t.current;
}
