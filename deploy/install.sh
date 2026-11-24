#!/bin/sh
# Idempotent install of HMN on a Mac mini. See docs/MAC-MINI.md.
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$root/deploy/lib.sh"

layout=0
dedicated=0
local_llm=0
seed=""
prefix=""
server_dir=""
bun=""
hmn_tmp=""

hmn_cleanup() {
  if [ -n "$hmn_tmp" ] && [ -f "$hmn_tmp" ]; then
    rm -f "$hmn_tmp"
  fi
}
trap hmn_cleanup EXIT
trap 'exit 130' INT TERM

while [ $# -gt 0 ]; do
  case "$1" in
    --local-llm) local_llm=1 ;;
    --layout-only) layout=1 ;;
    --dedicated-user) dedicated=1 ;;
    --empty) seed=empty ;;
    --demo) seed=demo ;;
    --prefix)
      prefix=${2:?}
      shift
      ;;
    --server-dir)
      server_dir=${2:?}
      shift
      ;;
    --bun)
      bun=${2:?}
      shift
      ;;
    -h|--help)
      hmn_install_help
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      hmn_install_help >&2
      exit 1
      ;;
  esac
  shift
done

if [ "$layout" -eq 1 ] && [ -z "$prefix" ]; then
  echo "Pass --prefix with --layout-only." >&2
  exit 1
fi
if [ "$layout" -eq 0 ] && [ "$(uname -s)" != "Darwin" ]; then
  echo "This install runs on the Mac mini. Pass --layout-only --prefix to preview the files." >&2
  exit 1
fi

if [ -z "$server_dir" ]; then
  server_dir="$root/server"
fi
port=${HMN_PORT:-8787}
# With no HMN_TZ, the zone of this Mac. A day in HMN starts and ends in that zone.
tz=${HMN_TZ:-}
if [ -z "$tz" ]; then
  tz=$(readlink /etc/localtime 2>/dev/null | sed -n 's#.*/zoneinfo/##p')
fi
if [ -z "$tz" ]; then
  tz=UTC
fi
label=org.hmn.server

if [ "$layout" -eq 1 ]; then
  if [ -z "$bun" ]; then
    bun=/usr/bin/true
  fi
else
  # Checks first. Nothing on the Mac has changed when one of them stops the install.
  if [ ! -f "$server_dir/src/index.ts" ]; then
    echo "There is no HMN server in $server_dir." >&2
    exit 1
  fi
  if hmn_unsafe_location "$server_dir" "$HOME"; then
    echo "HMN cannot run from $server_dir." >&2
    echo "A background job cannot read a cloud folder, Desktop, Documents, or Downloads reliably." >&2
    echo "Move the checkout, for example to $HOME/hmn, and run the install again." >&2
    exit 1
  fi
  os_major=$(sw_vers -productVersion 2>/dev/null | cut -d. -f1)
  case "$os_major" in
    ''|*[!0-9]*) os_major=0 ;;
  esac
  if [ "$os_major" -gt 0 ] && [ "$os_major" -lt 14 ]; then
    echo "Note: this is macOS $os_major. The menu bar app needs macOS 14 or later." >&2
  fi
  if command -v fdesetup >/dev/null 2>&1 && ! fdesetup status 2>/dev/null | grep -q 'FileVault is On'; then
    echo "Note: FileVault is off. Turn it on before real data goes in." >&2
  fi

  if [ -n "$bun" ]; then
    if hmn_bun_managed "$bun"; then
      echo "Note: $bun is inside a version manager. The job stops working when that version goes." >&2
    fi
  else
    found=$(command -v bun 2>/dev/null || true)
    bun=$(hmn_pick_bun "$HOME" "$dedicated" "$found")
    if [ -z "$bun" ]; then
      if [ -n "$found" ]; then
        echo "The Bun on the path is inside a version manager: $found" >&2
        echo "launchd needs an address that does not change." >&2
      fi
      echo "Installing Bun $HMN_BUN_VERSION." >&2
      if [ "$dedicated" -eq 1 ]; then
        hmn_install_bun /usr/local || exit 1
        bun=/usr/local/bin/bun
      else
        hmn_install_bun "$HOME/.bun" || exit 1
        bun="$HOME/.bun/bin/bun"
      fi
    fi
  fi
  if [ ! -x "$bun" ]; then
    echo "Bun was not found at $bun" >&2
    exit 1
  fi
  bun_version=$("$bun" --version 2>/dev/null || true)
  if [ "$bun_version" != "$HMN_BUN_VERSION" ]; then
    echo "Note: $bun is version ${bun_version:-unknown}. HMN is tested with Bun $HMN_BUN_VERSION." >&2
  fi
