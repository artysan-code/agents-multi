// steps-late.tsx — the first-run wizard's last steps: the vault (made here, or opened with another
// machine's recovery code), each profile's sign-in, the brain, and done (the MCP servers registered,
// a summary, and the console).

import { useEffect, useState } from "preact/hooks";
import { t, tk } from "../../i18n.ts";
import { runJob } from "../../lib/ui.tsx";
import { type StepRow, StepRows } from "../../lib/steps.tsx";
import { send, type Step } from "./api.ts";
import { Nav, type StepProps } from "./index.tsx";
import { useSend } from "./steps.tsx";

/** «Later»: the step is recorded as put off, and the wizard moves on. */
function Later({ p, step, label = "su.later" }: { p: StepProps; step: Step; label?: "su.later" | "su.skip" }) {
  const s = useSend(p);
  return (
    <button type="button" class="bt ghost" disabled={s.running} onClick={() => void s.run(() => send("pass", { step, later: true }))}>
      {t(label)}
    </button>
  );
}

export function Vault(p: StepProps) {
  const s = useSend(p);
  const state = p.v.facts.vault, dir = p.v.vaultDir;
  const [code, setCode] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pairing, setPairing] = useState(state === "locked" || state === "wrong-key");
  const [given, setGiven] = useState("");
  const pass = () => s.run(() => send("pass", { step: "vault" }));

  // the recovery code, once: shown until the person says it is saved
  if (code) {
    return (
      <>
        <h2>{t("su.vault.yours")}</h2>
        <div class="su-code">
          <code>{code}</code>
          <button
            type="button"
            class="bt sm"
            onClick={() => void navigator.clipboard?.writeText(code).then(() => setCopied(true), () => {})}
          >
            {t(copied ? "su.vault.copied" : "su.vault.copy")}
          </button>
        </div>
        <p class="su-warn">{t("su.vault.keep")}</p>
        <label class="fld check su-saved">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.currentTarget.checked)} /> {t("su.vault.saved")}
        </label>
        {s.cause && <p class="uw-cause">{s.cause}</p>}
        <Nav back={null}>
          <button type="button" class="bt pri" disabled={!saved || s.running} onClick={() => void pass()}>{t("su.next")}</button>
        </Nav>
      </>
    );
  }

  return (
    <>
      <h2>{t("su.vault.h")}</h2>
      <p class="su-sub">{t("su.vault.sub")}</p>
      {state === "ok" && (
        <>
          <p class="su-ok">{t("su.vault.ok", { d: dir })}</p>
          <p class="su-note">{t("su.vault.lost")}</p>
        </>
      )}
      {state === "unavailable" && <p class="uw-cause">{t("su.vault.unavailable")}</p>}
      {state === "locked" && <p class="su-note">{t("su.vault.locked", { d: dir })}</p>}
      {state === "wrong-key" && <p class="uw-cause">{t("su.vault.wrong", { d: dir })}</p>}
      {state === "none" && !pairing && (
        <div class="su-choice">
          <button
            type="button"
            class="su-opt"
            disabled={s.running}
            onClick={() => void s.run(() => send<{ ok: boolean; message?: string; code?: string }>("vault", { mode: "init" }), (r) => setCode(r.code ?? ""))}
          >
            <b>{t("su.vault.create")}</b>
            <span>{dir}</span>
          </button>
          <button type="button" class="su-opt" onClick={() => setPairing(true)}>
            <b>{t("su.vault.have")}</b>
            <span>{t("su.vault.code")}</span>
          </button>
        </div>
      )}
      {pairing && state !== "ok" && state !== "unavailable" && (
        <form
          id="su-pair"
          onSubmit={(e) => {
            e.preventDefault();
            void s.run(() => send("vault", { mode: "pair", code: given }));
          }}
        >
          <p class="su-note">{t("su.vault.pairSub")}</p>
          <label class="fld">
            {t("su.vault.code")}
            <input class="mono" type="password" value={given} onInput={(e) => setGiven(e.currentTarget.value)} required autocomplete="off" autofocus />
          </label>
        </form>
      )}
      {s.cause && <p class="uw-cause">{s.cause}</p>}
      <Nav back={pairing && state === "none" ? () => setPairing(false) : p.back}>
        {state !== "ok" && <Later p={p} step="vault" />}
        {state === "ok" && <button type="button" class="bt pri" disabled={s.running} onClick={() => void pass()}>{t("su.next")}</button>}
        {pairing && state !== "ok" && state !== "unavailable" && (
          <button type="submit" form="su-pair" class="bt pri" disabled={s.running || !given.trim()}>{t("su.vault.pair")}</button>
        )}
      </Nav>
    </>
  );
}

