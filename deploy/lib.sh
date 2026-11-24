#!/bin/sh
# Shared helpers for the Mac mini install. Sourced, not executed.
# Secrets are never written by these functions except through the `security` tool.

hmn_xml() {
  printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'
}

hmn_manifest_get() {
  file=$1
  key=$2
  sed -n "s/^${key}=//p" "$file" | head -n 1
}

hmn_rotate_log() {
  file=$1
  max=${2:-1048576}
  [ -f "$file" ] || return 0
  size=$(wc -c < "$file" | tr -d ' ')
  [ "$size" -gt "$max" ] || return 0
  i=5
  while [ "$i" -gt 1 ]; do
    prev=$((i - 1))
    if [ -f "$file.$prev" ]; then
      mv "$file.$prev" "$file.$i"
    fi
    i=$prev
  done
  mv "$file" "$file.1"
}

hmn_parse_boot_log() {
  log=$1
  owner=$(awk '/^owner / { print $NF }' "$log")
  agent=$(awk '/^agent / { print $NF }' "$log")
  display=$(awk '/^display / { print $NF }' "$log")
  fingerprint=$(awk '/^certificate fingerprint / { print $NF }' "$log")
  backup=$(awk '/^  [a-z]+-[a-z]+-/ { print $1; exit }' "$log")
  case "$owner" in
    hmn_[A-Za-z0-9_-]*) ;;
    *) owner="" ;;
  esac
  case "$agent" in
    hmn_[A-Za-z0-9_-]*) ;;
    *) agent="" ;;
  esac
  case "$display" in
    hmn_[A-Za-z0-9_-]*) ;;
    *) display="" ;;
  esac
  case "$fingerprint" in
    *[!0-9a-fA-F]*) fingerprint="" ;;
  esac
  if [ "${#fingerprint}" -lt 4 ]; then
    fingerprint=""
  fi
  case "$backup" in
    *[!a-z-]*) backup="" ;;
  esac
  case "$backup" in
    *-*-*-*-*) ;;
    *) backup="" ;;
  esac
  printf 'owner=%s\nagent=%s\ndisplay=%s\nbackup=%s\nfingerprint=%s\n' \
    "$owner" "$agent" "$display" "$backup" "$fingerprint"
}

hmn_render_plist() {
  label=$(hmn_xml "$1")
  bun=$(hmn_xml "$2")
  server=$(hmn_xml "$3")
  data=$(hmn_xml "$4")
  log=$(hmn_xml "$5")
  wrapper=$(hmn_xml "$6")
  keychain=$(hmn_xml "$7")
  run_user=$(hmn_xml "$8")
  run_group=$(hmn_xml "$9")
  port=$(hmn_xml "${10}")
  tz=$(hmn_xml "${11}")
  bun_dir=$(hmn_xml "$(dirname "$2")")
  llm_url=$(hmn_xml "${12:-}")
  llm_model=$(hmn_xml "${13:-}")
  llm_xml=""
  if [ -n "${12:-}" ]; then
    llm_xml="    <key>HMN_LLM_URL</key>
    <string>${llm_url}</string>
    <key>HMN_LLM_MODEL</key>
    <string>${llm_model}</string>"
  fi
  keychain_xml=""
  if [ -n "$7" ]; then
    keychain_xml="    <key>HMN_KEYCHAIN</key>
    <string>${keychain}</string>"
  fi
  user_xml=""
  if [ -n "$8" ]; then
    user_xml="  <key>UserName</key>
  <string>${run_user}</string>
  <key>GroupName</key>
  <string>${run_group}</string>"
  fi
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- HMN launchd job. Do not put secrets in this file. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${wrapper}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${server}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardErrorPath</key>
  <string>${log}.wrapper</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HMN_DATA_DIR</key>
    <string>${data}</string>
    <key>HMN_SERVER_DIR</key>
    <string>${server}</string>
    <key>HMN_BUN</key>
    <string>${bun}</string>
    <key>HMN_LOG</key>
    <string>${log}</string>
    <key>HMN_PORT</key>
    <string>${port}</string>
    <key>HMN_TZ</key>
    <string>${tz}</string>
    <key>HMN_HOST</key>
    <string>0.0.0.0</string>
    <key>PATH</key>
    <string>${bun_dir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
${llm_xml}
${keychain_xml}
  </dict>
${user_xml}
</dict>
</plist>
EOF
}

hmn_safe_rm() {
  dir=$1
  [ -n "$dir" ] || return 0
  case "$dir" in
    */Application\ Support/HMN/data|*/var/hmn|/var/hmn|*/Library/Logs/HMN|*/var/log/hmn)
      rm -rf "$dir"
      ;;
    *)
      echo "Refusing to delete $dir" >&2
      return 1
      ;;
  esac
}

