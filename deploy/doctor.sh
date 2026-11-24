#!/bin/sh
# Calm health check for an HMN Mac mini. Exit 1 when a check failed.
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$root/deploy/lib.sh"

prefix=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix)
      prefix=${2:?}
      shift
      ;;
    -h|--help)
      echo "Usage: deploy/doctor.sh [--prefix DIR]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
  shift
done

if [ -z "$prefix" ]; then
  prefix=$HOME
fi

support="$prefix/Library/Application Support/HMN"
manifest="$support/install.manifest"
data_dir="$support/data"
plist="$prefix/Library/LaunchAgents/org.hmn.server.plist"
label=org.hmn.server
domain=gui
port=8787
layout=0
if [ -f "$manifest" ]; then
  data_dir=$(hmn_manifest_get "$manifest" data_dir)
  plist=$(hmn_manifest_get "$manifest" plist)
  label=$(hmn_manifest_get "$manifest" label)
  domain=$(hmn_manifest_get "$manifest" domain)
  # An install from before these two lines has neither.
  value=$(hmn_manifest_get "$manifest" port)
  if [ -n "$value" ]; then
    port=$value
  fi
  value=$(hmn_manifest_get "$manifest" layout)
  if [ "$value" = "1" ]; then
    layout=1
  fi
fi
# A layout is files only. It has no Keychain, no launchd job, and no server.
live=0
if [ "$layout" -eq 0 ] && [ "$(uname -s)" = "Darwin" ]; then
  live=1
fi

failed=0
say() { printf '%s\n' "$1"; }

# With no install, one line is the whole answer.
if [ "$live" -eq 1 ] && [ ! -f "$plist" ] && [ ! -d "$data_dir" ] &&
  ! security find-generic-password -s hmn.kek -a hmn >/dev/null 2>&1; then
  say "HMN is not installed on this Mac. Run deploy/hmn install."
  exit 1
fi

if [ -d "$data_dir" ]; then
  mode=$(stat -c %a "$data_dir" 2>/dev/null || stat -f %OLp "$data_dir")
  case "$mode" in
    700|600) say "The data directory is private." ;;
    *)
      say "The data directory is readable by others."
      failed=1
      ;;
  esac
else
  say "The data directory is not there yet."
fi

key="$data_dir/tls/server.key"
cert="$data_dir/tls/server.crt"
if [ -f "$cert" ]; then
  say "The certificate is in place."
  if [ -f "$key" ]; then
    kmode=$(stat -c %a "$key" 2>/dev/null || stat -f %OLp "$key")
    case "$kmode" in
      600|400) ;;
      *)
        say "The certificate key is readable by others."
        failed=1
        ;;
    esac
  fi
else
  say "No certificate yet."
fi

menu="$support/menu.json"
if [ -f "$cert" ] && [ -f "$menu" ] && command -v openssl >/dev/null 2>&1; then
  pinned=$(sed -n 's/.*"fingerprint": "\([^"]*\)".*/\1/p' "$menu" | head -n 1)
  actual=$(hmn_cert_fingerprint "$cert")
  if [ "$pinned" != "layout" ] && [ -n "$actual" ]; then
    if [ "$pinned" = "$actual" ]; then
      say "The certificate matches the pin."
    else
      say "The certificate does not match the pin in menu.json. The menu and the phone refuse it."
      failed=1
    fi
  fi
fi

if [ -f "$plist" ]; then
  job_bun=$(hmn_plist_env "$plist" HMN_BUN)
  job_server=$(hmn_plist_env "$plist" HMN_SERVER_DIR)
  if [ ! -x "$job_bun" ]; then
    say "The job points at a Bun that is not there: $job_bun. Run deploy/install.sh again."
    failed=1
  elif hmn_bun_managed "$job_bun"; then
    say "The job uses a Bun inside a version manager: $job_bun. Run deploy/install.sh again."
    failed=1
  else
    say "Bun is in place."
  fi
  if [ ! -f "$job_server/src/index.ts" ]; then
    say "The checkout is not where the job expects it: $job_server. Run deploy/install.sh from the checkout."
    failed=1
  elif hmn_unsafe_location "$job_server" "$HOME"; then
    say "The checkout is in a cloud folder or a protected folder: $job_server."
    failed=1
  fi
fi

if [ "$live" -eq 1 ] && command -v fdesetup >/dev/null 2>&1; then
  if fdesetup status 2>/dev/null | grep -q 'FileVault is On'; then
    say "FileVault is on."
  else
    say "FileVault is off."
    failed=1
  fi
fi

if [ "$live" -eq 0 ]; then
  say "Keychain checks need an install on the Mac."
