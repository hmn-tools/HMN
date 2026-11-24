#!/bin/sh
# A real install on a Mac that can be thrown away: the Keychain, launchd, the
# first boot, the plugin sandbox under launchd, and a purge. CI runs it on a
# macOS runner. It does not run on a Mac that has HMN, and it cannot test a
# reboot or a person at a terminal.
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$root"
# shellcheck disable=SC1091
. "$root/deploy/lib.sh"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This test needs a Mac." >&2
  exit 1
fi
if [ "${HMN_TEST_REAL_INSTALL:-}" != "1" ]; then
  echo "This test installs HMN for the login user and then purges it." >&2
  echo "Set HMN_TEST_REAL_INSTALL=1 on a Mac that has no HMN." >&2
  exit 1
fi
support="$HOME/Library/Application Support/HMN"
if [ -e "$support" ] || security find-generic-password -s hmn.kek -a hmn >/dev/null 2>&1; then
  echo "This Mac has an HMN install or an HMN key. The test does not run here." >&2
  exit 1
fi

data="$support/data"
menu="$support/menu.json"
plist="$HOME/Library/LaunchAgents/org.hmn.server.plist"
log="$HOME/Library/Logs/HMN/server.log"
base=https://127.0.0.1:8787
ca="$data/tls/ca.crt"
out=$(mktemp)
target="gui/$(id -u)/org.hmn.server"

fail() {
  echo "FAIL: $1" >&2
  # The output of a failed step helps, but a line with a key does not leave this Mac.
  if [ -s "$out" ]; then
    grep -v 'hmn_' "$out" >&2 || true
  fi
  for file in "$log" "$log.wrapper"; do
    if [ -s "$file" ]; then
      echo "The end of $file:" >&2
      tail -n 30 "$file" | grep -v 'hmn_' >&2 || true
    fi
  done
  exit 1
}
key() {
  security find-generic-password -s "$1" -a hmn -w
}
# The key goes to curl on standard input, so it is not in the process list.
status_of() {
  printf 'Authorization: Bearer %s\n' "$(key hmn.owner)" |
    curl -sS --max-time 10 --cacert "$ca" -H @- -H "X-HMN-Surface: phone" -o /dev/null -w '%{http_code}' "$base$1"
}
body_of() {
  printf 'Authorization: Bearer %s\n' "$(key hmn.owner)" |
    curl -sS --max-time 10 --cacert "$ca" -H @- -H "X-HMN-Surface: phone" "$base$1"
}
post() {
  printf 'Authorization: Bearer %s\n' "$(key hmn.owner)" |
    curl -sS --max-time 20 --cacert "$ca" -H @- -H "X-HMN-Surface: phone" \
      -H "Content-Type: application/json" -d "$2" "$base$1"
}
# How many working copies of the database are on disk. A working copy is not
# encrypted. Since 2026-11-23 the server keeps it in its memory only, so there is
# none on disk, while the server runs and after it stops.
working_copies() {
  for dir in "$(getconf DARWIN_USER_TEMP_DIR)" /tmp; do
    ls "$dir" 2>/dev/null | grep -E '^hmn-[0-9]+-[0-9a-f]{8}\.sqlite$' || true
  done | grep -c . || true
}
no_secret_in() {
  [ -f "$1" ] || return 0
  if grep -q 'hmn_' "$1"; then
    fail "$1 contains a key"
  fi
  if grep -qF "$words" "$1"; then
    fail "$1 contains the recovery passphrase"
  fi
}

echo "0. A key with no graph stops the install, and the install makes no file."
security add-generic-password -s hmn.kek -a hmn -w "a-key-that-a-test-left" -U >/dev/null 2>&1
if sh deploy/install.sh </dev/null >"$out" 2>&1; then
  fail "the install used a key that has no graph"
fi
grep -q 'there is no graph' "$out" || fail "the install did not name the key with no graph"
[ ! -e "$support" ] || fail "a refused install made files"
if launchctl print "$target" >/dev/null 2>&1; then
  fail "a refused install loaded the job"
fi
sh deploy/hmn status >"$out" 2>&1 || true
grep -q 'there is no graph' "$out" || fail "the status did not name the key with no graph"
security delete-generic-password -s hmn.kek -a hmn >/dev/null 2>&1

echo "0b. A new graph needs a decision. With no person and no option, the install makes no file."
if sh deploy/install.sh </dev/null >"$out" 2>&1; then
  fail "the install selected a start for the new graph by itself"
fi
grep -q 'Pass --empty' "$out" || fail "the install did not ask for --empty or --demo"
[ ! -e "$support" ] || fail "an install with no decision made files"

