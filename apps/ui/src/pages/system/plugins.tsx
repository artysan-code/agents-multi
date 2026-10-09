// plugins.tsx — System › Plugins & skills: the per-profile table (a cell cycles inherit → on → off),
// the catalog (searched and paged on the server), the marketplaces, what the account syncs, and what
// is shared. Every change goes through plOp: one at a time, with the page locked while it runs.

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { get, post } from "../../api.ts";
import { status, useTopic } from "../../state.ts";
import { t } from "../../i18n.ts";
import { fmt, short } from "../../lib/format.ts";
import { showOutput, toast, toastErr } from "../../lib/ui.tsx";

/** One profile's view of a plugin: `override` is what that profile's own settings say (none = inherits). */
interface Cell {
  enabled: boolean;
  installed: boolean;
  broken?: boolean;
  version?: string;
  override?: boolean | null;
}
interface PluginRow {
  id: string;
  name: string;
  marketplace: string;
  synced?: boolean;
  shared?: boolean | null;
  profiles: Record<string, Cell>;
}
interface Marketplace {
  name: string;
  source: string;
  declared: boolean;
  known: string[];
}
interface PluginsView {
  profiles: string[];
  plugins: PluginRow[];
  marketplaces: Marketplace[];
  syncedSkills: Record<string, string[]>;
}
interface CatEntry {
  id: string;
  name: string;
  marketplace: string;
  description: string;
  installs?: number;
}
interface Catalog {
  total: number;
  entries: CatEntry[];
  marketplaces: string[];
}
interface OpResult {
  ok: boolean;
  message: string;
  log?: string[];
  confirm?: { command: string; sha256: string };
}
type Body = Record<string, unknown>;

// the first answer is a dozen entries, "Load more" asks for the next ones
const CAT_FIRST = 10, CAT_PAGE = 20;

/** The few tags the dictionary's notes carry (<b>, <code>, &lt; &gt;) as elements: never as HTML. */
function rich(s: string): ComponentChildren[] {
  return s.split(/(<b>.*?<\/b>|<code>.*?<\/code>)/).map((p) => {
    const m = /^<(b|code)>(.*)<\/\1>$/.exec(p);
    const text = (x: string) => x.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    return m ? (m[1] === "b" ? <b>{text(m[2])}</b> : <code>{text(m[2])}</code>) : text(p);
  });
}

// one operation at a time, whatever re-renders: the lock lives outside the component
let busy = false;

/** Runs one operation. A marketplace-declared command comes back as `confirm`: it is shown, and runs
 *  only if accepted here — the server never accepts one on its own. */
async function plOp(body: Body, label: string, reload: () => Promise<unknown>): Promise<void> {
  if (busy) return toast(t("pl.busy"), true);
  busy = true;
  document.body.classList.add("plbusy");
  toast(`${label}…`);
  try {
    let r = await post<OpResult>("/api/plugins", body);
    if (r.confirm) {
      if (!confirm(t("pl.confirmCmd", { msg: r.message, cmd: r.confirm.command }))) return toast(t("pl.notAccepted"));
      const retry = body.op === "set"
        ? {
          op: "install",
          id: body.id,
          profiles: body.target === "shared" ? "all" : [body.target],
          accept: r.confirm.sha256,
        }
        : { ...body, accept: r.confirm.sha256 };
      r = await post<OpResult>("/api/plugins", retry);
    }
    toast(r.message, !r.ok);
    if (!r.ok && r.log?.length) showOutput(r.message, r.log.join("\n"));
  } catch (e) {
    toastErr(e);
  } finally {
    busy = false;
    document.body.classList.remove("plbusy");
    await reload().catch(() => {});
  }
}

