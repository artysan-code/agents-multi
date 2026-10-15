---
title: Starting on a hosted service
description: Someone runs the service for you: install Agents Multi on your machine, pair it with a code, talk from the phone.
---

When someone hosts the service for you (an invitation link, from whoever runs it), you need no server of your own.
The service keeps your account, your memory, your tasks and your chats; **your agents run on your machines**, with
your own Claude: the service never holds a Claude login, a key of your vault or your code.

## 1. Your account

Open the invitation link, choose a passphrase and set up the authenticator code. The [privacy notice](/privacy) of
that service says who runs it, where the data is and who can see it.

## 2. Agents Multi on your machine

Install the desktop app ([Getting started](/docs/getting-started)) and sign in to Claude in the profile you want to
use. Then pair the machine with your account:

```bash
agents node pair
```

It shows a code of eight characters. On the phone (or any browser), open `https://<the service>/app`, sign in, go to
**More › Machines › Pair a machine** and type the code. The app shows which machine asks: say yes only if it is yours.
The machine is a node of your account from then on, and answers your chats.

## 3. The phone

Add the web app to the home screen (on iPhone: Share › Add to Home Screen, then open it from there), turn on the
notifications in **More**, and ask something in **Chat**. To answer what your agents ask from the phone, create a
passkey in **Waiting** and approve it from your desktop:

```bash
agents passkeys endorse <id>
```

Compare the fingerprint with the one the phone shows before you say yes.

## What the host can and cannot do

- **Can**: read the service's database (your memory, tasks and chats), as anyone who runs a server can; keep or stop
  the service.
- **Cannot**: run anything on your machines, sign in to your Claude, read your vault, or say yes for you: a yes
  counts only with your passkey, approved by your own desktop, and your machines check it themselves.

If you would rather hold the data yourself, run the service on your own server: [Self-hosting](/docs/self-hosting).