fi

if [ "$dedicated" -eq 1 ]; then
  if [ "$layout" -eq 1 ]; then
    support="$prefix/Library/Application Support/HMN"
    data_dir="$prefix/var/hmn"
    plist="$prefix/Library/LaunchDaemons/$label.plist"
    log="$prefix/var/log/hmn/server.log"
  else
    support="/Library/Application Support/HMN"
    data_dir=/var/hmn
    plist="/Library/LaunchDaemons/$label.plist"
    log=/var/log/hmn/server.log
  fi
  domain=system
  run_user=_hmn
  run_group=_hmn
  keychain=/Library/Keychains/System.keychain
else
  if [ -z "$prefix" ]; then
    prefix=$HOME
  fi
  support="$prefix/Library/Application Support/HMN"
  data_dir="$support/data"
  plist="$prefix/Library/LaunchAgents/$label.plist"
  log="$prefix/Library/Logs/HMN/server.log"
  domain=gui
  run_user=""
  run_group=""
  keychain=""
fi

# A key with no graph is from another install or from a test. The server would
# use it for the new graph with no message, so the install stops here, before
# it makes a file.
if [ "$layout" -eq 0 ] && [ ! -f "$data_dir/hmn.sqlite.enc" ] && [ ! -f "$data_dir/keys/db.wrap" ]; then
  stray=0
  if [ -n "$keychain" ]; then
    if security find-generic-password -s hmn.kek -a hmn "$keychain" >/dev/null 2>&1; then
      stray=1
    fi
  elif security find-generic-password -s hmn.kek -a hmn >/dev/null 2>&1; then
    stray=1
  fi
  if [ "$stray" -eq 1 ]; then
    echo "The Keychain has the key hmn.kek, but there is no graph in $data_dir." >&2
    echo "The key is from another install or from a test. A new graph must not start with it." >&2
    echo "If the graph is in another folder or in a backup, put it back first." >&2
    echo "If you have no HMN data to keep, run deploy/hmn uninstall --purge, then run the install again." >&2
    exit 1
  fi
fi

# A new graph starts empty or with the fictional demonstration. The
# demonstration cannot be removed later as a whole, so the install does not
# select it by default. The owner decides, before the install makes a file.
if [ "$layout" -eq 0 ]; then
  if [ -f "$data_dir/hmn.sqlite.enc" ]; then
    if [ -n "$seed" ]; then
      echo "Note: this Mac has a graph already. --$seed has no effect on it." >&2
    fi
    seed=""
  elif [ -z "$seed" ]; then
    if hmn_interactive; then
      echo "This Mac has no HMN graph. Select how the new graph starts." >&2
      echo "  1  Empty. Use this for your own data." >&2
      echo "  2  The fictional demonstration. Use this for a test. It cannot be removed" >&2
      echo "     later as a whole. The way back is a purge and a new install." >&2
      printf 'Type 1 or 2: ' >&2
      read -r answer || answer=""
      case "$answer" in
        1) seed=empty ;;
        2) seed=demo ;;
        *)
          echo "Nothing was changed." >&2
          exit 1
          ;;
      esac
    else
      echo "A new graph needs a decision. Pass --empty for your own data, or --demo for the fictional demonstration." >&2
      echo "The demonstration cannot be removed later as a whole. Nothing was changed." >&2
      exit 1
    fi
  fi
fi

mkdir -p "$data_dir" "$(dirname "$plist")" "$(dirname "$log")" "$support"
chmod 700 "$data_dir"
chmod 700 "$(dirname "$log")" || true

