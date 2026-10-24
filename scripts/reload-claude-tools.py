#!/usr/bin/env python3
"""Refresh a bound Claude pane only when its session becomes idle."""
import json,pathlib,shlex,subprocess,sys,time
root=pathlib.Path(__file__).resolve().parent.parent
config=pathlib.Path(sys.argv[1]).resolve()
script='set -e\nset -a\nsource "$1"\npython3 -c \'import json,os; print(json.dumps({k:os.environ[k] for k in ("TMUX_SESSION","PROJECT_DIR")}))\''
values=json.loads(subprocess.check_output(['bash','-c',script,'refresh',str(config)],text=True))
session=values['TMUX_SESSION']
for attempt in range(14400):
 pane=subprocess.check_output(['tmux','display-message','-p','-t',session+':claude','#{pane_id}'],text=True).strip()
 entries=[json.loads(p.read_text()) for p in (pathlib.Path.home()/'.claude/sessions').glob('*.json')]
 entry=next((e for e in entries if str(e.get('tmux','')).endswith('.'+pane)),None)
 if entry and entry.get('status')=='idle':
  cmd=shlex.join(['bash',str(root/'scripts/run-claude.sh'),str(root/'config/global.env'),str(config),entry['sessionId']])
  subprocess.run(['tmux','respawn-pane','-k','-t',session+':claude',cmd],check=True)
  subprocess.run(['python3',str(root/'scripts/confirm-development-channel.py'),session],check=True)
  print('Refreshed Discord tools:',session)
  break
 time.sleep(3)
