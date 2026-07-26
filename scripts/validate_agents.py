import sys, os, json, re

def check(path):
    name = os.path.basename(path)
    txt = open(path, encoding="utf-8").read()
    errs = []
    if not txt.startswith("---"):
        errs.append("no opening ---")
        return errs
    # frontmatter between first two --- lines
    m = re.match(r"^---\n(.*?)\n---\n", txt, re.S)
    if not m:
        errs.append("frontmatter delimiters malformed")
        return errs
    fm = m.group(1)
    for key in ("name:", "description:"):
        if key not in fm:
            errs.append(f"missing {key}")
    # tools line, if present, must be a valid JSON array
    tm = re.search(r"^tools:\s*(\[.*\])\s*$", fm, re.M)
    if tm:
        try:
            arr = json.loads(tm.group(1))
            if not isinstance(arr, list):
                errs.append("tools not a list")
        except Exception as e:
            errs.append(f"tools not valid JSON: {e}")
    # model line, if present, sanity
    mm = re.search(r"^model:\s*(\S+)\s*$", fm, re.M)
    if mm and mm.group(1) not in ("opus", "sonnet", "haiku", "inherit"):
        errs.append(f"unexpected model: {mm.group(1)}")
    return errs

d = sys.argv[1]
ok = True
for f in sorted(os.listdir(d)):
    if not f.endswith(".md") or f == "AGENTS.md":
        continue
    errs = check(os.path.join(d, f))
    tm = re.search(r"^tools:\s*(\[.*\])", open(os.path.join(d, f), encoding="utf-8").read(), re.M)
    mm = re.search(r"^model:\s*(\S+)", open(os.path.join(d, f), encoding="utf-8").read(), re.M)
    tools = tm.group(1) if tm else "(none)"
    model = mm.group(1) if mm else "(none)"
    status = "OK " if not errs else "FAIL"
    if errs:
        ok = False
    print(f"{status} {f:28} model={model:8} tools={tools}")
    for e in errs:
        print(f"      -> {e}")
print("\nRESULT:", "ALL VALID" if ok else "ERRORS FOUND")