if [ "$layout" -eq 0 ] && [ "$dedicated" -eq 1 ]; then
  if [ "$(id -u)" -ne 0 ]; then
    echo "A dedicated user needs sudo." >&2
    exit 1
  fi
  if ! id _hmn >/dev/null 2>&1; then
    uid=399
    used=$(dscl . -list /Users UniqueID | awk '{print $2}')
    while printf '%s\n' "$used" | grep -qx "$uid"; do
      uid=$((uid - 1))
      if [ "$uid" -lt 200 ]; then
        echo "No free system uid for _hmn." >&2
        exit 1
      fi
    done
    dscl . -create /Groups/_hmn
    dscl . -create /Groups/_hmn PrimaryGroupID "$uid"
    dscl . -create /Groups/_hmn RealName "HMN"
    dscl . -create /Users/_hmn
    dscl . -create /Users/_hmn UserShell /usr/bin/false
    dscl . -create /Users/_hmn UniqueID "$uid"
    dscl . -create /Users/_hmn PrimaryGroupID "$uid"
    dscl . -create /Users/_hmn NFSHomeDirectory /var/hmn
    dscl . -create /Users/_hmn RealName "HMN"
  fi
  chown -R _hmn:_hmn /var/hmn
  if ! security find-generic-password -s hmn.kek -a hmn "$keychain" >/dev/null 2>&1; then
    kek=$(openssl rand -base64 32 | tr -d '\n=' | tr '+/' '-_')
    security add-generic-password -s hmn.kek -a hmn -w "$kek" -U -A \
      -T /usr/bin/security -T "$bun" "$keychain"
    unset kek
  fi
fi

# An install from before a rename runs its jobs under another label. Stop those
# jobs and remove their files, so that two servers do not start.
prior_label=""
prior_plist=""
if [ -f "$support/install.manifest" ]; then
  prior_label=$(hmn_manifest_get "$support/install.manifest" label)
  prior_plist=$(hmn_manifest_get "$support/install.manifest" plist)
fi
if [ "$prior_label" = "$label" ]; then
  prior_label=""
fi

if [ "$layout" -eq 0 ]; then
  uid_now=$(id -u)
  if [ "$domain" = "system" ]; then
    launchctl bootout "system/$label" >/dev/null 2>&1 || true
  else
    launchctl bootout "gui/$uid_now/$label" >/dev/null 2>&1 || true
  fi
  if [ -n "$prior_label" ]; then
    for old in "$prior_label" "${prior_label%.server}.ollama"; do
      launchctl bootout "system/$old" >/dev/null 2>&1 || true
      launchctl bootout "gui/$uid_now/$old" >/dev/null 2>&1 || true
    done
  fi
  # The old server saves the graph and closes the port. launchd gives it 20 seconds.
  if [ "$domain" = "system" ]; then
    old_job="system/$label"
  else
    old_job="gui/$uid_now/$label"
  fi
  i=0
  while [ "$i" -lt 25 ]; do
    if ! launchctl print "$old_job" >/dev/null 2>&1 && ! hmn_port_busy "$port"; then
      break
    fi
    i=$((i + 1))
    sleep 1
  done
  if hmn_port_busy "$port"; then
    who=$(hmn_port_owner "$port")
    echo "Port $port is in use${who:+ by $who}." >&2
    echo "Stop that process, or set HMN_PORT to a free port, and run the install again." >&2
    exit 1
  fi
fi

# Only the files that the old manifest names, and only with the old label in the name.
if [ -n "$prior_label" ]; then
  case "$prior_plist" in
    */"$prior_label".plist)
      rm -f "$prior_plist" "$(dirname "$prior_plist")/${prior_label%.server}.ollama.plist"
      ;;
  esac
fi

fingerprint=""
backup=""
menu="$support/menu.json"
if [ "$layout" -eq 1 ]; then
  fingerprint=layout
