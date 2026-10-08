// setup.ts — the strings of the first-run wizard (pages/setup/), English and Italian: Italian carries
// every English key.

export const en = {
  "su.title": "Set up Agents Multi",
  "su.of": "Step {n} of {m}",
  "su.back": "Back",
  "su.next": "Continue",
  "su.later": "Later",
  "su.skip": "Skip",
  "su.retry": "Try again",
  "su.check": "Check again",
  "su.s.welcome": "Welcome",
  "su.s.you": "You",
  "su.s.folder": "Configuration",
  "su.s.profiles": "Profiles",
  "su.s.install": "Install",
  "su.s.claude": "Claude Code",
  "su.s.vault": "Vault",
  "su.s.logins": "Sign-in",
  "su.s.brain": "Brain",
  "su.s.done": "Done",

  "su.welcome.h": "Welcome to Agents Multi",
  "su.welcome.1":
    "Several Claude accounts on one machine, each in a profile of its own: its own command, settings and sign-in.",
  "su.welcome.2":
    "One configuration of yours — profiles, rules, accounts — that can follow you to your other machines.",
  "su.welcome.3":
    "A console for your day: tasks, sessions, health and updates, with Claude one keystroke away.",
  "su.welcome.lang": "Language",
  "su.welcome.go": "Let's start",

  "su.you.h": "Who you are",
  "su.you.sub":
    "Claude calls you by name and answers in your language. Both go into owner.json, in your configuration.",
  "su.you.name": "Your name",
  "su.you.lang": "The language Claude answers in",
  "su.you.langDefault": "English",

  "su.folder.h": "Your configuration folder",
  "su.folder.sub":
    "Your profiles, rules and accounts live in a folder of yours, outside the code; ~/.agents-multi/config links to it.",
  "su.folder.note":
    "Put it in a Syncthing folder (or a private git repository) and your other machines share it. A folder that already holds a configuration — another machine's — is only linked.",
  "su.folder.field": "Folder",
  "su.folder.linked": "{f} already held a configuration: linked, as it is.",
  "su.folder.current": "Linked now: {f}",

  "su.profiles.h": "Your Claude accounts",
  "su.profiles.sub":
    "A profile is one Claude account with its own command, settings and sign-in: «claude» opens the default one, «claude-work» another.",
  "su.profiles.name": "Profile",
  "su.profiles.command": "Command",
  "su.profiles.add": "Add a profile",
  "su.profiles.remove": "Remove {p}",
  "su.profiles.note":
    "A separate Claude Desktop, aliases and MCP servers: later, in System › Profiles.",

  "su.install.h": "Install",
  "su.install.sub":
    "The commands in ~/.local/bin, the profiles in ~/.agents-multi, the MCP servers' runtime and the start at login. It takes a minute.",
  "su.install.row": "Installing Agents Multi",
  "su.install.go": "Install",
  "su.install.showOut": "Show output",
  "su.install.hideOut": "Hide output",
  "su.claude.h": "Claude Code",
  "su.claude.sub":
    "Every profile runs Claude Code, which is not on this machine yet. Anthropic's installer downloads it into ~/.local/share/claude; Agents Multi keeps it up to date from then on.",
  "su.claude.row": "Installing Claude Code",
  "su.claude.go": "Install Claude Code",

  "su.vault.h": "The vault",
  "su.vault.sub":
    "The keys and tokens of your services, encrypted, the same on every machine. Its key stays in this machine's keyring.",
  "su.vault.create": "Create a new vault",
  "su.vault.have": "I have one on another machine",
  "su.vault.pairSub":
    "Its recovery code: on the other machine, «agents vault recovery-code» in a terminal, or your password manager.",
  "su.vault.code": "Recovery code",
  "su.vault.pair": "Open the vault",
  "su.vault.yours": "Your recovery code",
  "su.vault.keep":
    "Keep it outside this machine — a password manager, or paper. It is shown only now, and it is the only way to open the vault on another machine or after a reinstall.",
  "su.vault.copy": "Copy",
  "su.vault.copied": "Copied",
  "su.vault.saved": "I saved it",
  "su.vault.ok": "This machine opens the vault in {d}.",
  "su.vault.locked":
    "A vault is in {d}, from another machine: enter its recovery code to open it here.",
  "su.vault.wrong":
    "This machine's key does not open the vault in {d}: enter that vault's recovery code.",
  "su.vault.unavailable":
    "The keyring cannot be reached (no secret-tool, or no desktop session). Set the vault up later with «agents vault init».",
  "su.vault.lost":
    "If you did not save its recovery code, «agents vault recovery-code» in a terminal shows it.",

  "su.logins.h": "Sign in",
  "su.logins.sub":
    "Each profile signs in to its Claude account once. A terminal opens with Claude Code's sign-in: finish it in the browser, and the profile turns green here.",
  "su.logins.go": "Sign in",
  "su.logins.again": "Again",
  "su.logins.in": "signed in",
  "su.logins.out": "not yet",
  "su.logins.opened": "A terminal opened for {p}: finish the sign-in there.",
  "su.logins.noCode":
    "Claude Code is not installed on this machine yet. Install it, then sign in here — or later, with «{c} auth login» in a terminal.",

  "su.brain.h": "Your brain",
  "su.brain.opt": "optional",
  "su.brain.sub":
    "The brain is your memory and your task list on a server of your own, the same from every Claude. Its address comes from whoever runs it for you.",
  "su.brain.url": "The brain's address",
  "su.brain.go": "Sign in",
  "su.brain.wait": "Waiting for the sign-in in the browser…",
  "su.brain.ok": "Connected to {u}.",
  "su.brain.noVault":
    "The brain's token goes into the vault: without one, connect the brain later from Connections.",

  "su.done.h": "All set",
  "su.done.sub": "Agents Multi is ready, {n}.",
  "su.done.mcp": "Registering the MCP servers",
  "su.done.later": "Put off: {l}. You find them in System and Connections.",
  "su.done.mcpFail":
    "The MCP servers were not registered: run «agents mcp sync» with Claude closed.",
  "su.done.open": "Open Agents Multi",
  "su.done.profiles": "{n} profiles",
  "su.done.profile": "1 profile",
};

