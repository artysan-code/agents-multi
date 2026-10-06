// json-patch.ts — JSON values compared regardless of key order, and RFC 7386 merge patches: how a
// person's settings and server choices are layered over the shared ones.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Obj = { [k: string]: Json };

export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
/** Key order is not meaning: Claude Code may rewrite the file with its keys in another order. */
const canon = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canon)
    : isObj(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
    : v;
export const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/** RFC 7386: apply a merge patch. Never mutates its inputs. */
export function mergePatch(target: Json | undefined, patch: Json): Json {
  if (!isObj(patch)) return structuredClone(patch);
  const out: Obj = isObj(target) ? structuredClone(target) : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

/** The smallest merge patch that turns `from` into `to` (both objects). Arrays are compared whole:
 *  a merge patch can only replace them. */
export function diffPatch(from: Obj, to: Obj): Obj {
  const out: Obj = {};
  for (const k of Object.keys(from)) if (!(k in to)) out[k] = null;
  for (const [k, v] of Object.entries(to)) {
    const f = from[k];
    if (same(f, v)) continue;
    out[k] = isObj(f) && isObj(v) ? diffPatch(f, v) : structuredClone(v);
  }
  return out;
}