elif command -v security >/dev/null 2>&1; then
  for item in hmn.kek hmn.owner hmn.backup; do
    if security find-generic-password -s "$item" -a hmn >/dev/null 2>&1; then
      say "Keychain has $item."
    else
      say "Keychain does not have $item."
      failed=1
    fi
  done
  if [ ! -f "$data_dir/hmn.sqlite.enc" ] && security find-generic-password -s hmn.kek -a hmn >/dev/null 2>&1; then
    say "The Keychain has hmn.kek, but there is no graph. The key is from another install or from a test."
    failed=1
  fi
fi

if [ "$live" -eq 1 ]; then
  uid_now=$(id -u)
  if [ "$domain" = "system" ]; then
    target="system/$label"
  else
    target="gui/$uid_now/$label"
  fi
  if launchctl print "$target" >/dev/null 2>&1; then
    say "The server is loaded."
  else
    say "The server is not loaded. Start it with deploy/hmn start."
    failed=1
  fi
  if hmn_health "https://127.0.0.1:$port" "$data_dir/tls/ca.crt"; then
    say "The server answers on port $port."
    # The server copies the head of its audit chain to the Keychain at each save. If that copy is no longer in the
    # chain, the log on the mini was rewritten. This reads the Keychain and changes nothing.
    tip=$(security find-generic-password -s hmn.audit.tip -a hmn -w 2>/dev/null || true)
    owner_key=$(security find-generic-password -s hmn.owner -a hmn -w 2>/dev/null || true)
    if [ -n "$tip" ] && [ -n "$owner_key" ]; then
      check=$(printf 'Authorization: Bearer %s\n' "$owner_key" | curl -fsS --max-time 5 --cacert "$data_dir/tls/ca.crt" -H @- \
        -H 'content-type: application/json' -d "{\"tip\":\"$tip\"}" "https://127.0.0.1:$port/api/v1/audit/tip/check" 2>/dev/null || true)
      case "$check" in
        *'"rewritten":false'*) say "The audit log extends the copy in the Keychain." ;;
        *'"rewritten":true'*) say "The audit log does not contain the copy in the Keychain. The log on the mini was rewritten."; failed=1 ;;
        *) say "The audit check did not answer." ;;
      esac
    fi
    owner_key=""
  else
    say "The server does not answer on port $port. Look at deploy/hmn logs."
    failed=1
  fi
else
  say "Launchd checks need an install on the Mac."
fi

# The phone pins this certificate. A new one needs the new fingerprint on each phone, so the doctor warns early.
if [ -f "$data_dir/tls/server.crt" ] && command -v openssl >/dev/null 2>&1; then
  if openssl x509 -checkend 5184000 -noout -in "$data_dir/tls/server.crt" >/dev/null 2>&1; then
    say "The certificate is valid for more than 60 days."
  else
    say "The certificate ends within 60 days. Run deploy/hmn renew-cert, then put the new fingerprint on each phone."
    failed=1
  fi
fi

newest=""
if [ -d "$data_dir/backups" ]; then
  # The names hold the time, so the last name in sort order is the newest backup.
  newest=$(find "$data_dir/backups" -name 'backup-*.hmn' -type f 2>/dev/null | sort | tail -n 1 || true)
fi
if [ -n "$newest" ]; then
  now=$(date +%s)
  then=$(stat -c %Y "$newest" 2>/dev/null || stat -f %m "$newest")
  days=$(( (now - then) / 86400 ))
  if [ "$days" -gt 14 ]; then
    say "The newest backup is $days days old."
    failed=1
  else
    say "A backup is $days days old."
  fi
else
  say "No backup yet."
fi

if [ -f "$plist" ] && grep -q 'HMN_LLM_URL' "$plist"; then
  url=$(sed -n 's/.*<key>HMN_LLM_URL<\/key>//p' "$plist" | head -n 1)
  url=$(awk '/<key>HMN_LLM_URL<\/key>/{getline; gsub(/<[^>]*>/, ""); gsub(/^[ \t]+|[ \t]+$/, ""); print; exit}' "$plist")
  if hmn_loopback_url "$url"; then
    if command -v curl >/dev/null 2>&1 && curl -fsS --max-time 2 "http://127.0.0.1:11434/api/tags" >/dev/null 2>&1; then
      say "The local model answered."
    else
      say "The local model did not answer."
      failed=1
    fi
  else
    say "The model URL is not on this machine."
    failed=1
  fi
else
  say "No local model is configured."
fi

if [ "$failed" -eq 0 ]; then
  say "Nothing here needs you."
fi
exit "$failed"