export function Logins(p: StepProps) {
  const s = useSend(p);
  const f = p.v.facts;
  const [opened, setOpened] = useState("");
  const all = f.profiles.every((x) => x.signedIn);
  return (
    <>
      <h2>{t("su.logins.h")}</h2>
      <p class="su-sub">{t("su.logins.sub")}</p>
      {!f.claudeCode && <p class="su-note">{t("su.logins.noCode", { c: f.profiles[0]?.command ?? "claude" })}</p>}
      <ul class="su-list">
        {f.profiles.map((x) => (
          <li key={x.profile} class={x.signedIn ? "in" : ""}>
            <span class="su-dot" />
            <b>{x.profile}</b>
            <code>{x.command}</code>
            <span class="su-state">{t(x.signedIn ? "su.logins.in" : "su.logins.out")}</span>
            <button
              type="button"
              class={`bt sm${x.signedIn ? " ghost" : ""}`}
              disabled={s.running || !f.claudeCode}
              onClick={() => void s.run(() => send("login", { profile: x.profile }), () => setOpened(x.profile))}
            >
              {t(x.signedIn ? "su.logins.again" : "su.logins.go")}
            </button>
          </li>
        ))}
      </ul>
      {opened && !f.profiles.find((x) => x.profile === opened)?.signedIn && <p class="su-sub">{t("su.logins.opened", { p: opened })}</p>}
      {s.cause && <p class="uw-cause">{s.cause}</p>}
      <Nav back={p.back}>
        {!all && <Later p={p} step="logins" />}
        {all
          ? <button type="button" class="bt pri" onClick={() => void p.next()}>{t("su.next")}</button>
          : <button type="button" class="bt" onClick={() => void p.next()}>{t("su.check")}</button>}
      </Nav>
    </>
  );
}

export function Brain(p: StepProps) {
  const s = useSend(p);
  const f = p.v.facts;
  const [url, setUrl] = useState(f.brain.url ?? "");
  const [waiting, setWaiting] = useState(false);
  const vault = f.vault === "ok";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void s.run(() => send<{ ok: boolean; message?: string; url?: string }>("brain", { url }), (r) => {
          // the brain's sign-in page: the app opens it in the system browser
          if (r.url) window.open(r.url, "_blank", "noopener");
          setWaiting(true);
        });
      }}
    >
      <h2>
        {t("su.brain.h")} <span class="su-opt-tag">{t("su.brain.opt")}</span>
      </h2>
      <p class="su-sub">{t("su.brain.sub")}</p>
      {f.brain.connected
        ? <p class="su-ok">{t("su.brain.ok", { u: f.brain.url ?? "" })}</p>
        : vault
        ? (
          <label class="fld">
            {t("su.brain.url")}
            <input class="mono" type="url" value={url} onInput={(e) => setUrl(e.currentTarget.value)} placeholder="https://brain.example.org" required spellcheck={false} />
          </label>
        )
        : <p class="su-note">{t("su.brain.noVault")}</p>}
      {waiting && !f.brain.connected && <p class="su-sub">{t("su.brain.wait")}</p>}
      {s.cause && <p class="uw-cause">{s.cause}</p>}
      <Nav back={p.back}>
        {!f.brain.connected && <Later p={p} step="brain" label="su.skip" />}
        {f.brain.connected
          ? <button type="button" class="bt pri" onClick={() => void p.next()}>{t("su.next")}</button>
          : vault && <button type="submit" class="bt pri" disabled={s.running || !url.trim()}>{t("su.brain.go")}</button>}
      </Nav>
    </form>
  );
}

export function Done(p: StepProps) {
  const s = useSend(p);
  const f = p.v.facts;
  const [mcp, setMcp] = useState<StepRow["state"]>("running");
  // the MCP servers, once everything they read is in place (profiles signed in, accounts, the brain)
  useEffect(() => {
    p.busy(true);
    void runJob("mcp-sync", undefined, () => {}).catch((e: Error) => ({ error: e.message })).then((r) => {
      p.busy(false);
      setMcp("error" in r || r.code ? "failed" : "done");
    });
  }, []);
  const later = f.record?.later ?? [];
  const row = (step: Step, detail: string): StepRow => ({
    key: step,
    label: tk(`su.s.${step}`),
    state: later.includes(step) ? "skipped" : "done",
    detail: later.includes(step) ? t("su.later") : detail,
  });
  const n = f.profiles.length;
  const rows: StepRow[] = [
    row("you", f.owner?.name ?? ""),
    row("folder", f.folder ?? ""),
    row("profiles", n === 1 ? t("su.done.profile") : t("su.done.profiles", { n })),
    row("install", ""),
    row("vault", p.v.vaultDir),
    row("logins", `${f.profiles.filter((x) => x.signedIn).length}/${n}`),
    row("brain", f.brain.url ?? ""),
    { key: "mcp", label: t("su.done.mcp"), state: mcp, detail: "" },
  ];
  return (
    <>
      <h2>{t("su.done.h")}</h2>
      <p class="su-sub">{t("su.done.sub", { n: f.owner?.name ?? "" })}</p>
      <StepRows rows={rows} />
      {later.length > 0 && <p class="su-note">{t("su.done.later", { l: later.map((x) => tk(`su.s.${x}`)).join(", ") })}</p>}
      {mcp === "failed" && <p class="uw-cause">{t("su.done.mcpFail")}</p>}
      {s.cause && <p class="uw-cause">{s.cause}</p>}
      <Nav back={mcp === "running" ? null : p.back}>
        <button
          type="button"
          class="bt pri"
          disabled={mcp === "running" || s.running}
          onClick={() =>
            void s.run(() => send("finish", {}), () => {
              location.hash = "#today";
              location.reload();
            })}
        >
          {t("su.done.open")}
        </button>
      </Nav>
    </>
  );
}
