---
title: The console
description: A local web app that shows what every profile is doing.
---

The desktop app runs the console, so it is at <http://127.0.0.1:7331> while the app is open; its
window shows it. On a headless box `agents serve` runs it alone.

The console is private to you: it asks for a random token, made at every start and kept in a file only
you can read, on every request but the liveness probe. The app's window and the browser `agents serve`
opens enter with it once; a browser without it is told where to enter from.

Updates are **pushed, not polled**: the server watches the transcripts, the shared configuration, the
agents and the chats, and the page redraws the view you are looking at. It
is Preact and TypeScript, built once with the release and carried by the app (from a checkout, built
with pnpm on the machine); nothing is loaded from elsewhere, so it renders on a machine that has never been
online. English or Italian, following the machine's locale.

## Sections

Three views on a rail on the left, and **More** for the rest: its icons open into names while the
pointer is on it. At its foot, the machine's health (green, yellow or red, it opens the Health page),
the update when one is waiting, the commands and the preferences.

- **Chat** — talking to Claude as in Claude Desktop: your chats by day, the answers streaming in, and
  each change Claude made (a task, an event, a page of the brain) shown under its answer. It reads your
  tasks, calendar, mail, Drive and brain, keeps the tasks and the brain from what you write, and never
  sends mail or deletes. A chat can go on in a terminal; work inside a project's files opens Claude Code
  in that folder.
- **Runs** — the Claude Code sessions running, with how much context each uses; the agents and the
  workflow runs the hub started; the last sessions per folder, each reopened with one click.
- **Accounts & limits** — each profile's account and usage limits (the five hours and the week) with
  today's tokens.
- **More** — Connections (every MCP server, which profiles see it, the accounts and the vault), and
  profiles, permissions, updates, and every doctor check with its fix.

`Ctrl-K` opens a command palette with every view and every action.

The limits come from Claude Code's status line while a session works; «Ask for the limits now» asks
Anthropic for them at once, with each profile's own login, which the console reads for that request
only. The tasks and the brain have their own pages on the brain's site.

## The desktop app

The tray app makes the console an application: a window with its own icon, a tray dot that turns
red only when a check fails, a profile picker, and **Hey Claude** — one floating field that asks the
default profile and streams the answer under it; the conversation shows in Chat too.
