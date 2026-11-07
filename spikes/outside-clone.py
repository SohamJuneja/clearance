# Which agent sessions touched paths outside their own clone? Commands only, never output. Prints no secrets.
import glob, json, os, re, sqlite3, time
OUT = re.compile(r'(/home/you/(?!\.switch/agents)|~/(?!\.switch)|\.\./\.\.|/projects/Clearance|\bsecrets\.json\b|gate-tokens|identities\.json|controller.*\.env|vendor/switch)')
SECRET = re.compile(r'(\.env\b|secrets\.json|gate-tokens|identities\.json|controller-\w+\.env|\.clearance|credentials)')
print('OpenCode sessions')
HOMES = os.path.expanduser('~/.local/share/clearance-tools/homes/')
DBS = [p for p in [os.path.expanduser('~/.local/share/opencode/opencode.db'), HOMES + 'clearance-alex-open/.local/share/opencode/opencode.db'] if os.path.exists(p)]
for db in DBS:
  con = sqlite3.connect('file:' + db + '?mode=ro', uri=True)
  for sid, directory, title, created in con.execute("select id, directory, title, time_created from session order by time_created"):
      calls = outside = 0
      flagged = []
      secrets = []
      for (raw,) in con.execute("select data from part where session_id = ? order by time_created", (sid,)):
          d = json.loads(raw)
          if d.get('type') != 'tool':
              continue
          i = (d.get('state') or {}).get('input') or {}
          what = str(i.get('command') or i.get('filePath') or i.get('path') or '')
          calls += 1
          if OUT.search(what):
              outside += 1
              flagged.append(what[:110].replace('\n', ' '))
          if SECRET.search(what):
              secrets.append(what[:110].replace('\n', ' '))
      print(time.strftime('%m-%d %H:%M', time.gmtime(created / 1000)), sid[:12], os.path.basename(directory), 'calls', calls, 'outside', outside, 'secret-path', len(secrets))
      for f in flagged[:6]:
          print('    out:', f)
      for f in secrets[:6]:
          print('    sec:', f)
print('Claude refunds-agent and vanilla sessions')
TRANSCRIPTS = '.claude/projects/-home-prashant--switch-agents-127-0-0-1-8000-*/*.jsonl'
for path in sorted(glob.glob(os.path.expanduser('~/' + TRANSCRIPTS)) + glob.glob(HOMES + '*/' + TRANSCRIPTS), key=os.path.getmtime):
    calls = 0
    flagged = []
    secrets = []
    for raw in open(path):
        try:
            e = json.loads(raw)
        except ValueError:
            continue
        if e.get('type') != 'assistant':
            continue
        for b in (e.get('message') or {}).get('content') or []:
            if isinstance(b, dict) and b.get('type') == 'tool_use':
                i = b.get('input') or {}
                what = str(i.get('command') or i.get('file_path') or i.get('path') or '')
                calls += 1
                if OUT.search(what):
                    flagged.append(what[:110].replace('\n', ' '))
                if SECRET.search(what):
                    secrets.append(what[:110].replace('\n', ' '))
    if flagged or secrets:
        print(os.path.basename(os.path.dirname(path))[-22:], os.path.basename(path)[:8], 'calls', calls, 'outside', len(flagged), 'secret-path', len(secrets))
        for f in flagged[:5]:
            print('    out:', f)
        for f in secrets[:5]:
            print('    sec:', f)
