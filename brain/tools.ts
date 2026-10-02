// tools.ts — what Claude can do with the brain, as MCP tools: find, read, write and look back
// through the documents, plus the task tools (shared/mcp/tasks/tools.ts) on the tasks kept here.
//
// Every tool says plainly whether it only reads or changes something (annotations), so a client
// that asks before changes — claude.ai's "needs approval" — asks for exactly those.

import { McpServer } from "npm:@modelcontextprotocol/sdk@^1.18/server/mcp.js";
import { z } from "npm:zod@^3.23";
import { registerTaskTools } from "../shared/mcp/tasks/tools.ts";
import { linksIn, type Store } from "./store.ts";
import { type EmbedConfig, fuse, searchMeaning } from "./embed.ts";
import { AREAS, areaOf, check, LOGS, MAX_WORDS, relink, slugPath } from "./rules.ts";
import { dayOf, hhmm } from "../shared/mcp/lib/tasks.ts";

/** How the brain is used and written, for every Claude connected to it; then who Samuel is, from
 *  io/, so each conversation starts knowing him. */
export function instructions(store: Store): string {
  const rules =
    "Samuel's brain: his memory and his tasks, the same from every Claude he uses. Six areas: io/ (who he is, how he works), " +
    "progetti/ (one page per project, the same path as his folder: progetti/work/acme/site.md), persone/ (people and companies), " +
    "note/ (how things are done: setups, fixes, procedures), diario/ (what happened, one page a day, only added to), inbox/ (said in passing, to sort). " +
    "Before assuming anything about Samuel, his projects or tools, search here (brain_search) and read what you find. " +
    `Write without asking, by these rules (the brain refuses what breaks them, with the reason): one subject per page, at most ${MAX_WORDS} words; ` +
    "it starts with '# Title' and one sentence saying what it is; it links at least one existing page with [[path]]; search before creating, and update " +
    "a page rather than making a near copy. Write only what lasts: decisions, state, how things are done, preferences, who is who; never work steps, " +
    "transcripts, what the code already says, secrets or clients' data. While working, add one line to today's diary (brain_append) linking the project; " +
    "when the state of a project changes, update its page. Change io/ only when Samuel says something about himself, never by inference. " +
    "Italian. Say in one line what you wrote.";
  const io = store.db.prepare("select path, title, body from docs where deleted = 0 and path like 'io/%' order by path").all() as { path: string; title: string; body: string }[];
  if (!io.length) return rules;
  // each io page by its title and what stands above its first "## ": the part meant for every
  // conversation; the sections below (a contract, details) are a brain_read away
  const portrait = io.map((d) => {
    const top = d.body.replace(/^---\n[\s\S]*?\n---\n?/, "").replace(/^# .*\n+/, "").split(/\n## /)[0].replace(/\s+/g, " ").trim();
    return `${d.title} (${d.path}): ${top.slice(0, 900)}`;
  }).join("\n").slice(0, 4000);
  return `${rules}\n\nWho Samuel is (from io/, read the pages for more):\n${portrait}`;
}

const text = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }] });
const READ = { readOnlyHint: true, openWorldHint: false };
const CHANGE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

/** The projects a diary line names whose page is older than an earlier line about them today:
 *  the diary moved on and the page did not. A reminder, not a refusal. */
export function staleProjects(store: Store, diary: string, line: string, now: Date): { reminder?: string } {
  const day = dayOf(now);
  const stale: string[] = [];
  for (const t of linksIn(line)) {
    const proj = store.resolve(t);
    if (!proj?.startsWith("progetti/")) continue;
    const updated = store.get(proj)?.updated;
    if (!updated) continue;
    const name = proj.replace(/\.md$/, "");
    // the earlier lines of today's page that link this project, by the time they carry
    const earlier = diary.split("\n").filter((l) => /^- \d{2}:\d{2} /.test(l) && l.includes(`[[${name}`) && !l.includes(line.trim().split("\n")[0]));
    const after = earlier.some((l) => new Date(`${day}T${l.slice(2, 7)}:00`) > new Date(updated));
    if (after) stale.push(proj);
  }
  return stale.length ? { reminder: `${stale.join(", ")}: the diary has moved on since the page was last updated. If the state changed, update the page (brain_edit).` } : {};
}

