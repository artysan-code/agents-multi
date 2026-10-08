// updates.tsx — System › Updates: the version of each component with what is waiting or staged and its
// rollback, the note on the Claude Code Desktop carries, and the update log. «Update now» (in the tab
// bar) starts the wizard.

import type { ComponentChildren } from "preact";
import { status } from "../../state.ts";
import { lang, t, tk } from "../../i18n.ts";
import { runAction } from "../../lib/ui.tsx";
import {
  COMPONENTS,
  type MachineExtra,
  type RepoExtra,
  type Report,
} from "./updates-lib.tsx";
import { openCloseClaude } from "./updates-close.tsx";

function Card({ name, current, lines, rollback, extra }: {
  name: string;
  current: string | null | undefined;
  lines: (string | null)[];
  rollback?: string | null;
  extra?: ComponentChildren;
}) {
  return (
    <div class="vcard">
      <i></i>
      <div style={{ flex: 1, minWidth: 0 }}>
        <b>{name}</b>
        <code>{current ?? "—"}</code>
        {lines.filter(Boolean).map((l) => <div class="sub" key={l}>{l}</div>)}
      </div>
      {extra}
      {rollback && (
        <button
          type="button"
          class="btn sm"
          onClick={() => void runAction(rollback)}
        >
          {t("up.rollback")}
        </button>
      )}
    </div>
  );
}

/** agents-multi itself: the repository is the program, so its state is the repository's. */
function SelfCard({ S }: { S: Report }) {
  const r = S.repo as Report["repo"] & RepoExtra;
  if (!r.isRepo) return null;
  const state = !r.upstream
    ? t("up.self.noUpstream", { b: r.branch })
    : r.behind && r.ahead
    ? t("up.self.diverged", { n: r.behind, m: r.ahead })
    : r.behind && r.dirty
    ? t("up.self.dirty", { n: r.behind, d: r.dirty })
    : r.behind
    ? t("up.self.behind", { n: r.behind })
    : t("up.uptodate");
  return (
    <Card
      name="agents-multi"
      current={(r.head ?? "").split(" ")[0]}
      lines={[state, S.selfInstall ? t("up.self.install") : null]}
      // the button only for an install waiting on Claude: not for an update skipped for another reason
      extra={S.selfInstall
        ? (
          <button
            type="button"
            class="btn sm"
            onClick={() => void openCloseClaude()}
          >
            {t("cc.btn")}
          </button>
        )
        : null}
    />
  );
}

const when = (iso: string): string =>
  new Date(iso).toLocaleString(lang(), {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

export function Updates() {
  const S = status.value as Report | null;
  if (!S) return <div class="sub-view" />;
  const m = S.machine as Report["machine"] & MachineExtra;
  const u = S.update ?? {};
  const cliPrev = (m.cliVersions ?? []).filter((v) => v !== m.cliVersion).sort()
    .pop();
  const log = S.updateLog ?? [];
  return (
    <div class="sub-view">
      <p class="lede">{t("up.lede")}</p>
      <div class="vcards" style={{ marginTop: "20px" }}>
        <Card
          name="Claude Code"
          current={m.cliVersion}
          lines={[
            u.cli?.latest && u.cli.latest !== m.cliVersion
              ? t("up.next", { v: u.cli.latest })
              : t("up.uptodate"),
            cliPrev ? t("up.previous", { v: cliPrev }) : null,
          ]}
          rollback={cliPrev ? "rollback-cli" : null}
        />
        <Card
          name="Claude Desktop"
          current={m.desktopVersion}
          lines={[
            m.desktopStaged
              ? t("up.staged", { v: m.desktopStaged })
              : t("up.uptodate"),
            m.desktopSystem ? t("up.system") : null,
            m.desktopPrevious
              ? t("up.previous", { v: m.desktopPrevious })
              : null,
          ]}
          rollback={m.desktopPrevious ? "rollback-desktop" : null}
        />
        <SelfCard S={S} />
      </div>
      <p class="note">
        {Object.entries(m.embeddedCode ?? {})
          .map(([v, vs]) =>
            t("up.embedded", {
              v,
              vs: Array.isArray(vs) ? vs.join(", ") : String(vs ?? ""),
            })
          )
          .join(" · ")}
      </p>
      <div class="panel" style={{ marginTop: "20px" }}>
        <div class="panel-h">
          <h3>{t("up.log")}</h3>
        </div>
        <div class="log">
          {log.length
            ? log.map((e, i) => {
              const bad = e.event === "failed" || e.event === "verify-failed";
              return (
                <div class={`log-row${bad ? " bad" : ""}`} key={`${e.at}${i}`}>
                  <span class="when">{when(e.at)}</span>
                  <span>{COMPONENTS[e.component] ?? e.component}</span>
                  <span>{e.from || "—"} → {e.to || "—"}</span>
                  <span>
                    {tk(`up.ev.${e.event}`)}
                    {e.detail ? ` · ${e.detail}` : ""}
                  </span>
                </div>
              );
            })
            : <div class="panel-b sub">{t("up.noLog")}</div>}
        </div>
      </div>
    </div>
  );
}