/** One toggle: `value` is the entry this source holds (true/false, or null/undefined = none). */
function Toggle({ id, target, value, cell, run }: {
  id: string;
  target: string;
  value: boolean | null | undefined;
  cell?: Cell;
  run: (b: Body, label: string) => void;
}) {
  const own = value === true || value === false;
  const on = cell ? cell.enabled : value === true;
  const state = (v: boolean) => t(v ? "pl.on" : "pl.off");
  const label = own ? state(value) : cell ? state(on) : "—";
  const title = own
    ? t("pl.setHere", { t: target, v: state(value) })
    : cell
    ? t("pl.inherits", { t: target, v: state(on) })
    : t("pl.notShared");
  const mark = !cell
    ? null
    : cell.broken
    ? <span class="inst bad" title={t("pl.broken")}>⚠</span>
    : cell.installed
    ? <span class="inst" title={t("pl.installed") + (cell.version ? ` · ${cell.version}` : "")}>●</span>
    : <span class="inst no" title={t("pl.notInstalled")}>○</span>;
  const click = () => {
    // inherit → on → off → inherit
    const next = own ? (value ? false : null) : true;
    const st = next === null ? t(target === "shared" ? "pl.opOutOfShared" : "pl.opInherit") : state(next);
    run({ op: "set", id, target, value: next }, t("pl.opSet", { id, state: st, t: target }));
  };
  return (
    <button type="button" class={`tg ${own ? "own" : "inh"} ${on ? "on" : "off"}`} title={title} onClick={click}>
      {mark}
      {label}
    </button>
  );
}

function details(id: string): void {
  showOutput(id, t("pl.loading"));
  get<{ text?: string }>(`/api/plugins/details?id=${encodeURIComponent(id)}`)
    .catch((e: Error) => ({ text: e.message }))
    .then((r) => showOutput(id, r.text || t("pl.noDetails")));
}

function PluginTable({ pl, run }: { pl: PluginsView | null; run: (b: Body, label: string) => void }) {
  const profs = pl?.profiles ?? [];
  const rows = (pl?.plugins ?? []).filter((r) => !r.synced);
  return (
    <table class="pl">
      <thead>
        <tr>
          <th>{t("pl.plugin")}</th>
          <th>{t("pl.all")}</th>
          {profs.map((p) => <th key={p}>{p}</th>)}
          <th></th>
        </tr>
      </thead>
      <tbody>
        {!pl
          ? <tr><td class="empty">{t("pl.loading")}</td></tr>
          : rows.length
          ? rows.map((r) => (
            <tr key={r.id}>
              <td>
                <span class="pname">{r.name}</span> <span class="dim">{r.marketplace}</span>
              </td>
              <td><Toggle id={r.id} target="shared" value={r.shared} run={run} /></td>
              {profs.map((p) => (
                <td key={p}><Toggle id={r.id} target={p} value={r.profiles[p].override} cell={r.profiles[p]} run={run} /></td>
              ))}
              <td class="acts">
                <button type="button" class="btn ghost sm" onClick={() => details(r.id)}>{t("pl.details")}</button>
                <button
                  type="button"
                  class="btn ghost sm"
                  onClick={() => run({ op: "update", id: r.id }, t("pl.opUpdating", { id: r.id }))}
                >
                  {t("pl.update")}
                </button>
                <button
                  type="button"
                  class="btn ghost sm danger"
                  onClick={() => {
                    if (confirm(t("pl.confirmRemove", { id: r.id }))) {
                      run({ op: "uninstall", id: r.id, profiles: "all" }, t("pl.opRemoving", { id: r.id }));
                    }
                  }}
                >
                  {t("pl.remove")}
                </button>
              </td>
            </tr>
          ))
          : <tr><td class="empty" colSpan={profs.length + 3}>{t("pl.none")}</td></tr>}
      </tbody>
    </table>
  );
}

