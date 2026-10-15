---
title: From the phone
description: Chat, tasks and memory from your phone, answered by your own machines.
---

The service serves a small web app at `/app`. Open `https://<your service>/app` on the phone, sign in as you do on
the account page, and add it to the home screen: it installs like an app. It keeps only its own shell for a slow
connection; your data is never stored on the phone for offline use.

## What is in it

A tab bar under your thumb, a light and a dark look (the device's, or your choice in **More**), and on a wide screen
the chat list beside the conversation.

- **Chat** — your conversations by day, with the machine that answered. Your messages are small bubbles; the answers
  are full-width text with lists, links and code blocks you can copy; the changes Claude made (a task created, a page
  changed) sit under the answer as small chips, and a cursor shows it is still writing. If no machine picks a message
  up you can _Stop waiting_; if it fails, _Try again_. Under the box you see which machine will answer, and you can
  change it for the next messages. On a computer Enter sends and Shift+Enter breaks the line; on a phone Enter breaks
  the line and the arrow sends.
- **Waiting** — what the agents on your machines ask you (a permission, a question) and the jobs proposed to them.
  Each is answered with a passkey: _Yes_, _Yes for the session_, _No_. The badge on the tab counts what waits.
- **Tasks** — today with its times, what is overdue, what you did today. A tap on the circle marks a task done.
- **Brain** — search the memory by words or by meaning, browse the pages changed lately, and read a page. Links
  between pages open the page they name.
- **More** — **Machines** (each node's state, load and accounts, which one answers, and pairing a new one),
  notifications on this device, your passkeys, the theme, the language, the account page and sign out.

## Say yes with a passkey

The first time you open **Waiting**, the app offers to create a passkey on the phone: your fingerprint or face then
confirms each answer, and your machines check it themselves. A new passkey is _pending_: it counts only once a desktop
with your vault has endorsed it. On the desktop run `agents passkeys` (or open _Connections › Passkeys_ in the
console) and approve it. Until then the buttons stay off and nothing is allowed. Lost the phone? Revoke its passkey in
**More**, and on a desktop run `agents passkeys revoke <id>` (or _Revoke_ in the console): that writes the revocation
into your vault, so your machines refuse it even if the service still lists it.

## Pair a machine

In **More › Machines**, _Pair a machine_ takes the 8-character code that `agents node pair` shows on the machine. The
code works once and for ten minutes; five wrong codes in a row stop pairing for fifteen minutes.

## Who answers

The service does not run Claude. A chat you write on the phone waits in your account until one of your machines
(the desktop app, or a node on a server) takes it, runs it, and sends the answer back as it goes. With no machine
online, the message stays waiting and is answered when one returns. A chat never starts work on a machine by itself:
anything it proposes (a job, a routine, something that leaves the machine) still needs your yes, given on a desktop
or on the phone with your passkey.

## Notifications

In **More**, the _Notifications_ switch asks the browser for permission and registers this device with the service.
You get one notification when an answer is ready (or a turn fails); a tap opens that chat.

On **iPhone and iPad**, a web page can receive notifications only once it is added to the home screen: in Safari tap
Share, then _Add to Home Screen_, and open Agents Multi from there. Until then the app says so instead of offering the
switch. iOS 16.4 or later is needed.

## If something is off

- The app sends you to the sign-in page: the session ended. Sign
  in again and you come back to the app.
- A message stays _waiting_: no machine of the account is online. Look at **More › Machines**, or tap _Stop waiting_
  (it stays queued and is answered when a machine returns).
- No notifications switch: the browser blocked them for the site (allow them in its settings), or it cannot
  show notifications from a web app.
