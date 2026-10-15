---
title: From the phone
description: Chat, tasks and memory from your phone, answered by your own machines.
---

The service serves a small web app at `/app`. Open `https://<your service>/app` on the phone, sign in as you do on
the account page, and add it to the home screen: it installs like an app. It keeps only its own shell for a slow
connection; your data is never stored on the phone for offline use.

## What is in it

- **Chat** — your conversations by day, a conversation with the answer appearing as it is written and the changes
  Claude made (a task created, a page changed), and a box to write in.
- **Tasks** — today with its times, what is overdue, what you did today. A tap on the circle marks a task done.
- **Brain** — search the memory by words or by meaning, and read a page. Links between pages open the page they name.
- **Machines** — the machines paired with your account, which are online, and which one answers the chat. If it is
  offline, the next online one in the order you set takes over, and the answer says where it ran.
- **Settings** — notifications on this device, the account page, sign out.

## Who answers

The service does not run Claude. A chat you write on the phone waits in your account until one of your machines
(the desktop app, or a node on a server) takes it, runs it, and sends the answer back as it goes. With no machine
online, the message stays waiting and is answered when one returns. A chat never starts work on a machine by itself:
anything it proposes (a job, a routine, something that leaves the machine) still needs your yes, which for now is
given on a desktop.

## Notifications

In **Settings**, _Turn on notifications_ asks the browser for permission and registers this device with the service.
You get one notification when an answer is ready (or a turn fails); a tap opens that chat.

On **iPhone and iPad**, a web page can receive notifications only once it is added to the home screen: in Safari tap
Share, then _Add to Home Screen_, and open Agents Multi from there. Until then the app says so instead of offering the
switch. iOS 16.4 or later is needed.

## If something is off

- The app sends you to the sign-in page: the session ended. Sign
  in again and you come back to the app.
- A message stays _waiting_: no machine of the account is online. Look at **Machines**.
- No _Turn on notifications_ button: the browser blocked them for the site (allow them in its settings), or it cannot
  show notifications from a web app.
