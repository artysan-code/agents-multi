---
title: The console
description: A local web app that shows what every profile is doing.
---

`agents-multi install` enables the console as a systemd user unit, so it is always at
<http://127.0.0.1:7331> — over an ssh tunnel it works the same, which is the point on a headless box.

Updates are **pushed, not polled**: the server watches the transcripts and the shared configuration,
asks the brain whether its tasks or pages moved, and the page redraws the view you are looking at. It
is Preact and TypeScript, built on the machine with pnpm when Agents Multi is installed or updated,
never downloaded; nothing is loaded from elsewhere, so it renders on a machine that has never been
online. English or Italian, following the machine's locale.

## Sections

- **Today** — the sessions running now, the day's tasks and appointments, the last sessions per
  directory with the command that reopens each one.
- **Tasks** — a board, a sortable list, a month calendar with the Google events, a board per project.
- **Brain** — the brain's pages as a tree, search by words and by meaning, every version, the links
  both ways, and the whole brain as a live graph.
- **Connections** — every MCP server, which profiles see it, and whether each one mounted it.
- **System** — profiles, permissions, plugins and skills, updates, and every doctor check with its fix.

`Ctrl-K` opens a command palette with every view and every action.

## The desktop app

The tray app makes the console an application: a window with its own icon, a tray dot that turns
red only when a check fails, a profile picker, and **Hey Claude** — one floating field that asks the
default profile and streams the answer under it.
