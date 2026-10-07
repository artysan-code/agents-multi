// Tests for the console's profile colours (apps/ui/src/lib/pcolor.ts): the same name gets the same
// colour, and a machine's profiles never share one while there are colours enough.
import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { hashName, PROFILE_COLORS, profileColor, profileColors } from "../../ui/src/lib/pcolor.ts";

Deno.test("profileColors: stable, whatever the order the names come in", () => {
  assertEquals(profileColors(["work", "lab", "home"]), profileColors(["home", "work", "lab"]));
  assertEquals(hashName("work"), hashName("work"));
});

Deno.test("profileColors: distinct while there are colours enough", () => {
  const names = ["a", "b", "c", "d", "e", "f"];
  const got = Object.values(profileColors(names));
  assertEquals(new Set(got).size, PROFILE_COLORS.length);
});

Deno.test("profileColors: a collision takes the next free colour", () => {
  // two names whose hashes land on the same colour
  const n = PROFILE_COLORS.length;
  const first = "p0";
  let second = "";
  for (let i = 1; !second; i++) if (hashName(`p${i}`) % n === hashName(first) % n) second = `p${i}`;
  const c = profileColors([first, second]);
  assertNotEquals(c[first], c[second]);
});

Deno.test("profileColor: a CSS colour, also for a name outside the list", () => {
  assertEquals(profileColor("x", ["x"]).startsWith("var(--c-"), true);
  assertEquals(profileColor("ghost", []), `var(--c-${PROFILE_COLORS[hashName("ghost") % PROFILE_COLORS.length]})`);
});
