# 0015 — A vault for the server

- Status: accepted 2026-10-16 (amends [ADR 0013](0013-a-server-node-without-a-terminal.md), «The vault key without a
  keyring» and «As built (F2)»)
- Date: 2026-10-16

## Context

A server node gets the owner's vault folder (`~/agents-multi-vault`) by Syncthing as a trusted device, and, since
F2, the owner's vault **key**, sealed to the server at pairing. So a server holds **every** secret the owner has —
the brain's machine token (which reads the whole brain), the infrastructure tokens, the Google client — while it
needs a handful: Claude's setup tokens, the passkey revocations, the env files of its clones, and the odd service
a job calls. The node already talks to the brain with its own node token (F2), so the brain's entry is useless to
it and dangerous there. A leaked server (a container, a volume, a Coolify account) should leak what the server
does, not the owner.

Syncthing cannot send a folder to a device minus some files, and a second device cannot be told «not this entry»
inside one sealed vault: the key opens all of it.

## Decision

- **The server has a vault of its own**: a separate Syncthing folder, `~/agents-multi-vault-server` on the owner's
  machine (`AGENTS_MULTI_SERVER_VAULT` moves it, as `AGENTS_MULTI_VAULT` moves the vault), sealed with **its own
  key**, a server vault key made on the owner's machine. The server receives that folder alone, receive only,
  and mounts it where it always mounted the vault (`~/agents-multi-vault`, `NODE_VAULT_DIR`): the node's code
  reads it as its vault, unchanged. The format is the vault's (`secrets/<id>.json`, `key-check.json`); its check
  text differs (`agents-multi server vault`), so the doctor can tell one from the other. `keyMatches` accepts both.
- **The server key** is kept in the owner's vault (service `server-vault`, account `key`): it travels between the
  owner's machines and is covered by the vault's recovery code, and never reaches a server. Pairing a server from
  the console seals **this** key to the server, not the owner's vault key.
- **What is in it**, and nothing else (`apps/cli/node/server-vault.ts`):
  - `claude/*` — the accounts' setup tokens;
  - what a node reads from the vault by design: the passkey revocations (`passkey-revocations/*`), the clones' env
    files (`seed/*`) and the owner's **public** approval key (`approval/owner`, derived on the owner's machine,
    because a key derived from the server key would check no signature the owner makes);
  - the services listed in `nodes.json` `serverServices`: an array of `<service>/<account>`, default empty.
  - Never `brain/*` (a `brain/…` in `serverServices` is ignored), never the vault's own key
    material, never the server key.
- **`agents vault server sync`** (the owner's machine) copies the selected entries, re-sealed under the server key,
  deletes (as a tombstone, like any deletion) the ones no longer selected, and prints names only. `agents node
  token <profile>`, a passkey revocation and `agents node seed` run it after they write, when the server vault
  exists. `agents vault server status` says what is out of date; `recovery-code` prints the server key's code for
  a server paired by terminal.
- **The doctor**: on the owner's machine, `vault.server` warns when the server vault is out of date against the
  selection (and the deny rules cover its folder). On a headless node, `node.vault.scope` **fails** if the vault it
  holds opens as the owner's, or holds a `brain/*` entry.
- **Cost, accepted**: the server vault is one more thing to keep current. A secret changed on the owner's machine
  reaches a server at the next sync, not by itself (the doctor says when it has not). The owner's other secrets no
  longer exist on a server at all, which is the point.

## Migration

Per server, once: stop sharing `agents-multi-vault` with it, share `agents-multi-vault-server` receive only, run
`agents vault server sync`, point `NODE_VAULT_DIR` (and the bind of `<uuid>_node-vault`) at the new folder, and pair
again from the console (or, by terminal, `agents node setup` with `agents vault server recovery-code`). The key
file of the old pairing is replaced; the old vault folder on the server is removed. The steps are in
[apps/node/README.md](../../apps/node/README.md).
