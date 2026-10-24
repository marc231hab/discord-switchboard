#!/usr/bin/env python3
"""Enable the tested bridges without restarting agents doing active work."""
import argparse, json, os, pathlib, shlex, subprocess

root=pathlib.Path(__file__).resolve().parent.parent
def run(args, **kwargs):
 return subprocess.run(args,check=True,text=True,capture_output=True,**kwargs).stdout.strip()
def config(path):
 # Resolve the actual shell configuration, printing only non-secret binding fields.
 script='set -a\nsource "$1"\npython3 - <<\'PY\'\nimport json,os\nprint(json.dumps({k:os.environ.get(k) for k in ("TMUX_SESSION","PROJECT_DIR","CHANNEL_NAME","CODEX_HOME","ROUTER_TMUX_SESSION")}))\nPY'
 return json.loads(run(['bash','-c',script,'visibility',str(path)]))
def command(parts):return ' '.join(shlex.quote(str(p)) for p in parts)
def bridge(backend,path,session):
 cmd='while true; do '+command(['bash',root/'scripts/run-bridge.sh',backend,root/'config/global.env',path])+'; sleep 5; done'
 windows=run(['tmux','list-windows','-t',session,'-F','#{window_name}']).splitlines()
 if 'bridge' in windows:run(['tmux','respawn-pane','-k','-t',session+':bridge',cmd])
 else:run(['tmux','new-window','-d','-t',session,'-n','bridge','-c',str(root),cmd])
 print('Enabled',backend,'bridge:',session)
parser=argparse.ArgumentParser();parser.add_argument('--router',action='store_true');parser.add_argument('--session',action='append');parser.add_argument('--reload-idle-claude',action='store_true');args=parser.parse_args()
if args.router:
 cmd='while true; do '+command(['bash',root/'scripts/run-router.sh',root/'config/global.env'])+'; sleep 5; done'
 run(['tmux','respawn-pane','-k','-t',config(root/'config/global.env').get('ROUTER_TMUX_SESSION') or 'discord-router',cmd]);print('Enabled shared Discord router')
for backend,paths in [('codex',sorted((root/'config/codex').glob('*.env'))),('claude',sorted((root/'config').glob('*.env')))]:
 for path in paths:
  if path.name=='global.env':continue
  c=config(path);session=c['TMUX_SESSION']
  if not session or args.session and session not in args.session:continue
  if subprocess.run(['tmux','has-session','-t',session],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:continue
  if backend=='claude' and args.reload_idle_claude:
   pane=run(['tmux','display-message','-p','-t',session+':claude','#{pane_id}'])
   entries=[json.loads(p.read_text()) for p in (pathlib.Path.home()/'.claude/sessions').glob('*.json')]
   entry=next((e for e in entries if str(e.get('tmux','')).endswith('.'+pane)),None)
   if entry and entry.get('status')=='idle':
    cmd=command(['bash',root/'scripts/run-claude.sh',root/'config/global.env',path,entry['sessionId']])
    run(['tmux','respawn-pane','-k','-t',session+':claude',cmd]);subprocess.Popen(['python3',str(root/'scripts/confirm-development-channel.py'),session],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True);print('Reloaded idle Claude session:',session)
   else:print('Kept active Claude session running:',session)
  bridge(backend,path,session)
