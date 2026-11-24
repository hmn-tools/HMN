#!/bin/sh
# Removes the HMN launchd job. The graph stays unless --purge is passed.
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$root/deploy/lib.sh"

layout=0
purge=0
yes=0
prefix=""

while [ $# -gt 0 ]; do
  case "$1" in
    --layout-only) layout=1 ;;
    --purge) purge=1 ;;
    --yes) yes=1 ;;
    --prefix)
      prefix=${2:?}
      shift
      ;;
    -h|--help)
      hmn_uninstall_help
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      hmn_uninstall_help >&2
      exit 1
      ;;
  esac
  shift
done

if [ -z "$prefix" ]; then
  if [ "$layout" -eq 1 ]; then
    echo "Pass --prefix with --layout-only." >&2
    exit 1
  fi
  prefix=$HOME
fi

support="$prefix/Library/Application Support/HMN"
manifest="$support/install.manifest"
label=org.hmn.server
domain=gui
plist="$prefix/Library/LaunchAgents/$label.plist"
data_dir="$support/data"
log="$prefix/Library/Logs/HMN/server.log"
keychain=""
if [ -f "$manifest" ]; then
  label=$(hmn_manifest_get "$manifest" label)
  domain=$(hmn_manifest_get "$manifest" domain)
  plist=$(hmn_manifest_get "$manifest" plist)
  data_dir=$(hmn_manifest_get "$manifest" data_dir)
  log=$(hmn_manifest_get "$manifest" log)
  support=$(hmn_manifest_get "$manifest" support)
  keychain=$(hmn_manifest_get "$manifest" keychain)
fi

# A purge cannot be undone, so it does not start on one flag alone. This
# question comes before the job stops, so a refusal changes nothing.
if [ "$purge" -eq 1 ] && [ "$layout" -eq 0 ] && [ "$yes" -eq 0 ]; then
  echo "A purge deletes these for good:" >&2
  echo "  $data_dir (the graph and its backups)" >&2
  echo "  $(dirname "$log") (the logs)" >&2
  echo "  the Keychain items hmn.kek, hmn.owner, hmn.agent, hmn.display, hmn.backup, hmn.audit.tip" >&2
  if ! hmn_interactive; then
    echo "No person is at a terminal. Nothing was removed. Pass --yes to purge without the question." >&2
    exit 1
  fi
  printf 'Type the word purge to continue: ' >&2
  read -r answer || answer=""
  if [ "$answer" != "purge" ]; then
    echo "Nothing was removed." >&2
    exit 1
  fi
fi

if [ "$layout" -eq 0 ] && [ "$(uname -s)" = "Darwin" ]; then
  uid_now=$(id -u)
  if [ "$domain" = "system" ]; then
    launchctl bootout "system/$label" >/dev/null 2>&1 || true
  else
    launchctl bootout "gui/$uid_now/$label" >/dev/null 2>&1 || true
  fi
  # The server saves the graph and removes its working copy before it ends.
  # Wait for that, so that a purge does not delete files under a live server.
  if [ "$domain" = "system" ]; then
    old_job="system/$label"
  else
    old_job="gui/$uid_now/$label"
  fi
  i=0
  while launchctl print "$old_job" >/dev/null 2>&1 && [ "$i" -lt 25 ]; do
    i=$((i + 1))
    sleep 1
  done
fi

rm -f "$plist" "$support/hmn-run.sh" "$support/lib.sh" "$support/menu.json" "$support/install.manifest" "${log}.wrapper"
if [ -n "$plist" ]; then
  rm -f "$(dirname "$plist")/org.hmn.ollama.plist"
fi
if [ "$purge" -eq 1 ]; then
  hmn_safe_rm "$data_dir"
  hmn_safe_rm "$(dirname "$log")"
  if [ "$layout" -eq 0 ] && [ "$(uname -s)" = "Darwin" ]; then
    for service in hmn.kek hmn.owner hmn.agent hmn.display hmn.backup hmn.audit.tip; do
      security delete-generic-password -s "$service" -a hmn >/dev/null 2>&1 || true
      if [ -n "$keychain" ]; then
        security delete-generic-password -s "$service" -a hmn "$keychain" >/dev/null 2>&1 || true
      fi
    done
  fi
fi
echo "HMN launchd job removed." >&2
