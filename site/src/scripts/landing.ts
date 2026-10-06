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

  // the console's views take turns; the classes change at once, only the entrance is animated, so a
  // view and the rail can never disagree
  const views = [...document.querySelectorAll<HTMLElement>("[data-view]")];
  const tabs = [...document.querySelectorAll<HTMLElement>("[data-tab]")];
  let shown = 0;
  const show = (i: number) => {
    views.forEach((v, k) => v.classList.toggle("on", k === i));
    tabs.forEach((t, k) => t.classList.toggle("on", k === i));
    const to = views[i];
    animate(to, rise(10), { duration: 0.45, ease });
    if (i === 1) animate(to.querySelectorAll(".kcard"), { opacity: [0, 1], transform: ["translateX(-12px)", "none"] }, { duration: 0.4, delay: stagger(0.08) });
    if (i === 2) animate(to.querySelectorAll("circle"), { transform: ["scale(0)", "scale(1)"] }, { duration: 0.5, delay: stagger(0.04), ease: [0.3, 1.6, 0.5, 1] });
    shown = i;
  };
  // only while the window is on screen
  let timer: ReturnType<typeof setInterval> | undefined;
  const mock = document.querySelector<HTMLElement>("[data-mock]");
  if (mock && views.length) {
    inView(mock, () => {
      timer = setInterval(() => show((shown + 1) % views.length), 4800);
      return () => clearInterval(timer);
    }, { amount: 0.3 });
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