else
  have_graph=0
  if [ -f "$data_dir/hmn.sqlite.enc" ] && [ -f "$data_dir/tls/server.crt" ] && [ -f "$menu" ]; then
    existing=$(sed -n 's/.*"fingerprint": "\([^"]*\)".*/\1/p' "$menu" | head -n 1)
    case "$existing" in
      *[!0-9a-fA-F]*|"") ;;
      *)
        if [ "${#existing}" -ge 4 ]; then
          fingerprint=$existing
          have_graph=1
        fi
        ;;
    esac
  fi
  if [ "$have_graph" -eq 0 ]; then
    hmn_tmp=$(mktemp "${TMPDIR:-/tmp}/hmn-boot.XXXXXX")
    chmod 600 "$hmn_tmp"
    if [ "$dedicated" -eq 1 ]; then
      sudo -u _hmn env HMN_DATA_DIR="$data_dir" HMN_KEYCHAIN="$keychain" HMN_PORT="$port" HMN_TZ="$tz" HMN_HOST=0.0.0.0 HMN_SEED="${seed:-demo}" \
        "$bun" "$server_dir/src/index.ts" >"$hmn_tmp" 2>&1 &
    else
      env HMN_DATA_DIR="$data_dir" HMN_PORT="$port" HMN_TZ="$tz" HMN_HOST=0.0.0.0 HMN_SEED="${seed:-demo}" \
        "$bun" "$server_dir/src/index.ts" >"$hmn_tmp" 2>&1 &
    fi
    pid=$!
    i=0
    while [ "$i" -lt 150 ]; do
      if grep -q "HMN listening" "$hmn_tmp" 2>/dev/null; then
        break
      fi
      if ! kill -0 "$pid" 2>/dev/null; then
        break
      fi
      i=$((i + 1))
      sleep 0.2
    done
    kill -TERM "$pid" 2>/dev/null || true
    i=0
    while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 25 ]; do
      i=$((i + 1))
      sleep 0.2
    done
    kill -KILL "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    parsed=$(hmn_parse_boot_log "$hmn_tmp")
    fingerprint=$(printf '%s\n' "$parsed" | sed -n 's/^fingerprint=//p')
    owner=$(printf '%s\n' "$parsed" | sed -n 's/^owner=//p')
    agent=$(printf '%s\n' "$parsed" | sed -n 's/^agent=//p')
    display=$(printf '%s\n' "$parsed" | sed -n 's/^display=//p')
    backup=$(printf '%s\n' "$parsed" | sed -n 's/^backup=//p')
    if [ -z "$fingerprint" ]; then
      echo "The server did not start. The boot log was not kept." >&2
      if ! grep -q 'hmn_' "$hmn_tmp" 2>/dev/null; then
        cat "$hmn_tmp" >&2 || true
      fi
      exit 1
    fi
    # A secret goes to the Keychain. When the Keychain refuses it, only a person
    # at a terminal sees it. It never goes to a pipe, a file, or an agent.
    lost=0
    hmn_store_one() {
      service=$1
      value=$2
      [ -n "$value" ] || return 0
      if security add-generic-password -s "$service" -a hmn -w "$value" -U >/dev/null 2>&1; then
        if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
          sudo -u "$SUDO_USER" security add-generic-password -s "$service" -a hmn -w "$value" -U >/dev/null 2>&1 || true
        fi
      elif ! hmn_show_secret "The Keychain did not take $service. Write this value down. It is not saved in a file." "$value"; then
        echo "The Keychain did not take $service." >&2
        lost=1
      fi
      return 0
    }
    hmn_store_one hmn.owner "$owner"
    hmn_store_one hmn.agent "$agent"
    hmn_store_one hmn.display "$display"
    hmn_store_one hmn.backup "$backup"
    owner=""
    agent=""
    display=""
    if [ "$lost" -eq 1 ]; then
      echo "A key was not saved, and no person is at a terminal to read it." >&2
      echo "Run deploy/uninstall.sh --purge --yes, then run the install again in Terminal." >&2
      exit 1
    fi
    if [ "$dedicated" -eq 1 ]; then
      chown -R _hmn:_hmn "$data_dir"
    fi
    rm -f "$hmn_tmp"
    hmn_tmp=""
  fi
fi

cp "$root/deploy/hmn-run.sh" "$support/hmn-run.sh"
cp "$root/deploy/lib.sh" "$support/lib.sh"
chmod 755 "$support/hmn-run.sh"
chmod 644 "$support/lib.sh"

