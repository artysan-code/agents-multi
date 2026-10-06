// What moves on the landing once the page is read: sections rising into view, the console's window
// straightening as you scroll, its views taking turns, the terminal typing itself. Nothing here is
// needed to read the page, and none of it runs for reduced motion.
import { animate, inView, scroll, stagger } from "motion";

const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const ease = [0.2, 0.7, 0.2, 1] as const;

if (!still) {
  // rising into view: a grid's cards one after the other
  for (const group of document.querySelectorAll<HTMLElement>(".grid, .points, .steps ol, .principles")) {
    const items = group.querySelectorAll<HTMLElement>(".reveal");
    inView(group, () => { animate(items, { opacity: [0, 1], y: [28, 0] }, { duration: 0.7, delay: stagger(0.08), ease }); }, { amount: 0.2 });
  }
  for (const el of document.querySelectorAll<HTMLElement>(".orbit.reveal, .call .reveal, .terminal.reveal")) {
    inView(el, () => { animate(el, { opacity: [0, 1], y: [36, 0], scale: [0.97, 1] }, { duration: 0.9, ease }); }, { amount: 0.25 });
  }

  // the window straightens as the hero scrolls away
  const win = document.querySelector<HTMLElement>("[data-mock]");
  if (win) {
    win.addEventListener("animationend", () => {
      scroll(animate(win, { rotateX: [8, 0], scale: [1, 1.02] }, { ease: "linear" }), { target: win, offset: ["start end", "center center"] });
    }, { once: true });
  }

  // the console's views take turns, and a click on the rail picks one
  const views = [...document.querySelectorAll<HTMLElement>("[data-view]")];
  const tabs = [...document.querySelectorAll<HTMLElement>("[data-tab]")];
  let shown = 0, timer = 0;
  const show = (i: number) => {
    if (i === shown) return;
    const from = views[shown], to = views[i];
    animate(from, { opacity: 0, y: -8 }, { duration: 0.25 }).then(() => {
      from.classList.remove("on"); from.setAttribute("aria-hidden", "true");
      to.classList.add("on"); to.removeAttribute("aria-hidden");
      animate(to, { opacity: [0, 1], y: [10, 0] }, { duration: 0.45, ease });
      if (i === 2) animate(to.querySelectorAll("circle"), { scale: [0, 1] }, { delay: stagger(0.04), type: "spring", bounce: 0.45 });
      if (i === 1) animate(to.querySelectorAll(".kcard"), { opacity: [0, 1], x: [-12, 0] }, { delay: stagger(0.08) });
    });
    tabs.forEach((t, k) => t.classList.toggle("on", k === i));
    shown = i;
  };
  const cycle = () => { clearInterval(timer); timer = setInterval(() => show((shown + 1) % views.length), 4800); };
  tabs.forEach((t, i) => t.addEventListener("click", () => { show(i); cycle(); }));
  setTimeout(cycle, 4200);

  // the terminal types itself, a line at a time, when it comes into view
  const pre = document.querySelector<HTMLElement>("pre[data-type]");
  if (pre) {
    const lines = pre.innerHTML.split("\n");
    pre.innerHTML = lines.map((l) => `<span class="ln">${l || " "}</span>`).join("\n");
    const lns = pre.querySelectorAll<HTMLElement>(".ln");
    inView(pre, () => { animate(lns, { opacity: [0, 1] }, { duration: 0.01, delay: stagger(0.22, { startDelay: 0.3 }) }); }, { amount: 0.4 });
  }
}