hmn_pick_model() {
  chip=$1
  gb=$2
  if [ "$chip" != "apple" ]; then
    printf '%s\n' "qwen2.5:3b"
    return 0
  fi
  if [ "$gb" -lt 12 ]; then
    printf '%s\n' "qwen2.5:3b"
  elif [ "$gb" -lt 24 ]; then
    printf '%s\n' "qwen2.5:7b"
  elif [ "$gb" -lt 36 ]; then
    printf '%s\n' "qwen2.5:14b"
  else
    printf '%s\n' "qwen2.5:32b"
  fi
}

hmn_render_ollama_plist() {
  bin=$(hmn_xml "$1")
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>org.hmn.ollama</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bin}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OLLAMA_HOST</key>
    <string>127.0.0.1:11434</string>
  </dict>
</dict>
</plist>
EOF
}

hmn_loopback_url() {
  case "$1" in
    http://127.0.0.1:*|http://localhost:*|http://[::1]:*) return 0 ;;
    *) return 1 ;;
  esac
}

# The Bun version that CI tests. The layout test checks that the workflow uses the same version.
HMN_BUN_VERSION=1.2.21
# The SHA-256 of each Bun download for that version, from the release on GitHub. A download with another hash is refused.
HMN_BUN_SHA256_AARCH64=fd886630ba15c484236ad5f3f22b255d287c3eef8d3bc26fc809851035c04cec
HMN_BUN_SHA256_X64=d84602f55bf72c45d5733e59c511c88598509fb44213ef0713a96a020d2b5f85

# Installs Bun $HMN_BUN_VERSION into $1/bin after a check of its SHA-256. No script from the network runs.
# HMN_BUN_URL_BASE changes the address, for a test.
hmn_install_bun() {
  _ib_dir=$1
  case "$(uname -m)" in
    arm64|aarch64) _ib_arch=aarch64; _ib_sum=$HMN_BUN_SHA256_AARCH64 ;;
    x86_64) _ib_arch=x64; _ib_sum=$HMN_BUN_SHA256_X64 ;;
    *) echo "There is no pinned Bun for $(uname -m)." >&2; return 1 ;;
  esac
  _ib_base=${HMN_BUN_URL_BASE:-https://github.com/oven-sh/bun/releases/download/bun-v$HMN_BUN_VERSION}
  _ib_tmp=$(mktemp -d)
  if ! curl -fsSL --max-time 300 -o "$_ib_tmp/bun.zip" "$_ib_base/bun-darwin-$_ib_arch.zip"; then
    rm -rf "$_ib_tmp"
    echo "The Bun download failed." >&2
    return 1
  fi
  _ib_got=$(shasum -a 256 "$_ib_tmp/bun.zip" | awk '{print $1}')
  if [ "$_ib_got" != "$_ib_sum" ]; then
    rm -rf "$_ib_tmp"
    echo "The Bun download does not have the expected SHA-256. It was not installed." >&2
    return 1
  fi
  mkdir -p "$_ib_dir/bin"
  unzip -q -o "$_ib_tmp/bun.zip" -d "$_ib_tmp" && mv "$_ib_tmp/bun-darwin-$_ib_arch/bun" "$_ib_dir/bin/bun" && chmod 755 "$_ib_dir/bin/bun"
  _ib_status=$?
  rm -rf "$_ib_tmp"
  return $_ib_status
}

