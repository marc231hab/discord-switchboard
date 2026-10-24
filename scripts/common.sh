#!/usr/bin/env bash
# Shared launcher helpers; systemd scopes are optional on a Linux host.
start_scoped() {
  local unit=$1; shift
  if command -v systemd-run >/dev/null && command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
    systemctl --user reset-failed "${unit}.scope" >/dev/null 2>&1 || true
    systemd-run --user --scope --unit="$unit" "$@"
  else
    "$@"
  fi
}
