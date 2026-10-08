// index.tsx — the first-run wizard: on a machine with no configuration (or a setup started and not
// finished) the console opens on this screen instead of Today (main.tsx). It takes a new person from
// nothing to a working setup, a step at a time, in the update screen's language (lib/screen.css,
// lib/steps.tsx): welcome, you, the configuration folder, the profiles, install, Claude Code, the vault, each
// profile's sign-in, the brain, done.
//
// Every step is the server's (/api/setup/*, apps/cli/setup.ts), which also says where the setup is,
// from what is on disk: a closed window or a crash resumes at the first step whose result is missing.
// The page only keeps which step is on screen, so «Back» can show an earlier one and a sign-in that
// ends in the background does not move the screen under the person's eyes.

import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { useTopic } from "../../state.ts";
import { t, tk } from "../../i18n.ts";
import { Overlays } from "../../lib/ui.tsx";
import { loadSetup, type SetupView, type Step, STEPS } from "./api.ts";
import { Folder, Install, Profiles, Welcome, You } from "./steps.tsx";
import { Brain, Claude, Done, Logins, Vault } from "./steps-late.tsx";
import "../../lib/screen.css";
import "./setup.css";

/** What every step gets: the view, moving on, going back, and saying that it is busy. */
export interface StepProps {
  v: SetupView;
  /** after a step's write: reload, and show the step the server says is next */
  next: () => Promise<void>;
  back: (() => void) | null;
  busy: (b: boolean) => void;
}

const BODIES: Record<Step, (p: StepProps) => ComponentChildren> = {
  welcome: Welcome,
  you: You,
  folder: Folder,
  profiles: Profiles,
  install: Install,
  claude: Claude,
  vault: Vault,
  logins: Logins,
  brain: Brain,
  done: Done,
};

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

export function Setup({ initial }: { initial: SetupView }) {
  const [v, setV] = useState(initial);
  const [cur, setCur] = useState<Step>(initial.step);
  const [working, setWorking] = useState(false);

  const reload = async () => {
    const n = await loadSetup().catch(() => null);
    // finished elsewhere (another window): the console
    if (n && !n.active) {
      location.reload();
      return null;
    }
    if (n) setV(n);
    return n;
  };
  // a sign-in finished in the terminal or the browser, another window moved a step: the data, not the screen
  useTopic(reload, ["state"]);

  const at = STEPS.indexOf(cur), frontier = STEPS.indexOf(v.step);
  // never past the first step whose result is missing
  const step = at > frontier ? v.step : cur;
  const i = STEPS.indexOf(step);
  const next = async () => {
    const n = await reload();
    if (n) setCur(n.step);
  };
  const back = i > 0 && !working ? () => setCur(STEPS[i - 1]) : null;
  const Body = BODIES[step];
  const done = step === "done" && !working;

  return (
    <div class="uw-screen su-screen" role="dialog" aria-modal="true" aria-label={t("su.title")}>
      <div class="uw-card su-card">
        <div class="su-top">
          <span class="su-of">{t("su.of", { n: i + 1, m: STEPS.length })} · {tk(`su.s.${step}`)}</span>
          <div class="su-rail" aria-hidden="true">
            {STEPS.map((s, k) => (
              <i key={s} class={k === i ? "on" : k < frontier || v.step === "done" ? "ok" : ""} />
            ))}
          </div>
        </div>
        <div class={`uw-mark${working ? " on" : ""}${done ? " ok" : ""}`} aria-hidden="true">
          {done
            ? <svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" /></svg>
            : <svg viewBox="0 0 16 16"><path d="M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2" /></svg>}
        </div>
        <Body key={step} v={v} next={next} back={back} busy={setWorking} />
      </div>
      <Overlays />
    </div>
  );
}
