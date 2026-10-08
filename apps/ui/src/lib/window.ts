// window.ts — what a page shown by the desktop app in a small window of its own (#pick, #hey) says to
// that window. The page has no IPC: it says it through its title, which the app watches on that window
// only (picker.rs, hey.rs). In a browser a title is harmless.

/** Asks the app to close the window. */
export function closeWindow(): void {
  document.title = "agents-multi:close";
}

/** Tells the app the page's height, and whether an answer is on screen (the window then stays open
 *  when the focus leaves it). */
export function sizeWindow(height: number, answer: boolean): void {
  document.title = `agents-multi:size=${Math.ceil(height)}${answer ? ",answer" : ""}`;
}
