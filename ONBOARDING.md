# Onboarding — setting up Agents Multi for a new person

For the Claude Code session that guides someone through their first setup. Speak to them in their
language; this file is in English like the rest of the repository. Do the work yourself where you
can, ask before anything hard to undo, and follow the rules below without exception.

## Rules

- **Secrets never pass through you.** Passphrases, TOTP secrets, tokens, the vault's recovery code:
  the person types them in their own terminal (outside this session, or with `!` only for commands
  that read them hidden from stdin, such as `agents vault set`). Never ask for them in chat,
  never put them in a file, an argument or an environment variable.
- **Back up before you move anything.** `install` turns `~/.claude` into a read-only stub and keeps
  every profile under `~/.agents-multi/<profile>`: their current Claude Code state moves aside.
- **Read before you write**: `install --dry-run` and show the plan; the same for `mcp sync`.
- **`install` and `mcp sync` run with every Claude closed**, this session included: when you get
  there, hand the person the commands and stop; the next session picks up from the doctor.
- Where you are at any time: `~/.local/src/agents-multi/bin/agents doctor` (once installed,
  `agents doctor`). Resume from the first step whose result is missing.

## 0. What to know first

Ask the person, one question at a time:

1. Their **name** and the **language** Claude should use with them.
2. Their **Claude accounts**: which ones (personal, a work organisation, …), which one is the default
   (it gets the plain `claude` command), and which ones also need their **own Claude Desktop**
   window (a separate app, icon and login).
3. Whether they keep their configuration in step between **several machines** (Syncthing, or a
   private git repository) or use one machine.
4. From the administrator who gave them access (not from you): the repository URL, their **brain's
   address**, and — privately, never in chat — the brain's passphrase and TOTP secret.

## 1. Requirements (Arch Linux, KDE)

```bash
sudo pacman -S --needed git deno python jq gnupg binutils libarchive base-devel nodejs npm
sudo npm install -g @electron/asar
```

`@electron/asar`, `gnupg`, `binutils`, `libarchive` and `base-devel` are for Claude Desktop only.

## 2. The repository

```bash
git clone <repository URL> ~/.local/src/agents-multi
```

Read access is enough: the person never commits here (`prelaunch` pulls the updates at every
launch). Over HTTPS, let git keep the credential (`git config --global credential.helper libsecret`
if available).

**Over SSH behind a proxy, use the server's direct address.** If the repository's host name
(`git.example` here) goes through a proxy that does not forward the SSH port (Cloudflare, for
instance, with Forgejo's SSH on 2222), `git fetch` hangs, with no error, until it times out. Put the
direct address of the server in `~/.ssh/config` (the owner gives it):

```
Host git.example
  HostName <the server's address>
  Port 2222
  User git
```

or make the remote point at that address (`git remote set-url origin
ssh://git@<the server's address>:2222/<owner>/agents-multi.git`). The same applies when the remote
is changed after a rename: set-url with the host name alone is not enough. If a fetch hangs, test with
`ssh -p 2222 -T git@git.example`: a greeting from Forgejo means the path works.

## 3. Back up what exists

```bash
tar -C ~ -czf ~/claude-backup-$(date +%F).tar.gz .claude .claude.json .config/Claude 2>/dev/null; ls -l ~/claude-backup-*.tar.gz
```

## 4. Their configuration

```bash
~/.local/src/agents-multi/bin/agents init ~/agents-multi-config --name "<Name>" --language "<Language>"
```

(Another folder if they sync it: inside their Syncthing folder, for instance.) Then shape it with
them, file by file — `~/agents-multi-config/README.md` says what each one is:

- `profiles/` — one folder per Claude account. The default keeps `"command": "claude"`; every other
  one gets `"command": "claude-<name>"` and, if it needs its own Desktop,
  `"desktopDir": "~/.config/Claude-<Name>"`. Each has a `CLAUDE.md` importing their rules.
- `rules/` — how they want Claude to work: language, tone, what to confirm first. Write it with
  them, briefly; it is theirs.
- `settings.json` — their preferences over the shared base (model, plugins, permissions). Keep it
  small at first.

## 5. Install (with Claude closed)

Show `~/.local/src/agents-multi/bin/agents install --dry-run`, then tell the person to quit
this session and run, in a terminal:

```bash
~/.local/src/agents-multi/bin/agents install
agents vault init
```

`vault init` prints a **recovery code**: it goes into their password manager, not into a chat. Then
each profile's command once (`claude`, `claude-<name>`, …) to sign in with `/login`.

## 6. Claude Desktop (if they use it)

If Claude Desktop is already installed as a system package (AUR or other), say so to the person
and remove it with them first: Agents Multi keeps Desktop in user space. Once, the system half: `cd ~/.local/src/agents-multi/pkg/claude-desktop-shims && makepkg -si`.
Then `agents update --desktop`, and for each profile with its own `desktopDir`
`claude-desktop-rebuild <profile>`, then `agents install` again. Every Claude Desktop closed
while doing it. Each profile appears in the menu with its own icon.

## 7. Their brain

The administrator runs their brain instance and gives them its address, passphrase and TOTP secret.

1. The TOTP secret into their authenticator app (the `otpauth://` line, or typed by hand).
2. In the **default** account on claude.ai: Settings → Connectors → Add custom connector, named
   exactly **Brain** (the console and Hey Claude look for that name), URL `<brain address>/mcp`; sign
   in with the passphrase and the TOTP code. It is then in Claude Desktop and the phone app too.
3. In their configuration, `accounts.json`:
   `{ "service": "brain", "name": "brain", "url": "<brain address>" }`
   and in `servers.json` the other profiles, which reach the brain as an MCP server instead:
   `{ "servers": { "brain": { "_profiles": ["<profile>", "…"] } } }` (none, if there is only the
   default one).
4. A token for this machine: they open `<brain address>/account`, sign in, create a token named
   after the machine, and store it themselves:
   ```bash
   agents vault set brain brain
   ```

## 8. Finish (with Claude closed)

```bash
agents mcp sync
agents doctor
```

Every ✗ in the doctor comes with its fix. Then, in a profile that only has the MCP server, `/mcp` →
brain → Authenticate (passphrase + TOTP once per profile and machine). The console is at
<http://127.0.0.1:7331>; the tray app opens it.

Optional, later: Google (their own OAuth client, `agents google client`), other services in
the console's Connections, the phone with the Claude app and the Brain connector.
