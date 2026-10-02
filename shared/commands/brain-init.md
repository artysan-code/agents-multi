---
description: Write this project's page in Samuel's brain (and its client's, when it needs one), from what this folder and its repo say.
---

# Brain init

Write the page of the project you are in into Samuel's brain (the `brain` MCP server, or the
"brain" connector): a short page that lets any Claude, on any device, know what this project is
and where it stands without opening the folder. You know this project better than anyone, so
the page comes from here. This one task goes to the brain, not to the old wiki `~/brains/claude`.

## 1. Read

- The folder's `CLAUDE.md` / `AGENTS.md`, its `notes/` (the latest status first: `STATO.md` and
  the like), the parent folder's `CLAUDE.md` (who the client is), the repo's README and
  `git log --oneline -20`.
- In the brain: `brain_search` for the project and its client, `brain_read` of what you find, and
  of `clienti/acme` or the client page when it is a work project. Update a page that exists
  rather than writing a new one.

## 2. Write the project page

Path: `progetti/` + the folder under `~` (`~/work/acme/site` → `progetti/work/acme/site.md`).
Italian, at most 400 words, by the brain's rules (it refuses what breaks them and says why):

```
# <Name>

<One sentence: what it is, for whom (link the client), what it is for.>

- **Stato**: where it stands today, in two or three lines.
- **Decisioni**: the ones that still hold and why (stack, hosting, scope), only the durable ones.
- **Prossimi passi**: what is open.
- **Chi**: who else works on it (link persone/ pages that exist).
- **Dove**: the local folder, the repo by name, where the live status note is.
```

Leave out what the code or the repo already says, work steps, history that no longer matters.

## 3. The client, when it needs a page

`clienti/<name>` holds the relationship, not the work: who the client is (one line), direct or
through whom (`[[clienti/acme]]`, `[[clienti/agency]]`, …), the people of
reference, the projects. Write one only when there is something to say about the relationship
or the client has more than one project; a client that is just this project stays a line in the
project page. People get a page in `persone/` only when they matter beyond this project.

## 4. Rules that do not bend

- NDA: no code, secrets, credentials, amounts, addresses, clients' customers or personal data.
  Only what the relationship and the work are, at a high level. In doubt, leave it out.
- Do not guess: what the folder does not say, ask Samuel at the end (at most three questions),
  or leave it out.
- Tasks stay where they are (`tasks` MCP, `TASKS.md`): do not copy them into the page.
- Touch nothing else in the folder or the repo; no commits, no pushes.

## 5. Close

`brain_append` one line in today's diary linking the page, `brain_check`, then tell Samuel in
two lines what you wrote and ask your questions, if any.