echo "1. An install with no person at a terminal, with the demonstration."
sh deploy/install.sh --demo </dev/null >"$out" 2>&1 || fail "the install failed"
grep -q 'The new graph has the fictional demonstration.' "$out" || fail "the install did not name the start"
grep -q 'The server answers on' "$out" || fail "the install did not report a server that answers"
grep -q 'was not shown' "$out" || fail "the install did not say that the passphrase was not shown"
for item in hmn.kek hmn.owner hmn.agent hmn.display hmn.backup; do
  security find-generic-password -s "$item" -a hmn >/dev/null 2>&1 || fail "the Keychain does not have $item"
done
words=$(key hmn.backup)
count=$(printf '%s' "$words" | tr '-' '\n' | grep -c .)
[ "$count" -eq 13 ] || fail "the recovery passphrase has $count words"
for file in "$out" "$log" "$log.wrapper" "$plist" "$menu" "$support/install.manifest"; do
  no_secret_in "$file"
done
mode=$(stat -f %OLp "$data")
[ "$mode" = "700" ] || fail "the data directory has mode $mode"
launchctl print "$target" >/dev/null 2>&1 || fail "launchd does not have the job"
hmn_health "$base" "$ca" || fail "the server does not answer"
job_bun=$(hmn_plist_env "$plist" HMN_BUN)
if hmn_bun_managed "$job_bun"; then
  fail "the job uses a Bun inside a version manager: $job_bun"
fi
echo "   The job uses $job_bun."

echo "2. The owner key from the Keychain reads Today."
code=$(status_of /api/v1/screens/today)
[ "$code" = "200" ] || fail "Today answered $code"
case "$(body_of '/api/v1/search?q=Side%20project')" in
  *'Side project'*) ;;
  *) fail "the demonstration is not in the graph" ;;
esac

echo "3. The plugin child runs in its sandbox under launchd."
post /api/v1/source '{"title":"Test calendar","kind":"calendar","properties":{"approval":"review"}}' >/dev/null
day=$(date -u -v+2d +%Y%m%d)
ics="BEGIN:VCALENDAR\\nBEGIN:VEVENT\\nUID:install-test-1\\nSUMMARY:Install test event\\nDTSTART:${day}T010000Z\\nEND:VEVENT\\nEND:VCALENDAR"
reply=$(post /api/v1/plugins/calendar/tick "{\"ics\":\"$ics\"}")
case "$reply" in
  *'"proposals":[{'*) ;;
  *)
    printf '%s\n' "$reply" | cut -c 1-400 >&2
    fail "the calendar plugin made no proposal"
    ;;
esac

echo "4. The status command."
sh deploy/hmn status >"$out" 2>&1 || true
for line in 'The data directory is private.' 'The certificate matches the pin.' 'Bun is in place.' \
  'Keychain has hmn.kek.' 'Keychain has hmn.owner.' 'Keychain has hmn.backup.' 'The server is loaded.' \
  'The server answers on port 8787.'; do
  grep -qF "$line" "$out" || fail "the status did not say: $line"
done
# A CI runner has no FileVault. Nothing else may need the owner.
if ! grep -q 'Nothing here needs you.' "$out"; then
  grep -q 'FileVault is off.' "$out" || fail "the status found a problem that is not FileVault"
fi

echo "5. The pairing command."
sh deploy/hmn pair >"$out" 2>&1 || fail "the pairing command failed"
grep -q 'Pairing code: [A-Za-z0-9]' "$out" || fail "there is no pairing code"
pinned=$(sed -n 's/.*"fingerprint": "\([^"]*\)".*/\1/p' "$menu" | head -n 1)
grep -q "Certificate fingerprint: $pinned" "$out" || fail "the pairing command shows a different fingerprint"

echo "6. The passphrase command refuses a pipe."
if sh deploy/hmn passphrase </dev/null >"$out" 2>&1; then
  fail "the passphrase command ran with no terminal"
fi
no_secret_in "$out"

echo "7. A second install keeps the graph and the keys."
owner_before=$(key hmn.owner | shasum -a 256)
sh deploy/install.sh </dev/null >"$out" 2>&1 || fail "the second install failed"
[ "$(key hmn.owner | shasum -a 256)" = "$owner_before" ] || fail "the second install changed the owner key"
[ "$(key hmn.backup)" = "$words" ] || fail "the second install changed the recovery passphrase"
again=$(sed -n 's/.*"fingerprint": "\([^"]*\)".*/\1/p' "$menu" | head -n 1)
[ "$again" = "$pinned" ] || fail "the second install changed the certificate pin"
if grep -q 'recovery passphrase' "$out"; then
  fail "the second install spoke about a new passphrase"
fi
no_secret_in "$out"
code=$(status_of /api/v1/screens/today)
[ "$code" = "200" ] || fail "Today answered $code after the second install"

echo "8. Stop, start, and restart. No working copy of the database is on disk at any time."
[ "$(working_copies)" -eq 0 ] || fail "a server that runs has $(working_copies) working copies on disk, not 0"
sh deploy/hmn stop >"$out" 2>&1 || fail "stop failed"
if hmn_health "$base" "$ca"; then
  fail "the server answers after stop"
