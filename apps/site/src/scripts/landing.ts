// What moves on the landing once the page is read: sections rising into view, the console's views
// taking turns, the terminal typing itself. Nothing here is needed to read the page: the content is
// hidden for its entrance only once this module runs (the `js` class), and none of it runs for
// reduced motion. The window straightening on scroll is CSS (animation-timeline, site.css).
import { animate } from "motion/mini";
import { inView, stagger } from "motion";

const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const ease: [number, number, number, number] = [0.2, 0.7, 0.2, 1];
const rise = (d: number) => ({ opacity: [0, 1], transform: [`translateY(${d}px)`, "none"] });

if (!still) {
  document.documentElement.classList.add("js");

  // rising into view: a group's items one after the other
  for (const group of document.querySelectorAll<HTMLElement>(".grid, .points, .steps ol, .principles")) {
    const items = group.querySelectorAll<HTMLElement>(".reveal");
    inView(group, () => { animate(items, rise(28), { duration: 0.7, delay: stagger(0.08), ease }); }, { amount: 0.2 });
  }
  for (const el of document.querySelectorAll<HTMLElement>(".orbit.reveal, .call .reveal, .terminal.reveal")) {
    inView(el, () => { animate(el, rise(36), { duration: 0.9, ease }); }, { amount: 0.25 });
  }

  // the terminal types itself, a line at a time, when it comes into view. Each line of the <pre>
  // closes its own spans (Landing.astro), so wrapping lines keeps the markup whole.
  const pre = document.querySelector<HTMLElement>("pre[data-type]");
  if (pre) {
    pre.innerHTML = pre.innerHTML.split("\n").map((l) => `<span class="ln">${l || " "}</span>`).join("\n");
    const lns = pre.querySelectorAll<HTMLElement>(".ln");
    inView(pre, () => { animate(lns, { opacity: [0, 1] }, { duration: 0.01, delay: stagger(0.22, { startDelay: 0.3 }) }); }, { amount: 0.4 });
  }
}