function sumOf(pl: PluginsView | null): string {
  if (!pl) return "";
  const profs = pl.profiles;
  const rows = pl.plugins.filter((r) => !r.synced);
  const inst = rows.filter((r) => profs.some((p) => r.profiles[p].installed)).length;
  const broken = rows.filter((r) => profs.some((p) => r.profiles[p].broken)).length;
  return t("pl.sum", { n: rows.length, i: inst }) + (broken ? t("pl.sumBroken", { b: broken }) : "");
}

function CatalogRow({ c, pl, run }: { c: CatEntry; pl: PluginsView | null; run: (b: Body, label: string) => void }) {
  const [scope, setScope] = useState("all");
  const profs = pl?.profiles ?? [];
  const w = profs.filter((p) => pl?.plugins.find((r) => r.id === c.id)?.profiles[p]?.installed);
  return (
    <tr>
      <td class="cdesc">
        <span class="pname">{c.name}</span>{" "}
        <span class="dim">
          {c.marketplace}
          {c.installs ? ` · ${t("cat.installs", { n: fmt(c.installs) })}` : ""}
        </span>
        <div class="desc">{short(c.description, 220)}</div>
      </td>
      <td>
        {w.length > 0 && <span class="chip on" title={t("cat.installedOn", { p: w.join(", ") })}>{w.length}/{profs.length}</span>}
      </td>
      <td class="acts">
        {w.length > 0 && <button type="button" class="btn ghost sm" onClick={() => details(c.id)}>{t("pl.details")}</button>}
        <select class="sel" value={scope} onChange={(e) => setScope((e.target as HTMLSelectElement).value)}>
          <option value="all">{t("cat.allProfiles")}</option>
          {profs.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <button
          type="button"
          class="btn sm"
          onClick={() =>
            run(
              { op: "install", id: c.id, profiles: scope === "all" ? "all" : [scope] },
              t("pl.opInstalling", { id: c.id, where: scope === "all" ? t("pl.everyProfile") : scope }),
            )}
        >
          {t("pl.install")}
        </button>
      </td>
    </tr>
  );
}

function Account({ pl }: { pl: PluginsView | null }) {
  if (!pl) return null;
  const profs = pl.profiles;
  // only what an account really syncs today: shared keeps `false` entries for plugins long gone
  const synced = pl.plugins.filter((r) => r.synced && profs.some((p) => r.profiles[p].installed));
  return (
    <>
      <div class="acct-h">{t("acct.plugins")}</div>
      {synced.length
        ? synced.map((r) => (
          <div class="acct-row" key={r.id}>
            <span>{r.name}</span>
            <span class="chips">
              {profs.map((p) => (
                <span
                  key={p}
                  class={`chip${r.profiles[p].enabled ? " on" : ""}`}
                  title={`${p}: ${t(r.profiles[p].enabled ? "pl.on" : "pl.off")}`}
                >
                  {p}
                </span>
              ))}
            </span>
          </div>
        ))
        : <div class="dim">{t("pl.noProfile")}</div>}
      <div class="acct-h">{t("acct.skills")}</div>
      {profs.map((p) => {
        const sk = pl.syncedSkills[p] ?? [];
        return sk.length
          ? (
            <details class="acct-row" key={p}>
              <summary>
                <span>{p}</span>
                <span class="dim">{t("acct.skillsN", { n: sk.length })}</span>
              </summary>
              <div class="skl">{sk.join(" · ")}</div>
            </details>
          )
          : (
            <div class="acct-row" key={p}>
              <span>{p}</span>
              <span class="dim">{t("pl.noProfile")}</span>
            </div>
          );
      })}
      <p class="note">{rich(t("acct.note"))}</p>
    </>
  );
}

function Shared() {
  const s = status.value?.shared;
  if (!s) return null;
  return (
    <dl class="kv">
      <dt>{t("shared.skills")}</dt>
      <dd>{Object.keys(s.skills).length}</dd>
      <dt>{t("shared.agents")}</dt>
      <dd>{Object.keys(s.agents).length}</dd>
      <dt>{t("shared.commands")}</dt>
      <dd>{Object.keys(s.commands).length}</dd>
      <dt>{t("shared.hooks")}</dt>
      <dd>{s.hooks.length}</dd>
      <dt>{t("shared.rules")}</dt>
      <dd>{s.rules.join(", ") || "—"}</dd>
    </dl>
  );
}

export function Plugins() {
  const [pl, setPl] = useState<PluginsView | null>(null);
  const [cat, setCat] = useState<Catalog | null>(null);
  const [catLoading, setCatLoading] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [mk, setMk] = useState("");
  const seq = useRef(0);
  const catRef = useRef<Catalog | null>(null);
  const [source, setSource] = useState("");

  // a state event reloads the table, but not under an operation of ours (it reloads itself after)
  const loadPlugins = async (fresh = false) => {
    if (busy && !fresh) return;
    setPl(await get<PluginsView>("/api/plugins" + (fresh ? "?fresh" : "")));
  };
  /** Ask for a page: from the start (a new search or marketplace, or `fresh`) or the one after what is shown. */
  const loadCatalog = async (opts: { fresh?: boolean; more?: boolean; q?: string; mk?: string } = {}) => {
    const n = ++seq.current, cur = catRef.current;
    const offset = opts.more && cur ? cur.entries.length : 0;
    const qs = new URLSearchParams({
      q: (opts.q ?? q).trim(),
      mk: opts.mk ?? mk,
      offset: String(offset),
      limit: String(opts.more ? CAT_PAGE : CAT_FIRST),
    });
    if (opts.fresh) qs.set("fresh", "");
    setCatLoading(opts.more && cur ? cur.entries.length : 0);
    try {
      const r = await get<Catalog>("/api/plugins/catalog?" + qs);
      if (n !== seq.current) return; // a newer request owns the table
      const next = opts.more && cur ? { ...r, entries: [...cur.entries, ...r.entries] } : r;
      catRef.current = next;
      setCat(next);
      setCatLoading(null);
    } catch (e) {
      if (n === seq.current) setCatLoading(null);
      throw e;
    }
  };

  useTopic(() => loadPlugins().catch(toastErr), ["state"]);
  // the catalog: now, and again 120 ms after the last keystroke or a change of marketplace
  useEffect(() => {
    const id = setTimeout(() => loadCatalog().catch(toastErr), 120);
    return () => clearTimeout(id);
  }, [q, mk]);
  // leaving the page while an operation runs must not leave the lock class behind
  useEffect(() => () => document.body.classList.remove("plbusy"), []);

  const reloadAll = (fresh: boolean) => Promise.all([loadPlugins(true), fresh ? loadCatalog({ fresh: true }) : null]);
  const run = (body: Body, label: string) => plOp(body, label, () => loadPlugins(true));
  const runMk = (body: Body, label: string) => plOp(body, label, () => reloadAll(true));

  const page = cat?.entries ?? [];
  const total = cat?.total ?? 0;
  const profs = pl?.profiles ?? [];
  return (
    <div class="sub-view">
      <div class="panel">
        <div class="panel-h">
          <h3>{t("pl.title")}</h3>
          <span class="r">{sumOf(pl)}</span>
          <button type="button" class="btn" onClick={() => void reloadAll(true).catch(toastErr)}>{t("pl.refresh")}</button>
        </div>
        <div class="scroll">
          <PluginTable pl={pl} run={run} />
        </div>
        <div class="panel-f">{rich(t("pl.foot"))}</div>
      </div>

      <div class="panel" style={{ marginTop: "16px" }}>
        <div class="panel-h">
          <h3>{t("cat.title")}</h3>
          <input
            class="search"
            type="search"
            placeholder={t("cat.search")}
            autocomplete="off"
            value={q}
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          />
          <select class="sel" value={mk} onChange={(e) => setMk((e.target as HTMLSelectElement).value)}>
            <option value="">{t("cat.allMk")}</option>
            {(cat?.marketplaces ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <span class="r">
            {catLoading !== null ? t("cat.loadingN", { n: catLoading }) : cat ? t("cat.sum", { n: page.length, t: total }) : ""}
          </span>
        </div>
        <div class="scroll">
          <table class="cat">
            <tbody>
              {!cat
                ? <tr><td class="empty">{t("cat.loading")}</td></tr>
                : page.length || total > page.length
                ? (
                  <>
                    {page.map((c) => <CatalogRow key={c.id} c={c} pl={pl} run={run} />)}
                    {total > page.length && (
                      <tr>
                        <td class="empty" colSpan={3}>
                          <button
                            type="button"
                            class="btn ghost sm"
                            onClick={() => loadCatalog({ more: true }).catch(toastErr)}
                          >
                            {t("cat.more", { n: Math.min(CAT_PAGE, total - page.length) })}
                          </button>
                        </td>
                      </tr>
                    )}
                  </>
                )
                : <tr><td class="empty">{t("cat.nothing")}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div class="row c2">
        <div class="panel">
          <div class="panel-h">
            <h3>{t("mk.title")}</h3>
            <span class="r"><code>extraKnownMarketplaces</code></span>
            <button type="button" class="btn" onClick={() => void runMk({ op: "marketplace-update" }, t("mk.opUpdateAll"))}>
              {t("mk.updateAll")}
            </button>
          </div>
          <div class="scroll">
            <table class="mk">
              <tbody>
                {pl?.marketplaces.length
                  ? pl.marketplaces.map((m) => (
                    <tr key={m.name}>
                      <td>
                        <span class="pname">{m.name}</span> <span class="dim">{m.source}</span>
                      </td>
                      <td class="txt">
                        {m.declared
                          ? <span class="chip on">{t("mk.shared")}</span>
                          : <span class="chip" title={t("mk.localTitle")}>{t("mk.local")}</span>}
                      </td>
                      <td title={t("mk.known")}>{m.known.length}/{profs.length}</td>
                      <td class="acts">
                        <button
                          type="button"
                          class="btn ghost sm"
                          onClick={() => void runMk({ op: "marketplace-update", name: m.name }, t("pl.opUpdating", { id: m.name }))}
                        >
                          {t("pl.update")}
                        </button>
                        <button
                          type="button"
                          class="btn ghost sm danger"
                          onClick={() => {
                            if (confirm(t("mk.confirmRemove", { n: m.name }))) {
                              void runMk({ op: "marketplace-remove", name: m.name }, t("pl.opRemoving", { id: m.name }));
                            }
                          }}
                        >
                          {t("pl.remove")}
                        </button>
                      </td>
                    </tr>
                  ))
                  : pl
                  ? <tr><td class="empty">{t("mk.none")}</td></tr>
                  : null}
              </tbody>
            </table>
          </div>
          <form
            class="panel-f mkadd"
            onSubmit={(e) => {
              e.preventDefault();
              const s = source.trim();
              if (!s) return;
              void runMk({ op: "marketplace-add", source: s }, t("mk.opAdding", { s })).then(() => setSource(""));
            }}
          >
            <input
              class="search"
              placeholder={t("mk.source.ph")}
              required
              autocomplete="off"
              value={source}
              onInput={(e) => setSource((e.target as HTMLInputElement).value)}
            />
            <button class="btn" type="submit">{t("mk.add")}</button>
          </form>
        </div>
        <div class="panel">
          <div class="panel-h">
            <h3>{t("acct.title")}</h3>
            <span class="r">{t("acct.readOnly")}</span>
          </div>
          <div class="panel-b">
            <Account pl={pl} />
          </div>
        </div>
      </div>

      <div class="panel" style={{ marginTop: "16px" }}>
        <div class="panel-h">
          <h3>{t("shared.title")}</h3>
        </div>
        <div class="panel-b">
          <Shared />
        </div>
      </div>
    </div>
  );
}
