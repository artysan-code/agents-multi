// nav.tsx — what the wizard's steps share with the page that shows them: the props every step gets
// and the footer of a step. Its own module, so steps.tsx and steps-late.tsx do not import index.tsx,
// which imports them.

import type { ComponentChildren } from "preact";
import { t } from "../../i18n.ts";
import type { SetupView } from "./api.ts";

/** What every step gets: the view, moving on, going back, and saying that it is busy. */
export interface StepProps {
  v: SetupView;
  /** after a step's write: reload, and show the step the server says is next */
  next: () => Promise<void>;
  back: (() => void) | null;
  busy: (b: boolean) => void;
}

/** The footer of a step: «Back» first when there is somewhere to go back to, then the step's buttons. */
export function Nav({ back, children }: { back: (() => void) | null; children?: ComponentChildren }) {
  return (
    <div class="uw-go su-go">
      {back && <button type="button" class="bt ghost" onClick={back}>{t("su.back")}</button>}
      <span class="su-fill" />
      {children}
    </div>
  );
}
