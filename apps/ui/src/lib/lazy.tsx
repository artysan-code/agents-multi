// lazy.tsx — a component that loads its code the first time it is drawn (a dynamic import, so the build
// puts it in a chunk of its own). Preact's core has no Suspense; this is the part of it the console needs.

import type { ComponentType, FunctionComponent } from "preact";
import { useEffect, useState } from "preact/hooks";
import { toastErr } from "./ui.tsx";

export function lazy<P extends object>(load: () => Promise<ComponentType<P>>): FunctionComponent<P> {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<void> | null = null;
  return function Lazy(props: P) {
    const [, redraw] = useState(0);
    useEffect(() => {
      if (loaded) return;
      pending ??= load().then((c) => void (loaded = c)).catch((e) => {
        pending = null; // drawn again, it tries again
        toastErr(e);
      });
      void pending.then(() => redraw((n) => n + 1));
    }, []);
    const C = loaded;
    return C ? <C {...props} /> : null;
  };
}
