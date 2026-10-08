// pcolor.ts — a profile's colour: the same profile has the same colour on every page and in the
// picker. It comes from a hash of the name; profiles that would share one take the next free colour,
// in name order, so a machine's profiles stay apart. No imports: the tests read it as it is.

export const PROFILE_COLORS = [
  "blue",
  "violet",
  "green",
  "rose",
  "amber",
  "teal",
] as const;

/** FNV-1a: small, stable, and spreads short names well. */
export function hashName(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** The colour index of each of `names`: its hash's, unless an earlier name (in sorted order) took it. */
export function profileColors(names: string[]): Record<string, number> {
  const n = PROFILE_COLORS.length,
    out: Record<string, number> = {},
    used = new Set<number>();
  for (const name of [...new Set(names)].sort()) {
    let i = hashName(name) % n;
    for (let k = 0; k < n && used.has(i); k++) i = (i + 1) % n;
    used.add(i);
    out[name] = i;
  }
  return out;
}

/** The CSS colour of `name` among `names` (a name outside them gets its hash's colour). */
export function profileColor(name: string, names: string[]): string {
  const i = profileColors(names)[name] ??
    hashName(name) % PROFILE_COLORS.length;
  return `var(--c-${PROFILE_COLORS[i]})`;
}
