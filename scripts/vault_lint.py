import os, re, sys

V = os.path.expanduser("~/brains/claude")
REQUIRED = ["title:", "category:", "tags:", "summary:", "base_confidence:", "lifecycle:"]

pages = {}   # relpath-without-ext -> text
for root, _, files in os.walk(V):
    if "/_" in root or "/.obsidian" in root:
        continue
    for f in files:
        if not f.endswith(".md"):
            continue
        if f in ("index.md", "hot.md", "log.md", "CONVENTIONS.md"):
            continue
        p = os.path.join(root, f)
        rel = os.path.relpath(p, V)[:-3]
        pages[rel] = open(p, encoding="utf-8").read()

index_txt = open(os.path.join(V, "index.md"), encoding="utf-8").read()
all_text = index_txt + "\n" + "\n".join(pages.values())
links = set(re.findall(r"\[\[([^\]|#]+)", all_text))

errs = 0
print("=== frontmatter ===")
for rel, txt in sorted(pages.items()):
    fm = re.match(r"^---\n(.*?)\n---\n", txt, re.S)
    if not fm:
        print(f"FAIL {rel}: no frontmatter"); errs += 1; continue
    block = fm.group(1)
    miss = [k for k in REQUIRED if k not in block]
    # summary length
    sm = re.search(r"^summary:\s*(.+)$", block, re.M)
    slen = len(sm.group(1)) if sm else 0
    # incoming link?
    incoming = rel in links or rel.split("/")[-1] in {l.split("/")[-1] for l in links}
    flags = []
    if miss: flags.append("missing " + ",".join(miss))
    if slen > 200: flags.append(f"summary {slen}>200")
    if not incoming: flags.append("ORPHAN (no incoming wikilink)")
    if flags:
        print(f"FAIL {rel}: {'; '.join(flags)}"); errs += 1
    else:
        print(f"OK   {rel}  (summary {slen} chars)")

print("\n=== references: righe tabella (acc: >=8) ===")
for rel, txt in sorted(pages.items()):
    if not rel.startswith("references/"):
        continue
    rows = len(re.findall(r"^\|.+\|.+\|", txt, re.M)) - len(re.findall(r"^\|[\s:|-]+\|", txt, re.M))
    status = "OK" if rows >= 8 else "WARN"
    print(f"{status} {rel}: ~{rows} righe dati (header/separatori esclusi)")

print("\n=== skills: ## Steps con >=3 bullet ===")
for rel, txt in sorted(pages.items()):
    if not rel.startswith("skills/"):
        continue
    m = re.search(r"## Steps\n(.*?)(?=\n## |\Z)", txt, re.S)
    bullets = len(re.findall(r"^- ", m.group(1), re.M)) if m else 0
    status = "OK" if bullets >= 3 else "FAIL"
    if bullets < 3: errs += 1
    print(f"{status} {rel}: {bullets} bullet in ## Steps")

print("\nRESULT:", "ALL OK" if errs == 0 else f"{errs} PROBLEMI")
sys.exit(1 if errs else 0)
