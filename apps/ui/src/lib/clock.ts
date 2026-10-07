// clock.ts — the minute, as a signal: the header's clock, the countdown to what is next and the line
// for now in the day move with it. One timer for the whole page, aligned on the minute.

import { signal } from "@preact/signals";

export const minute = signal(new Date());

function tick(): void {
  minute.value = new Date();
  setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
}
setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
