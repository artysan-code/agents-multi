// machines.tsx — Machines: the account's nodes with their state, load and accounts, which one answers the chat,
// and pairing a new one with the 8-character code (ADR 0014, G4).

import { useEffect, useState } from "preact/hooks";
import {
  claimPairing,
  forgetNode,
  getOrchestrator,
  loadNodes,
  type Orchestrator,
  type PairPreview,
  previewPairing,
  setOrchestrator,
} from "./api.ts";
import { memUsed, moved, type NodeInfo, normalizeCode, online, orderOf, showCode } from "./lib.ts";
import { dateOf, t } from "./t.ts";
import { pin, pinned } from "./state.ts";
import { Empty, Failure, Header, Icon, Sheet, Skeleton, toast, usePull } from "./ui.tsx";

function Pair({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState("");
  const [preview, setPreview] = useState<PairPreview | null>(null);
  // first which machine asks, then a yes: a code someone else handed over never pairs their machine unseen
  const submit = async (e: Event) => {
    e.preventDefault();
    if (code.length !== 8 || busy) return;
    setBusy(true);
    try {
      const p = (await previewPairing(code)).preview;
      if (p.kind === "server") throw new Error(t("pair.server"));
      setPreview(p);
      setErr("");
      setDone("");
    } catch (x) {
      setErr((x as Error).message);
      setPreview(null);
    }
    setBusy(false);
  };
  const confirm = async () => {
    setBusy(true);
    try {
      setDone((await claimPairing(code)).node);
      setCode("");
      setPreview(null);
      setErr("");
      onPaired();
    } catch (x) {
      setErr((x as Error).message);
    }
    setBusy(false);
  };
  return (
    <section class="card" aria-labelledby="pair-h">
      <h2 id="pair-h">{t("pair.title")}</h2>
      <ol class="steps">
        <li>{t("pair.s1")} <code class="cmd">agents node pair</code></li>
        <li>{t("pair.s2")}</li>
      </ol>
      <form onSubmit={submit} class="pair">
        <label class="field">
          <span>{t("pair.code")}</span>
          <input
            class="code-in"
            type="text"
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect="off"
            spellcheck={false}
            placeholder="XXXX-XXXX"
            value={showCode(code)}
            aria-describedby="pair-help"
            onInput={(e) => setCode(normalizeCode(e.currentTarget.value))}
          />
        </label>
        <button type="submit" class="btn primary" disabled={busy || code.length !== 8}>{busy ? t("pair.pairing") : t("pair.go")}</button>
      </form>
      <p id="pair-help" class="meta">{t("pair.help")}</p>
      {preview && (
        <div class="banner" role="alertdialog" aria-labelledby="pair-q">
          <p id="pair-q">
            {t("pair.confirm", { n: preview.node, p: preview.platform || "?", w: dateOf(preview.asked, { hour: "2-digit", minute: "2-digit" }) })}
          </p>
          <div class="row">
            <button type="button" class="btn primary" disabled={busy} onClick={confirm}>{t("pair.yes")}</button>
            <button type="button" class="btn" disabled={busy} onClick={() => setPreview(null)}>{t("pair.no")}</button>
          </div>
        </div>
      )}
      {done && <p class="banner ok" role="status"><Icon name="check" size={18} />{t("pair.done", { n: done })}</p>}
      {err && <p class="banner crit" role="alert"><Icon name="alert" size={18} />{err}</p>}
    </section>
  );
}

/** Forgetting asks first: the machine stops answering, what waits on it goes, and its tokens are revoked. */
function ForgetSheet({ name, onClose, onForgot }: { name: string; onClose: () => void; onForgot: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const go = async () => {
    setBusy(true);
    try {
      await forgetNode(name);
      if (pinned.value === name) pin(null);
      toast(t("machines.forgot", { n: name }));
      onForgot();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Sheet title={t("machines.forgetTitle", { n: name })} onClose={onClose}>
      <p class="meta">{t("machines.forgetHelp")}</p>
      {err && <p class="err" role="alert">{err}</p>}
      <div class="sheet-actions">
        <button type="button" class="btn danger" disabled={busy} aria-busy={busy} onClick={go}>{t("machines.forget")}</button>
        <button type="button" class="btn" disabled={busy} onClick={onClose}>{t("cancel")}</button>
      </div>
    </Sheet>
  );
}

export function Machines() {
  const [forgetting, setForgetting] = useState<string | null>(null);
  const [nodes, setNodes] = useState<{ nodes: NodeInfo[]; now: string } | null>(null);
  const [orch, setOrch] = useState<Orchestrator>({ node: null, order: [] });
  const [err, setErr] = useState("");
  const load = () =>
    Promise.all([loadNodes(), getOrchestrator().catch(() => ({ node: null, order: [] }) as Orchestrator)]).then(
      ([n, o]) => (setNodes(n), setOrch(o), setErr("")),
      (e: Error) => setErr(e.message),
    );
  const pull = usePull(load);
  useEffect(() => {
    void load();
    const again = setInterval(() => document.visibilityState === "visible" && void load(), 30_000);
    return () => clearInterval(again);
  }, []);

  const save = (next: Orchestrator) => {
    setOrch(next);
    setOrchestrator(next).then(() => setErr(""), (e: Error) => (setErr(e.message), load()));
  };

  const names = nodes?.nodes.map((n) => n.name) ?? [];
  const order = orderOf(orch.order, names);
  return (
    <>
      {pull.indicator}
      <Header large title={t("machines.title")} back="#more" />
      {err && <Failure text={err} retry={load} />}
      {!nodes && !err && <Skeleton rows={3} tall />}
      {nodes && !nodes.nodes.length && !err && <Empty icon="machine" text={t("machines.none")} />}
      {nodes && nodes.nodes.length > 0 && (
        <ul class="stack">
          {nodes.nodes.map((n) => {
            const on = online(n, nodes.now);
            const mem = memUsed(n);
            return (
              <li key={n.name} class="card node">
                <div class="node-h">
                  <span class={`dot ${on ? "on" : "off"}`} role="img" aria-label={on ? t("machines.online") : t("machines.offline")} />
                  <b>{n.name}</b>
                  {orch.node === n.name && <span class="tag">{t("machines.answers")}</span>}
                  <span class="push" />
                  <small>{n.headless ? t("machines.server") : t("machines.desktop")}</small>
                </div>
                <dl class="facts">
                  <div><dt>{t("machines.load")}</dt><dd>{n.load.toFixed(2)}</dd></div>
                  <div><dt>{t("machines.memory")}</dt><dd>{mem}%</dd></div>
                  <div><dt>{t("machines.sessions")}</dt><dd>{n.running}/{n.cap}</dd></div>
                  <div><dt>{t("machines.version")}</dt><dd>{n.version}</dd></div>
                </dl>
                {n.accounts.length > 0 && (
                  <p class="accts" aria-label={t("machines.accounts")}>
                    {n.accounts.map((a) => <span key={a} class="tag plain">{a}</span>)}
                  </p>
                )}
                {!on && (
                  <div class="gone">
                    <p class="meta">{t("machines.seen", { t: dateOf(n.seen, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) })}</p>
                    <button type="button" class="btn small danger-o" onClick={() => setForgetting(n.name)}>
                      <Icon name="trash" size={16} />{t("machines.forget")}
                    </button>
                  </div>
                )}
                {on && (
                  <button type="button" class="btn small ghost forget-quiet" onClick={() => setForgetting(n.name)}>{t("machines.forgetQuiet")}</button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {nodes && nodes.nodes.length > 0 && (
        <section class="card">
          <h2>{t("machines.orch")}</h2>
          <p class="meta">{t("machines.orchHelp")}</p>
          <label class="field">
            <span>{t("machines.answering")}</span>
            <select value={orch.node ?? ""} onChange={(e) => save({ ...orch, node: e.currentTarget.value || null, order })}>
              <option value="">{t("machines.auto")}</option>
              {names.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          {order.length > 1 && (
            <>
              <h3>{t("machines.fallback")}</h3>
              <ol class="order">
                {order.map((n, i) => (
                  <li key={n}>
                    <span>{i + 1}. {n}</span>
                    <button type="button" class="icon-btn flip" aria-label={t("machines.up", { n })} disabled={i === 0} onClick={() => save({ ...orch, order: moved(order, i, -1) })}>
                      <Icon name="down" size={18} />
                    </button>
                    <button type="button" class="icon-btn" aria-label={t("machines.down", { n })} disabled={i === order.length - 1} onClick={() => save({ ...orch, order: moved(order, i, 1) })}>
                      <Icon name="down" size={18} />
                    </button>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      )}
      <Pair onPaired={load} />
      {forgetting && <ForgetSheet name={forgetting} onClose={() => setForgetting(null)} onForgot={() => (setForgetting(null), void load())} />}
    </>
  );
}
