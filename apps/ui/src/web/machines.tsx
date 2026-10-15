// machines.tsx — Machines: the account's nodes with their state, load and accounts, which one answers the chat,
// and pairing a new one with the 8-character code (ADR 0014, G4).

import { useEffect, useState } from "preact/hooks";
import { claimPairing, getOrchestrator, loadNodes, type Orchestrator, setOrchestrator } from "./api.ts";
import { memUsed, moved, type NodeInfo, normalizeCode, online, orderOf, showCode } from "./lib.ts";
import { dateOf, t } from "./t.ts";
import { Empty, Failure, Header, Icon, Skeleton, usePull } from "./ui.tsx";

function Pair({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState("");
  const submit = async (e: Event) => {
    e.preventDefault();
    if (code.length !== 8 || busy) return;
    setBusy(true);
    try {
      const r = await claimPairing(code);
      setDone(typeof r.node === "string" ? r.node : r.node?.name ?? "");
      setCode("");
      setErr("");
      onPaired();
    } catch (x) {
      setErr((x as Error).message);
      setDone("");
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
      {done && <p class="banner ok" role="status"><Icon name="check" size={18} />{t("pair.done", { n: done })}</p>}
      {err && <p class="banner crit" role="alert"><Icon name="alert" size={18} />{err}</p>}
    </section>
  );
}

export function Machines() {
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
                {!on && <p class="meta">{t("machines.seen", { t: dateOf(n.seen, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) })}</p>}
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
    </>
  );
}