llm_url=""
llm_model=""
if [ "$local_llm" -eq 1 ]; then
  chip=${HMN_CHIP:-apple}
  gb=${HMN_MEM_GB:-16}
  if [ "$layout" -eq 0 ]; then
    if [ "$(uname -m)" = "arm64" ]; then
      chip=apple
    else
      chip=intel
    fi
    gb=$(($(sysctl -n hw.memsize) / 1024 / 1024 / 1024))
  fi
  llm_model=$(hmn_pick_model "$chip" "$gb")
  llm_url="http://127.0.0.1:11434/api/chat"
  if [ "$layout" -eq 0 ]; then
    if ! command -v ollama >/dev/null 2>&1; then
      if command -v brew >/dev/null 2>&1; then
        brew install ollama
      else
        echo "Ollama is not installed. Install it with Homebrew, then run this again." >&2
        exit 1
      fi
    fi
    ollama_bin=$(command -v ollama)
    OLLAMA_HOST=127.0.0.1:11434 "$ollama_bin" pull "$llm_model"
  else
    ollama_bin=/usr/bin/true
  fi
  ollama_plist="$(dirname "$plist")/org.hmn.ollama.plist"
  mkdir -p "$(dirname "$ollama_plist")"
  hmn_render_ollama_plist "$ollama_bin" >"$ollama_plist"
  chmod 644 "$ollama_plist"
fi

hmn_render_plist "$label" "$bun" "$server_dir" "$data_dir" "$log" "$support/hmn-run.sh" \
  "$keychain" "$run_user" "$run_group" "$port" "$tz" "$llm_url" "$llm_model" >"$plist"
chmod 644 "$plist"

uid_value=""
if [ "$domain" = "gui" ]; then
  uid_value=$(id -u)
fi
cat >"$menu" <<EOF
{
  "base_url": "https://127.0.0.1:${port}",
  "fingerprint": "${fingerprint}",
  "label": "${label}",
  "domain": "${domain}",
  "plist": "${plist}",
  "uid": "${uid_value}"
}
EOF
chmod 600 "$menu"

cat >"$support/install.manifest" <<EOF
label=${label}
domain=${domain}
plist=${plist}
data_dir=${data_dir}
log=${log}
support=${support}
keychain=${keychain}
port=${port}
server_dir=${server_dir}
layout=${layout}
EOF
chmod 600 "$support/install.manifest"

if [ "$dedicated" -eq 1 ] && [ "$layout" -eq 0 ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  user_home=$(dscl . -read "/Users/$SUDO_USER" NFSHomeDirectory | awk '{print $2}')
  user_support="$user_home/Library/Application Support/HMN"
  mkdir -p "$user_support"
  cp "$menu" "$user_support/menu.json"
  chown "$SUDO_USER" "$user_support/menu.json" "$user_support" || true
  chmod 600 "$user_support/menu.json"
fi

if [ "$layout" -eq 0 ]; then
  uid_now=$(id -u)
  if [ "$domain" = "system" ]; then
    launchctl bootstrap system "$plist"
    launchctl enable "system/$label" || true
    # No -k here. The job starts at load, and -k kills a server that is opening the graph.
    launchctl kickstart "system/$label" || true
  else
    launchctl bootstrap "gui/$uid_now" "$plist"
    launchctl enable "gui/$uid_now/$label" || true
    launchctl kickstart "gui/$uid_now/$label" || true
  fi
  base="https://127.0.0.1:$port"
  if ! hmn_wait_health "$base" "$data_dir/tls/ca.crt" 30; then
    echo "launchd has the job, but the server did not answer on $base in 30 seconds." >&2
    for file in "$log" "$log.wrapper"; do
      if [ -s "$file" ]; then
        echo "The end of $file:" >&2
        tail -n 20 "$file" 2>/dev/null | grep -v 'hmn_' >&2 || true
      fi
    done
    echo "Run deploy/hmn status after you correct the cause." >&2
    exit 1
  fi
  echo "HMN is installed. The server answers on $base." >&2
  if [ "$seed" = "empty" ]; then
    echo "  The new graph is empty." >&2
  elif [ "$seed" = "demo" ]; then
    echo "  The new graph has the fictional demonstration." >&2
  fi
  echo "  Certificate fingerprint: $fingerprint" >&2
  echo "  Server log: $log" >&2
  echo "  Check the install: deploy/hmn status" >&2
  echo "  Pair a phone: deploy/hmn pair" >&2
  if [ -n "$backup" ]; then
    if hmn_show_secret "This is the recovery passphrase of the new graph: 13 words with hyphens between them." "$backup"; then
      echo "The recovery passphrase was shown one time. deploy/hmn passphrase shows it again." >&2
    else
      echo "The recovery passphrase was not shown, because no person is at a terminal." >&2
      echo "It is in the Keychain item hmn.backup. Run deploy/hmn passphrase in Terminal and write it on paper." >&2
    fi
  fi
else
  echo "Wrote an install layout under $prefix" >&2
fi
