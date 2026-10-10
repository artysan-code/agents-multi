// markdown.tsx — Markdown to elements for the readers (brain pages, task descriptions, Claude's
// answers): the forms the wiki uses, enough to read a page well, not a renderer. Text stays text —
// nothing is parsed as HTML. Wikilinks call `onPage`, by default reading the page in the brain; web
// links open outside.

import type { ComponentChildren, VNode } from "preact";
import { request } from "../router.ts";

type OnPage = (target: string) => void;

const readInBrain: OnPage = (target) => request("brain.open", "brain", target);

interface Rule {
  re: RegExp;
  make: (m: RegExpExecArray, onPage?: OnPage) => ComponentChildren;
}

// the links and code come first, and their text is not read again; emphasis applies to what is left
const TOKENS: Rule[] = [
  { re: /`([^`]+)`/, make: (m) => <code>{m[1]}</code> },
  {
    re: /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/,
    make: (m, onPage) => {
      const target = m[1].trim();
      return (
        <a
          data-page={target}
          href="#"
          onClick={(e) => {
            e.preventDefault();
            (onPage ?? readInBrain)(target);
          }}
        >
          {m[2] ?? target.split("/").pop()}
        </a>
      );
    },
  },
  {
    re: /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/,
    make: (m) => <a href={m[2]} target="_blank" rel="noopener">{m[1]}</a>,
  },
  { re: /\[([^\]]+)\]\((?:<(.+?)>|([^)\s]+))\)/, make: (m) => <span class="lnk" title={m[2] ?? m[3]}>{m[1]}</span> },
];

const EMPHASIS: Rule[] = [
  { re: /\*\*([^*]+)\*\*/, make: (m) => <b>{m[1]}</b> },
  { re: /~~([^~]+)~~/, make: (m) => <s>{m[1]}</s> },
  { re: /(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/, make: (m) => [m[1], <i>{m[2]}</i>] },
];

/** Splits `s` on the earliest match of any rule, again and again; what no rule takes goes to `rest`. */
function scan(s: string, rules: Rule[], rest: (x: string) => ComponentChildren[], onPage?: OnPage): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  while (s) {
    let best: { m: RegExpExecArray; r: Rule } | null = null;
    for (const r of rules) {
      const m = r.re.exec(s);
      if (m && (!best || m.index < best.m.index)) best = { m, r };
    }
    if (!best) break;
    out.push(...rest(s.slice(0, best.m.index)), best.r.make(best.m, onPage));
    s = s.slice(best.m.index + best.m[0].length);
  }
  out.push(...rest(s));
  return out;
}

export function inline(s: string, onPage?: OnPage): ComponentChildren[] {
  const emph = (x: string) => (x ? scan(x, EMPHASIS, (y) => (y ? [y] : [])) : []);
  return scan(s, TOKENS, emph, onPage);
}

/** The block forms: headings, rules, lists (with task boxes and a depth), tables, quotes, fenced code. */
export function renderMarkdown(src: string, onPage?: OnPage): VNode[] {
  const out: VNode[] = [];
  type List = { kind: "ul" | "ol"; items: VNode[] };
  // set and cleared inside flush(), which narrowing cannot follow: hence the casts on reading
  let list = null as List | null;
  let table: VNode[] | null = null;
  let code: string[] | null = null;
  const flush = () => {
    if (list) out.push(list.kind === "ul" ? <ul>{list.items}</ul> : <ol>{list.items}</ol>);
    if (table) out.push(<table><tbody>{table}</tbody></table>);
    list = null;
    table = null;
  };
  for (const line of src.split("\n")) {
    if (code !== null) {
      if (line.startsWith("```")) {
        out.push(<pre>{code.join("\n")}</pre>);
        code = null;
      } else code.push(line);
      continue;
    }
    if (line.startsWith("```")) {
      flush();
      code = [];
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) {
      flush();
      const H = `h${Math.min(h[1].length, 4)}` as "h1" | "h2" | "h3" | "h4";
      out.push(<H>{inline(h[2], onPage)}</H>);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push(<hr />);
      continue;
    }
    const li = line.match(/^\s*(?:([-*+])|(\d+)[.)])\s+(.*)/);
    if (li) {
      const kind = li[2] ? "ol" : "ul";
      if ((list as List | null)?.kind !== kind) {
        flush();
        list = { kind, items: [] };
      }
      const box = li[3].match(/^\[([ xX])\]\s+(.*)/);
      // a nested item keeps its depth (two spaces a level), without building nested lists
      const depth = Math.min(Math.floor(line.match(/^\s*/)![0].replace(/\t/g, "  ").length / 2), 4);
      const style = depth ? { "--lv": depth } : undefined;
      list!.items.push(
        box
          ? (
            <li class={`task${box[1] !== " " ? " done" : ""}`} style={style}>
              <span class="cb">{box[1] !== " " ? "✓" : ""}</span>
              {inline(box[2], onPage)}
            </li>
          )
          : <li style={style}>{inline(li[3], onPage)}</li>,
      );
      continue;
    }
    if (/^\|.*\|\s*$/.test(line)) {
      if (/^\|[\s:|-]+\|\s*$/.test(line)) continue;
      if (!table) {
        flush();
        table = [];
      }
      table.push(<tr>{line.trim().slice(1, -1).split("|").map((c) => <td>{inline(c.trim(), onPage)}</td>)}</tr>);
      continue;
    }
    flush();
    if (line.startsWith(">")) out.push(<blockquote>{inline(line.replace(/^>\s?/, ""), onPage)}</blockquote>);
    else if (line.trim()) out.push(<p>{inline(line, onPage)}</p>);
  }
  flush();
  if (code) out.push(<pre>{(code as string[]).join("\n")}</pre>);
  return out;
}

export function Markdown({ src, onPage, class: cls = "md" }: { src: string; onPage?: OnPage; class?: string }) {
  return <div class={cls}>{renderMarkdown(src, onPage)}</div>;
}
