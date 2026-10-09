---
title: The console
description: A local web app that shows what every profile is doing.
---

The desktop app runs the console, so it is at <http://127.0.0.1:7331> while the app is open; its
window shows it. On a headless box `agents serve` runs it alone, and over an ssh tunnel it works the
same.

Updates are **pushed, not polled**: the server watches the transcripts and the shared configuration,
asks the brain whether its tasks or pages moved, and the page redraws the view you are looking at. It
is Preact and TypeScript, built once with the release and carried by the app (from a checkout, built
with pnpm on the machine); nothing is loaded from elsewhere, so it renders on a machine that has never been
online. English or Italian, following the machine's locale.

## Sections

A rail on the left holds every page: its icons open into names while the pointer is on it. At its
foot, the machine's health (green, yellow or red, it opens the Health page), the update when one is
waiting, the commands and the preferences.

- **Today** — the bar to ask Claude; the day as the main card, an agenda with the hours down the card
  for the appointments and the tasks with a time (those due today without a time in a strip above it);
  beside it the tasks as a plain list, and **Claude now**:
  each account's usage limits (the five hours and the week) with today's tokens, and how much context
  each running session uses, then the last sessions per directory with the command that reopens each one.
- **Tasks** — a board, a sortable list, a month calendar with the Google events, a board per project.
- **Brain** — the brain's pages as a tree, search by words and by meaning, every version, the links
  both ways, and the whole brain as a live graph.
- **Connections** — every MCP server, which profiles see it, and whether each one mounted it.
- **System** — profiles, permissions, plugins and skills, updates, and every doctor check with its fix.

`Ctrl-K` opens a command palette with every view and every action.

The bar to ask Claude has nothing to choose: Claude works out whether you ask something, say
something to do (it becomes a task, with a time when one fits your day) or tell something worth
remembering (it goes into the brain), and each change it makes shows under the answer. The limits come
from Claude Code's status line while a session works; the refresh button on **Claude now** asks
Anthropic for them at once, with each profile's own login, which the console reads for that request
only.

## The desktop app

The tray app makes the console an application: a window with its own icon, a tray dot that turns
red only when a check fails, a profile picker, and **Hey Claude** — one floating field that asks the
default profile and streams the answer under it.
