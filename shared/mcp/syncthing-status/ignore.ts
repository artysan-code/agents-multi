// Semantica dei pattern .stignore, separata dal server MCP così i test la importano senza avviarlo.
//
// Compila un pattern .stignore in regex con la semantica Syncthing:
//  '*' NON attraversa '/', '**' sì, '**/' anche zero directory ('**/.git' matcha '.git' in radice),
//  '?' = un char non-'/'; pattern rooted ('/x') o con '/' ancorato alla radice, altrimenti matcha
//  il basename a qualunque livello; flag (?d)/(?i) e negazione '!' gestiti. Il trailing (/|$) fa sì
//  che un pattern-dir matchi anche i discendenti.
//
// Va nutrito con i pattern ESPANSI (`/rest/db/ignores` → `.expanded`), mai con le righe grezze
// (`.ignore`): da quando ogni .stignore è solo `#include .stignore-common` le righe grezze non
// contengono nessuna regola, e tutto risulterebbe "non ignorato".
export type Compiled = { re: RegExp; negate: boolean };
export function compilePattern(raw: string): Compiled | null {
  const stripFlags = (x: string) => x.replace(/^(\(\?[a-z]\))+/i, "");
  let s = raw.trim();
  if (!s || s.startsWith("//") || s.startsWith("#")) return null;
  s = stripFlags(s);
  let negate = false;
  if (s.startsWith("!")) {
    negate = true;
    s = s.slice(1);
  }
  s = stripFlags(s);
  if (!s) return null;
  const rooted = s.startsWith("/");
  if (rooted) s = s.replace(/^\/+/, "");
  const anchored = rooted || s.includes("/");
  let rx = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "*") {
      if (s[i + 1] === "*" && s[i + 2] === "/") {
        rx += "(?:.*/)?";
        i += 2;
      } else if (s[i + 1] === "*") {
        rx += ".*";
        i++;
      } else rx += "[^/]*";
    } else if (c === "?") rx += "[^/]";
    else rx += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return { re: new RegExp((anchored ? "^" : "(^|.*/)") + rx + "(/|$)"), negate };
}
// first-match-wins: il primo pattern che matcha decide (negato '!' => NON ignorato).
export function isIgnored(rel: string, compiled: Compiled[]): boolean {
  for (const c of compiled) if (c.re.test(rel)) return !c.negate;
  return false;
}