fi
[ "$(working_copies)" -eq 0 ] || fail "the stop left a working copy of the database on disk"
sh deploy/hmn start >"$out" 2>&1 || fail "start failed"
hmn_health "$base" "$ca" || fail "the server does not answer after start"
sh deploy/hmn restart >"$out" 2>&1 || fail "restart failed"
hmn_health "$base" "$ca" || fail "the server does not answer after restart"
[ "$(working_copies)" -eq 0 ] || fail "after a restart there are $(working_copies) working copies on disk, not 0"
code=$(status_of /api/v1/screens/today)
[ "$code" = "200" ] || fail "Today answered $code after the restart"

echo "8b. A server that was killed leaves a copy, and the next start removes it."
server_pid=$(pgrep -f "bun src/index.ts" | head -n 1)
[ -n "$server_pid" ] || fail "the server process was not found"
kill -KILL "$server_pid"
# The supervisor starts a new server about 2 seconds later.
sleep 4
hmn_wait_health "$base" "$ca" 30 || fail "the server did not come back after a kill"
[ "$(working_copies)" -eq 1 ] || fail "after a kill and a new start there are $(working_copies) working copies, not 1"
code=$(status_of /api/v1/screens/today)
[ "$code" = "200" ] || fail "Today answered $code after a kill"

echo "9. An uninstall keeps the graph, and the next install opens it."
sh deploy/uninstall.sh >"$out" 2>&1 || fail "the uninstall failed"
[ ! -f "$plist" ] || fail "the plist is still there"
[ -f "$data/hmn.sqlite.enc" ] || fail "the uninstall removed the graph"
sh deploy/install.sh </dev/null >"$out" 2>&1 || fail "the install over an old graph failed"
[ "$(key hmn.owner | shasum -a 256)" = "$owner_before" ] || fail "the install over an old graph changed the owner key"
code=$(status_of /api/v1/screens/today)
[ "$code" = "200" ] || fail "Today answered $code after the install over an old graph"
no_secret_in "$out"
no_secret_in "$log"

echo "10. A purge needs a person or --yes."
if sh deploy/uninstall.sh --purge </dev/null >"$out" 2>&1; then
  fail "a purge ran with no person and no --yes"
fi
[ -f "$data/hmn.sqlite.enc" ] || fail "a refused purge removed the graph"
hmn_health "$base" "$ca" || fail "a refused purge stopped the server"
sh deploy/uninstall.sh --purge --yes >"$out" 2>&1 || fail "the purge failed"
[ ! -d "$data" ] || fail "the purge left the data directory"
sleep 3
[ "$(working_copies)" -eq 0 ] || fail "the purge left a working copy of the database on disk"
if launchctl print "$target" >/dev/null 2>&1; then
  fail "the purge left the launchd job"
fi
for item in hmn.kek hmn.owner hmn.agent hmn.display hmn.backup hmn.audit.tip; do
  if security find-generic-password -s "$item" -a hmn >/dev/null 2>&1; then
    fail "the purge left $item in the Keychain"
  fi
done

sh deploy/hmn status >"$out" 2>&1 || true
grep -q 'HMN is not installed on this Mac.' "$out" || fail "the status after a purge did not say that HMN is not installed"

echo "11. An empty start has the keys and no demonstration."
sh deploy/install.sh --empty </dev/null >"$out" 2>&1 || fail "the empty install failed"
grep -q 'The new graph is empty.' "$out" || fail "the install did not name the empty start"
words=$(key hmn.backup)
no_secret_in "$out"
case "$(body_of /api/v1/screens/today)" in
  *'"sections":[]'*) ;;
  *) fail "Today of an empty graph has sections" ;;
esac
case "$(body_of '/api/v1/search?q=Side%20project')" in
  *'Side project'*) fail "an empty graph has the demonstration" ;;
esac
# A restart does not write the demonstration into an empty graph.
sh deploy/hmn restart >"$out" 2>&1 || fail "the restart of the empty graph failed"
case "$(body_of '/api/v1/search?q=Side%20project')" in
  *'Side project'*) fail "a restart wrote the demonstration into an empty graph" ;;
esac
sh deploy/install.sh --demo </dev/null >"$out" 2>&1 || fail "an install over the empty graph failed"
grep -q 'has no effect' "$out" || fail "the install did not say that --demo has no effect on a graph that exists"
case "$(body_of '/api/v1/search?q=Side%20project')" in
  *'Side project'*) fail "--demo changed a graph that exists" ;;
esac
sh deploy/uninstall.sh --purge --yes >"$out" 2>&1 || fail "the last purge failed"
[ ! -d "$data" ] || fail "the last purge left the data directory"

rm -f "$out"
echo "The real install test passed."