# True when the path is inside a version manager. Such a path changes when the
# manager changes its version, and launchd then starts nothing.
hmn_bun_managed() {
  case "$1" in
    */.nvm/*|*/.volta/*|*/.asdf/*|*/.fnm/*|*/fnm_multishells/*|*/mise/*|*/.proto/*|*/.nodenv/*|*/node_modules/*)
      return 0
      ;;
  esac
  return 1
}

# Prints the Bun that the launchd job will use, or nothing. A Bun at a fixed
# address comes before the Bun on the path. $1 home, $2 dedicated (0 or 1),
# $3 the Bun on the path, which can be empty.
hmn_pick_bun() {
  _pb_home=$1
  _pb_dedicated=$2
  _pb_found=$3
  if [ "$_pb_dedicated" -eq 0 ] && [ -x "$_pb_home/.bun/bin/bun" ]; then
    printf '%s\n' "$_pb_home/.bun/bin/bun"
    return 0
  fi
  for _pb_dir in ${HMN_BUN_SYSTEM_DIRS:-/opt/homebrew/bin /usr/local/bin}; do
    if [ -x "$_pb_dir/bun" ]; then
      printf '%s\n' "$_pb_dir/bun"
      return 0
    fi
  done
  if [ -n "$_pb_found" ] && [ -x "$_pb_found" ] && ! hmn_bun_managed "$_pb_found"; then
    printf '%s\n' "$_pb_found"
    return 0
  fi
  if [ "$_pb_dedicated" -eq 1 ] && [ -x "$_pb_home/.bun/bin/bun" ]; then
    printf '%s\n' "$_pb_home/.bun/bin/bun"
  fi
  return 0
}

# True when a launchd job must not run from this folder. A cloud folder can
# change or lock a file while the server reads it. macOS asks for permission
# before a background job reads Desktop, Documents, or Downloads.
# $1 the folder, $2 home.
hmn_unsafe_location() {
  case "$1" in
    */Library/CloudStorage/*|*/Library/Mobile\ Documents/*|*/My\ Drive/*|*/Google\ Drive/*|*/Dropbox/*|*/OneDrive*/*)
      return 0
      ;;
    "$2"/Desktop/*|"$2"/Documents/*|"$2"/Downloads/*|"$2"/Desktop|"$2"/Documents|"$2"/Downloads)
      return 0
      ;;
  esac
  return 1
}

# True when a person is at the keyboard. An agent or a pipe is not a terminal.
hmn_interactive() {
  [ -t 0 ] && [ -t 2 ]
}

# Shows one secret to a person and to nobody else. It goes to the terminal's
# alternate screen, so it does not stay in the scroll-back, and it never goes
# to a pipe or a file. Returns 1 and shows nothing when no person is there.
# $1 a title, $2 the secret.
hmn_show_secret() {
  hmn_interactive || return 1
  printf '%s\nGet paper and a pen. Press Return to show it. ' "$1" >&2
  read -r _hs_reply || return 1
  (
    trap 'printf "\033[2J\033[H\033[?1049l" >&2; exit 130' INT TERM HUP
    printf '\033[?1049h\033[2J\033[H' >&2
    printf '%s\n\n    %s\n\n' "$1" "$2" >&2
    printf 'Press Return when it is on paper. This window then removes it. ' >&2
    read -r _hs_reply || true
    printf '\033[2J\033[H\033[?1049l' >&2
  )
}

# True when the HMN server answers on loopback. $1 the base URL, $2 the CA file.
# Without a readable CA file the certificate is not checked. The reply has no data.
hmn_health() {
  command -v curl >/dev/null 2>&1 || return 1
  if [ -r "$2" ]; then
    curl -fsS --max-time 3 --cacert "$2" "$1/health" 2>/dev/null | grep -q '"service":"hmn"'
  else
    curl -fsSk --max-time 3 "$1/health" 2>/dev/null | grep -q '"service":"hmn"'
  fi
}

# Waits for the server. $1 the base URL, $2 the CA file, $3 seconds.
hmn_wait_health() {
  _wh_left=$3
  while [ "$_wh_left" -gt 0 ]; do
    if hmn_health "$1" "$2"; then
      return 0
    fi
    _wh_left=$((_wh_left - 1))
    sleep 1
  done
  return 1
}

# True when a process listens on the port on this machine.
hmn_port_busy() {
  if command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$1" >/dev/null 2>&1
    return $?
  fi
  return 1
}

# The name of the process that listens on the port, when this user can see it.
hmn_port_owner() {
  command -v lsof >/dev/null 2>&1 || return 0
  lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 { print $1 " (pid " $2 ")" }'
}

# The SHA-256 of a certificate file, in the form that the server prints.
hmn_cert_fingerprint() {
  command -v openssl >/dev/null 2>&1 || return 0
  openssl x509 -in "$1" -outform DER 2>/dev/null | openssl dgst -sha256 2>/dev/null | awk '{ print $NF }'
}

# The value of one environment variable in the launchd plist.
hmn_plist_env() {
  awk -v key="$2" '$0 ~ "<key>" key "</key>" { getline; gsub(/<[^>]*>/, ""); gsub(/^[ \t]+|[ \t]+$/, ""); print; exit }' "$1"
}

hmn_install_help() {
  cat <<'EOF'
Usage: deploy/install.sh [--empty | --demo] [--dedicated-user] [--local-llm] [--server-dir DIR] [--bun PATH]
       deploy/install.sh --layout-only --prefix DIR [--dedicated-user] [--local-llm]

Installs HMN for this Mac. Running it again restarts the server and does not
delete the graph or rotate keys.

A new graph starts empty (--empty, for your own data) or with the fictional
demonstration (--demo, for a test). The demonstration cannot be removed later
as a whole. With neither option the install asks a person at a terminal, and
stops when no person is there. The options have no effect on a graph that
exists. --local-llm also installs a localhost-only
Ollama model sized for this Mac. --layout-only writes the files under --prefix
and does not call Bun, launchctl, or the Keychain.

The install checks the Mac before it changes anything. It shows the recovery
passphrase only to a person at a terminal. When an agent or a pipe runs it, the
passphrase stays in the Keychain, and "deploy/hmn passphrase" shows it later.
EOF
}

hmn_uninstall_help() {
  cat <<'EOF'
Usage: deploy/uninstall.sh [--prefix DIR] [--layout-only] [--purge [--yes]]

Stops the launchd job and removes the plist and menu files. The data directory
and the Keychain stay unless --purge is passed. --purge deletes the graph, its
backups, and the keys. It asks you to type the word purge. --yes skips the
question.
EOF
}

hmn_command_help() {
  cat <<'EOF'
Usage: deploy/hmn COMMAND

  install [options]   Install or repair HMN on this Mac. Safe to run again.
  status              Check the install. Exit 1 when a check failed.
  start               Start the server.
  stop                Stop the server.
  restart             Restart the server.
  logs [-f]           Show the end of the server log. -f follows it.
  pair                Make a pairing code for a phone. It is valid for 10 minutes.
  passphrase          Show the recovery passphrase to a person at a terminal.
  restore FILE [--replace]
                      Restore a backup with the paper passphrase. It stops the
                      server, makes a new owner key, and starts the server.
  renew-owner         Give the owner key a new secret and 90 more days.
  rotate-keys         Give the graph a new database key. The server keeps
                      running.
  renew-cert          Make a new certificate. Each phone then needs the new
                      fingerprint in Settings.
  update              Get the newest code, then install again and restart.
  uninstall [--purge] Remove the launchd job. --purge also deletes the graph.
  help                Show this text.
EOF
}
