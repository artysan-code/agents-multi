// add.tsx — Connections › Add a server (ADR 0013, F2): the code from a server's log typed here, its fingerprint shown
// to be compared with the log's, and on the owner's yes the server paired with the vault key sealed to it (by the
// console's backend: this page never sees the key). Then where the server stands, and its git key to add to the
// forge; the state comes from the service, read again when the owner asks.

import { useState } from "preact/hooks";
import { claimServer, confirmServer, type ServerPreview, type ServerState, serverState } from "./api.ts";
import { stageOf, typedCode } from "./lib.ts";
import { t } from "../../i18n.ts";
import { toast, toastErr } from "../../lib/ui.tsx";

type Step =
  | { at: "code" }
  | { at: "compare"; code: string; preview: ServerPreview }
  | { at: "paired"; node: string; sealed: boolean; state: ServerState | null };

function GitKey({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ marginTop: "8px" }}>
      <div class="sub">{t("srv.gitkey")}</div>
      <div class="cal-row">
        <code style={{ wordBreak: "break-all" }}>{value}</code>
        <button
          type="button"
          class="btn ghost sm"
          onClick={() => void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => {})}
        >
          {copied ? t("srv.copied") : t("srv.copy")}
        </button>
      </div>
    </div>
  );
}

function Standing({ s }: { s: ServerState }) {
  const stage = stageOf({ known: s.known, online: s.online, waits: s.waits, sandbox: s.sandbox });
  const waits = [...(s.waits ?? []), ...(s.known && s.online && s.sandbox !== true ? [t("srv.state.sandbox")] : [])];
  return (
    <div role="status" aria-live="polite" style={{ marginTop: "8px" }}>
      {stage === "unseen" && <div class="sub">{t("srv.state.unseen")}</div>}
      {stage === "offline" && <div class="sub">{t("srv.state.offline", { seen: s.seen ?? "" })}</div>}
      {stage === "ready" && <div class="sub">{t("srv.state.ready")}</div>}
      {stage === "waiting" && (
        <>
          <div class="sub">{t("srv.state.waiting")}</div>
          <ul class="sub">{waits.map((w) => <li key={w}>{w}</li>)}</ul>
        </>
      )}
      {s.gitKey && <GitKey value={s.gitKey} />}
    </div>
  );
}

export function AddServerCard() {
  const [step, setStep] = useState<Step>({ at: "code" });
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const code = typedCode(typed);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toastErr(e);
    } finally {
      setBusy(false);
    }
  };

  const check = () =>
    run(async () => {
      if (!code) return toast(t("srv.badcode"), true);
      const r = await claimServer(code);
      if (!r.ok) return toast(r.message, true);
      setStep({ at: "compare", code, preview: r });
    });

  const refresh = (node: string, sealed: boolean) =>
    run(async () => {
      const r = await serverState(node);
      if (!r.ok) return toast(r.message, true);
      setStep({ at: "paired", node, sealed, state: r });
    });

  const pair = (s: Extract<Step, { at: "compare" }>) =>
    run(async () => {
      const r = await confirmServer(s.code, s.preview.fingerprint);
      if (!r.ok) return toast(r.message, true);
      toast(t("srv.paired", { node: r.node }));
      setStep({ at: "paired", node: r.node, sealed: r.sealed, state: null });
    });

  const reset = () => {
    setTyped("");
    setStep({ at: "code" });
  };

  return (
    <div class="status-card update" style={{ marginTop: "12px" }}>
      <i />
      <div>
        <b>{t("srv.title")}</b>
        <div class="sub">{t("srv.how")}</div>
        {step.at === "code" && (
          <form
            class="cal-row"
            style={{ marginTop: "8px" }}
            onSubmit={(e) => {
              e.preventDefault();
              void check();
            }}
          >
            <input
              type="text"
              aria-label={t("srv.code")}
              placeholder="ABCD-2345"
              autocomplete="off"
              spellcheck={false}
              maxLength={20}
              value={typed}
              onInput={(e) => setTyped((e.currentTarget as HTMLInputElement).value)}
            />
            <button type="submit" class="btn" disabled={busy || !code}>{t("srv.check")}</button>
          </form>
        )}
        {step.at === "compare" && (
          <div style={{ marginTop: "8px" }}>
            <div class="sub">{t("srv.asks", { node: step.preview.node, platform: step.preview.platform, asked: step.preview.asked })}</div>
            <div class="sub">{t("srv.compare")}</div>
            <p style={{ fontSize: "1.4rem", letterSpacing: ".08em", margin: "8px 0" }}>
              <code>{step.preview.fingerprint}</code>
            </p>
            <div class="cal-row">
              <button type="button" class="btn primary" disabled={busy} onClick={() => void pair(step)}>
                {t("srv.match")}
              </button>
              <button
                type="button"
                class="btn ghost"
                disabled={busy}
                onClick={() => {
                  toast(t("srv.stopped"), true);
                  reset();
                }}
              >
                {t("srv.nomatch")}
              </button>
            </div>
          </div>
        )}
        {step.at === "paired" && (
          <div style={{ marginTop: "8px" }}>
            <div class="sub">
              {t("srv.paired", { node: step.node })} {t(step.sealed ? "srv.paired.vault" : "srv.paired.novault")}
            </div>
            {step.state && <Standing s={step.state} />}
            <div class="cal-row" style={{ marginTop: "8px" }}>
              <button type="button" class="btn ghost sm" disabled={busy} onClick={() => void refresh(step.node, step.sealed)}>
                {t("srv.recheck")}
              </button>
              <button type="button" class="btn ghost sm" onClick={reset}>{t("srv.another")}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
