// window.ts — what a page shown by the desktop app in a small window of its own (#pick, #hey) says to
// that window. The page has no IPC: it says it through its title, which the app watches on that window
// only (picker.rs, hey.rs; the main window answers the reauth one, main.rs). In a browser a title is harmless.

/** Tells the app the console no longer accepts this page's token (the main window enters again). The
 *  page that comes back has a new one; a browser has no app to ask, and its title is harmless. */
export function askToEnterAgain(): void {
  document.title = "agents-multi:reauth";
}

/** Asks the app to close the window. */
export function closeWindow(): void {
  document.title = "agents-multi:close";
}

/** Tells the app the page's height, and whether an answer is on screen (the window then stays open
 *  when the focus leaves it). */
export function sizeWindow(height: number, answer: boolean): void {
  document.title = `agents-multi:size=${Math.ceil(height)}${answer ? ",answer" : ""}`;
}
