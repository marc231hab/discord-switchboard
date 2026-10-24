#!/usr/bin/env python3
"""Confirm only the exact local-development warning used by this binding."""
import subprocess, sys, time
session=sys.argv[1]
for attempt in range(30):
 pane=subprocess.run(['tmux','capture-pane','-p','-t',session+':claude'],capture_output=True,text=True).stdout
 if 'I am using this for local development' in pane and 'Channels: server:custom-discord' in pane:
  subprocess.run(['tmux','send-keys','-t',session+':claude','Enter'],check=True)
  break
 time.sleep(1)