export interface ToolContext { store: Store; embed: EmbedConfig; by: () => string; changed: () => void }

/** Words and meaning together; when the model is unreachable, words alone, and the answer says so. */
export async function search(ctx: ToolContext, query: string, limit = 10, tasks = false) {
  const words = ctx.store.searchWords(query, 30, tasks);
  let meaning: Awaited<ReturnType<typeof searchMeaning>> = [], note: string | undefined;
  try { meaning = await searchMeaning(ctx.store, ctx.embed, query, 30, tasks); } catch (e) { note = `meaning search unavailable (${(e as Error).message}): words only`; }
  const order = fuse([words.map((w) => w.path), meaning.map((m) => m.path)]).slice(0, limit);
  const results = order.map((path) => {
    const w = words.find((x) => x.path === path), m = meaning.find((x) => x.path === path);
    const title = w?.title ?? ctx.store.get(path)?.title ?? path;
    return { path, title, excerpt: w?.snippet ?? m?.text.slice(0, 300) ?? "" };
  });
  return { results, ...(note ? { note } : {}) };
}

export function brainServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "brain", version: "0.2.0" }, { instructions: instructions(ctx.store) });
  const { store } = ctx;
  /** A write the rules refuse comes back as the reasons, for the writer to fix. */
  const refuse = (errors: string[], extra: Record<string, unknown> = {}) => text({ refused: true, errors, ...extra });

  server.registerTool("brain_search", {
    description: "Search Samuel's memory by words and by meaning. Returns paths, titles and an excerpt: read the documents that matter with brain_read.",
    inputSchema: { query: z.string(), limit: z.number().int().min(1).max(50).optional(), include_tasks: z.boolean().optional() },
    annotations: READ,
  }, async ({ query, limit, include_tasks }: { query: string; limit?: number; include_tasks?: boolean }) => text(await search(ctx, query, limit, include_tasks)));

  server.registerTool("brain_read", {
    description: "A document in full: its Markdown, its revision number (pass it as base_rev when you change it), and its links both ways. With rev, how it was then.",
    inputSchema: { path: z.string(), rev: z.number().int().min(1).optional() },
    annotations: READ,
  }, ({ path, rev }: { path: string; rev?: number }) => {
    if (rev) {
      const r = store.revision(path, rev);
      if (!r) throw new Error(`no version ${rev} of ${path}`);
      return text(r);
    }
    const d = store.get(path) ?? (store.resolve(path) ? store.get(store.resolve(path)!) : null);
    if (!d) throw new Error(`no document ${path}: search for it with brain_search, or list a folder with brain_list`);
    return text({ ...d, links: store.links(d.path) });
  });

  server.registerTool("brain_list", {
    description: "The documents under a folder (everything when no folder), newest first: path, title, revision, when and by whom.",
    inputSchema: { folder: z.string().optional(), limit: z.number().int().min(1).max(1000).optional() },
    annotations: READ,
  }, ({ folder, limit }: { folder?: string; limit?: number }) => {
    const prefix = folder ? folder.replace(/^\/+|\/+$/g, "") + "/" : "";
    return text({ folder: prefix || "/", documents: store.list(prefix, { limit: limit ?? 200 }) });
  });

  server.registerTool("brain_write", {
    description: "Create a page, or replace one whole. The path is normalised (lower case, no accents) and must be in one of the six areas. " +
      "To replace, read it first and pass its rev as base_rev. The rules are checked: a refusal lists what to fix. The previous version is kept (brain_history). " +
      "Diary and inbox are added to with brain_append, not rewritten.",
    inputSchema: {
      path: z.string().describe(`${AREAS.join("|")}/name.md (progetti/ follows the folder: progetti/work/acme/site.md)`),
      body: z.string().describe("the whole Markdown: '# Title', one sentence saying what it is, then the content with [[links]]"),
      base_rev: z.number().int().min(0).optional().describe("the rev you read; 0 to create only if it does not exist"),
      distinct: z.boolean().optional().describe("true when a page with a similar title exists and this really is another subject"),
    },
    annotations: CHANGE,
  }, ({ path, body, base_rev, distinct }: { path: string; body: string; base_rev?: number; distinct?: boolean }) => {
    const p = slugPath(path);
    const cur = store.get(p);
    if (cur && LOGS.includes(areaOf(p))) return refuse([`${p} is only added to: use brain_append`]);
    const v = check(store, p, body, { creating: !cur, distinct });
    if (!v.ok) return refuse(v.errors, v.similar ? { similar: v.similar } : {});
    const d = store.write(p, body, ctx.by(), base_rev);
    ctx.changed();
    return text({ written: d.path, rev: d.rev, title: d.title });
  });

  server.registerTool("brain_edit", {
    description: "Change part of a document: replace one exact passage with another (it must occur exactly once). Cheaper and safer than rewriting the whole document.",
    inputSchema: { path: z.string(), find: z.string().min(1), replace: z.string(), base_rev: z.number().int().min(1).optional() },
    annotations: CHANGE,
  }, ({ path, find, replace, base_rev }: { path: string; find: string; replace: string; base_rev?: number }) => {
    const d = store.get(path) ?? store.get(slugPath(path));
    if (!d) throw new Error(`no document ${path}`);
    if (LOGS.includes(areaOf(d.path))) return refuse([`${d.path} is only added to: use brain_append`]);
    const n = d.body.split(find).length - 1;
    if (n !== 1) throw new Error(n ? `the passage occurs ${n} times: include more context` : "the passage is not in the document: read it again");
    const next = d.body.replace(find, () => replace);
    const v = check(store, d.path, next, { creating: false });
    if (!v.ok) return refuse(v.errors);
    const w = store.write(d.path, next, ctx.by(), base_rev ?? d.rev);
    ctx.changed();
    return text({ edited: w.path, rev: w.rev });
  });

  server.registerTool("brain_delete", {
    description: "Remove a document from the brain. Its history stays, and brain_restore brings it back.",
    inputSchema: { path: z.string() },
    annotations: { ...CHANGE, destructiveHint: true },
  }, ({ path }: { path: string }) => {
    store.remove(path, ctx.by());
    ctx.changed();
    return text({ removed: path });
  });

  server.registerTool("brain_history", {
    description: "The versions of a document: revision, when, by whom (Samuel, or Claude from which client), and what happened.",
    inputSchema: { path: z.string() },
    annotations: READ,
  }, ({ path }: { path: string }) => text({ path, versions: store.history(path) }));

  server.registerTool("brain_restore", {
    description: "Put an earlier version of a document back (as a new version on top: nothing is lost).",
    inputSchema: { path: z.string(), rev: z.number().int().min(1) },
    annotations: CHANGE,
  }, ({ path, rev }: { path: string; rev: number }) => {
    const d = store.restore(path, rev, ctx.by());
    ctx.changed();
    return text({ restored: d.path, from: rev, rev: d.rev });
  });

  server.registerTool("brain_append", {
    description: "Add a line to today's diary (what happened, what was decided: link the project with [[progetti/…]]), or to the inbox " +
      "(something said in passing, to sort later). The page is created when it does not exist; lines are timed and never rewritten.",
    inputSchema: {
      where: z.enum(["diario", "inbox"]).optional().describe("default diario"),
      text: z.string().min(1).max(1000).describe("one line, or a few"),
    },
    annotations: CHANGE,
  }, ({ where, text: line }: { where?: "diario" | "inbox"; text: string }) => {
    const now = new Date(), day = dayOf(now);
    const p = where === "inbox" ? "inbox/inbox.md" : `diario/${day}.md`;
    const cur = store.get(p);
    const head = where === "inbox" ? "# Inbox\n\nCose dette al volo, da sistemare nelle pagine giuste e poi togliere da qui.\n"
      : `# ${day}\n\nCosa è successo il ${now.toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}.\n`;
    const entry = line.trim().split("\n").map((l, i) => i ? `  ${l.trim()}` : `- ${where === "inbox" ? day + " " : ""}${hhmm(now)} ${l.trim()}`).join("\n");
    const body = `${(cur?.body ?? head).replace(/\s+$/, "")}\n${cur ? "" : "\n"}${entry}\n`;
    const v = check(store, p, body, { creating: !cur });
    if (!v.ok) return refuse(v.errors);
    const d = store.write(p, body, ctx.by(), cur?.rev ?? 0);
    ctx.changed();
    return text({ added: d.path, rev: d.rev, ...(where === "inbox" ? {} : staleProjects(store, body, line, now)) });
  });

  server.registerTool("brain_inbox_clear", {
    description: "Take lines out of the inbox once they have found their place in a page (give the exact lines, or a part that identifies each).",
    inputSchema: { lines: z.array(z.string().min(3)).min(1) },
    annotations: CHANGE,
  }, ({ lines }: { lines: string[] }) => {
    const cur = store.get("inbox/inbox.md");
    if (!cur) throw new Error("the inbox is empty");
    const kept = cur.body.split("\n").filter((l) => !(l.startsWith("- ") && lines.some((x) => l.includes(x.trim()))));
    const removed = cur.body.split("\n").length - kept.length;
    if (!removed) throw new Error("none of those lines is in the inbox: read it again");
    const d = store.write(cur.path, kept.join("\n"), ctx.by(), cur.rev);
    ctx.changed();
    return text({ removed, rev: d.rev });
  });

  server.registerTool("brain_move", {
    description: "Move or rename a page; every link that pointed at it is updated to the new path (each changed page gets a new version).",
    inputSchema: { from: z.string(), to: z.string() },
    annotations: CHANGE,
  }, ({ from, to }: { from: string; to: string }) => {
    const d = store.get(from) ?? store.get(slugPath(from));
    if (!d) throw new Error(`no document ${from}`);
    const dest = slugPath(to);
    if (store.get(dest)) throw new Error(`${dest} exists already`);
    const v = check(store, dest, d.body, { creating: false });
    if (!v.ok) return refuse(v.errors);
    // the pages that link here, found before the move while their links still resolve to the old path
    const back = store.links(d.path).back;
    const resolveOld = (t: string) => store.resolve(t);
    const rewritten = back.map((src) => ({ src, body: relink(store.get(src)!.body, d.path, dest, resolveOld) }));
    store.write(dest, d.body, ctx.by());
    store.remove(d.path, ctx.by());
    for (const r of rewritten) {
      const cur = store.get(r.src === d.path ? dest : r.src);
      if (cur && cur.body !== r.body) store.write(cur.path, r.body, ctx.by(), cur.rev);
    }
    ctx.changed();
    return text({ moved: d.path, to: dest, links_updated: rewritten.map((r) => r.src) });
  });

  server.registerTool("brain_check", {
    description: "The brain's health against its rules: pages nothing links to, links to pages that do not exist, pages over the length limit, " +
      "inbox lines older than a week. Run it now and then and fix what it finds.",
    inputSchema: {},
    annotations: READ,
  }, () => {
    const pages = store.list("", { limit: 100000 });
    const linked = new Set<string>(), broken: { page: string; link: string }[] = [], long: { page: string; words: number }[] = [];
    for (const p of pages) {
      const body = store.get(p.path)!.body;
      for (const l of store.links(p.path).out) {
        if (l.path) linked.add(l.path); else broken.push({ page: p.path, link: l.target });
      }
      const n = (body.match(/[\p{L}\p{N}]+/gu) ?? []).length;
      if (n > (LOGS.includes(areaOf(p.path)) ? 1000 : MAX_WORDS)) long.push({ page: p.path, words: n });
    }
    const orphans = pages.filter((p) => !linked.has(p.path) && !["io", "diario", "inbox"].includes(areaOf(p.path))).map((p) => p.path);
    const weekAgo = dayOf(new Date(Date.now() - 7 * 86400_000));
    const stale = (store.get("inbox/inbox.md")?.body.split("\n") ?? []).filter((l) => /^- \d{4}-\d{2}-\d{2}/.test(l) && l.slice(2, 12) < weekAgo);
    const outside = pages.filter((p) => !AREAS.includes(areaOf(p.path))).map((p) => p.path);
    return text({ pages: pages.length, orphans, broken_links: broken, too_long: long, inbox_older_than_a_week: stale, outside_the_areas: outside });
  });

  registerTaskTools(server);
  return server;
}