export const it: Record<keyof typeof en, string> = {
  "su.title": "Configura Agents Multi",
  "su.of": "Passo {n} di {m}",
  "su.back": "Indietro",
  "su.next": "Continua",
  "su.later": "Più tardi",
  "su.skip": "Salta",
  "su.retry": "Riprova",
  "su.check": "Controlla di nuovo",
  "su.s.welcome": "Benvenuto",
  "su.s.you": "Tu",
  "su.s.folder": "Configurazione",
  "su.s.profiles": "Profili",
  "su.s.install": "Installazione",
  "su.s.claude": "Claude Code",
  "su.s.vault": "Vault",
  "su.s.logins": "Accesso",
  "su.s.brain": "Brain",
  "su.s.done": "Fatto",

  "su.welcome.h": "Benvenuto in Agents Multi",
  "su.welcome.1":
    "Più account Claude sulla stessa macchina, ognuno in un suo profilo: comando, impostazioni e accesso propri.",
  "su.welcome.2":
    "Una configurazione tua — profili, regole, account — che può seguirti sulle altre macchine.",
  "su.welcome.3":
    "Una console per la giornata: task, sessioni, salute e aggiornamenti, con Claude a un tasto di distanza.",
  "su.welcome.lang": "Lingua",
  "su.welcome.go": "Cominciamo",

  "su.you.h": "Chi sei",
  "su.you.sub":
    "Claude ti chiama per nome e ti risponde nella tua lingua. Tutti e due vanno in owner.json, nella tua configurazione.",
  "su.you.name": "Il tuo nome",
  "su.you.lang": "La lingua in cui Claude ti risponde",
  "su.you.langDefault": "Italiano",

  "su.folder.h": "La cartella della configurazione",
  "su.folder.sub":
    "Profili, regole e account stanno in una cartella tua, fuori dal codice; ~/.agents-multi/config punta lì.",
  "su.folder.note":
    "Mettila in una cartella di Syncthing (o in un repository git privato) e le altre macchine la condividono. Una cartella che contiene già una configurazione — quella di un'altra macchina — viene solo collegata.",
  "su.folder.field": "Cartella",
  "su.folder.linked":
    "{f} conteneva già una configurazione: collegata così com'è.",
  "su.folder.current": "Collegata ora: {f}",

  "su.profiles.h": "I tuoi account Claude",
  "su.profiles.sub":
    "Un profilo è un account Claude con comando, impostazioni e accesso suoi: «claude» apre quello predefinito, «claude-work» un altro.",
  "su.profiles.name": "Profilo",
  "su.profiles.command": "Comando",
  "su.profiles.add": "Aggiungi un profilo",
  "su.profiles.remove": "Togli {p}",
  "su.profiles.note":
    "Un Claude Desktop separato, alias e server MCP: più tardi, in Sistema › Profili.",

  "su.install.h": "Installazione",
  "su.install.sub":
    "I comandi in ~/.local/bin, i profili in ~/.agents-multi, il runtime dei server MCP e l'avvio al login. Ci vuole un minuto.",
  "su.install.row": "Installo Agents Multi",
  "su.install.go": "Installa",
  "su.install.showOut": "Mostra l'output",
  "su.install.hideOut": "Nascondi l'output",
  "su.claude.h": "Claude Code",
  "su.claude.sub":
    "Ogni profilo usa Claude Code, che su questa macchina non c'è ancora. L'installer di Anthropic lo scarica in ~/.local/share/claude; da lì in poi lo aggiorna Agents Multi.",
  "su.claude.row": "Installo Claude Code",
  "su.claude.go": "Installa Claude Code",

  "su.vault.h": "Il vault",
  "su.vault.sub":
    "Le chiavi e i token dei tuoi servizi, cifrati, gli stessi su ogni macchina. La sua chiave resta nel portachiavi di questa macchina.",
  "su.vault.create": "Crea un nuovo vault",
  "su.vault.have": "Ne ho uno su un'altra macchina",
  "su.vault.pairSub":
    "Il suo codice di recupero: sull'altra macchina, «agents vault recovery-code» in un terminale, oppure il tuo password manager.",
  "su.vault.code": "Codice di recupero",
  "su.vault.pair": "Apri il vault",
  "su.vault.yours": "Il tuo codice di recupero",
  "su.vault.keep":
    "Conservalo fuori da questa macchina — un password manager, o la carta. Lo vedi solo ora, ed è l'unico modo per aprire il vault su un'altra macchina o dopo una reinstallazione.",
  "su.vault.copy": "Copia",
  "su.vault.copied": "Copiato",
  "su.vault.saved": "L'ho salvato",
  "su.vault.ok": "Questa macchina apre il vault in {d}.",
  "su.vault.locked":
    "In {d} c'è un vault, da un'altra macchina: inserisci il suo codice di recupero per aprirlo qui.",
  "su.vault.wrong":
    "La chiave di questa macchina non apre il vault in {d}: inserisci il codice di recupero di quel vault.",
  "su.vault.unavailable":
    "Il portachiavi non risponde (manca secret-tool, o non c'è una sessione desktop). Configura il vault più tardi con «agents vault init».",
  "su.vault.lost":
    "Se non hai salvato il codice di recupero, «agents vault recovery-code» in un terminale te lo mostra.",

  "su.logins.h": "Accedi",
  "su.logins.sub":
    "Ogni profilo accede una volta al suo account Claude. Si apre un terminale con l'accesso di Claude Code: completalo nel browser, e qui il profilo diventa verde.",
  "su.logins.go": "Accedi",
  "su.logins.again": "Di nuovo",
  "su.logins.in": "accesso fatto",
  "su.logins.out": "non ancora",
  "su.logins.opened":
    "Si è aperto un terminale per {p}: completa lì l'accesso.",
  "su.logins.noCode":
    "Claude Code non è ancora installato su questa macchina. Installalo, poi accedi da qui — o più tardi, con «{c} auth login» in un terminale.",

  "su.brain.h": "Il tuo brain",
  "su.brain.opt": "facoltativo",
  "su.brain.sub":
    "Il brain è la tua memoria e la tua lista di task su un server tuo, lo stesso da ogni Claude. L'indirizzo te lo dà chi lo gestisce per te.",
  "su.brain.url": "L'indirizzo del brain",
  "su.brain.go": "Accedi",
  "su.brain.wait": "Aspetto l'accesso nel browser…",
  "su.brain.ok": "Collegato a {u}.",
  "su.brain.noVault":
    "Il token del brain va nel vault: senza vault, collega il brain più tardi da Connessioni.",

  "su.done.h": "Tutto pronto",
  "su.done.sub": "Agents Multi è pronto, {n}.",
  "su.done.mcp": "Registro i server MCP",
  "su.done.later": "Rimandati: {l}. Li trovi in Sistema e Connessioni.",
  "su.done.mcpFail":
    "I server MCP non sono stati registrati: lancia «agents mcp sync» con Claude chiuso.",
  "su.done.open": "Apri Agents Multi",
  "su.done.profiles": "{n} profili",
  "su.done.profile": "1 profilo",
};
