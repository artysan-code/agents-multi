---
title: From the phone
description: Chat, tasks and memory from your phone, answered by your own machines.
---

The service serves a small web app at `/app`. Open `https://<your service>/app` on the phone, sign in as you do on
the account page, and add it to the home screen: it installs like an app. It keeps only its own shell for a slow
connection; your data is never stored on the phone for offline use.

## What is in it

A tab bar under your thumb, a light and a dark look (the device's, or your choice in **More**), and on a wide screen
the chat list beside the conversation. Nothing on a page scrolls unless its content is longer than the screen.

**Swipe.** Drag a finger sideways to move between the tabs; the page follows the finger and settles with a spring
(with reduced motion on, it simply changes). On a row, a swipe is a shortcut for a button that is always there: a task
to the right is _done_, a chat to the left is _delete_ (with an _Undo_ for a few seconds), a request or a job to the
right is _yes_ or _accept_, to the left _no_ or _decline_. The yes still asks for your passkey.

- **Chat** — your conversations by day, with the machine that answered. Your messages are small bubbles; the answers
  are full-width text with lists, links and code blocks you can copy; the changes Claude made (a task created, a page
  changed) sit under the answer as small chips, and a cursor shows it is still writing. A waiting or running answer
  can be _Cancelled_; if it fails or is cancelled, _Try again_. You can rename a chat (the pencil), delete it, search
  the list, and copy an answer. Under the box you see which machine will answer, and you can change it for the next
  messages. On a computer Enter sends and Shift+Enter breaks the line; on a phone Enter breaks the line and the arrow
  sends.
- **Voice** — in the box, the small microphone _dictates_: the words appear as you say them, in the app's language
  (your phone's own speech service, Apple's or Google's, hears them; the app says so). The wave button records a
  _voice note_: hold it and let go to send, slide away to cancel, or tap it for a recording that stays open with
  _Cancel_ and _Send_ (five minutes or 10 MB at most). It shows as a small audio bubble until a machine has
  transcribed it, and then as your words. Only a machine with whisper.cpp and ffmpeg can (`agents node voice` on it);
  if none is online the note stays waiting and the app says why.
- **Waiting** — what the agents on your machines ask you (a permission, a question) and the jobs proposed to them.
  Each is answered with a passkey: _Yes_, _Yes for the session_, _No_. The badge on the tab counts what waits.
- **Tasks** — today with its times, what is overdue, what you did today. Rows are compact: the title cut at two lines, and under it one small line with the time, project and how late
  it is. A tap on the circle, or a swipe to the right, marks a task done.
- **Brain** — search the memory by words or by meaning, browse the pages changed lately, and read a page. Links
  between pages open the page they name.
- **More** — **Machines** (each node's state, load and accounts, which one answers, pairing a new one, and
  _Forget_ for one you no longer use, offered first on the offline ones),
  notifications on this device, your passkeys, the theme, the language, the account page and sign out.

## Say yes with a passkey

The first time you open **Waiting**, the app offers to create a passkey on the phone: your fingerprint or face then
confirms each answer, and your machines check it themselves. A new passkey is _pending_: it counts only once a desktop
with your vault has endorsed it. On the desktop run `agents passkeys` (or open _Connections › Passkeys_ in the
console) and approve it. Until then the buttons stay off and nothing is allowed. Lost the phone? Revoke its passkey in
**More** (and `agents passkeys revoke`, which every machine with your vault respects).

The passkey is asked to be saved in your password manager (Bitwarden, iCloud Keychain, Google): it is a discoverable
credential. If creating it fails, the app shows the browser's own error, name and message, with a hint: _NotAllowedError_
(cancelled, or the five minutes passed), _InvalidStateError_ (already registered here), _SecurityError_ (the address
is not the service's domain). The yes you give is bound to the words you saw: a service that showed other words would
get a signature the machine refuses.

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
- A message stays _waiting_: no machine of the account is online. Look at **More › Machines**, or _Cancel_ the message.
- No notifications switch: the browser blocked them for the site (allow them in its settings), or it cannot
  show notifications from a web app.
