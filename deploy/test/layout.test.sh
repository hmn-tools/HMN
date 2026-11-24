#!/bin/sh
# File layout, log rotation, and boot-log parsing. No Keychain and no launchd.
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$root"
# shellcheck disable=SC1091
. "$root/deploy/lib.sh"

sh -n deploy/lib.sh
sh -n deploy/install.sh
sh -n deploy/uninstall.sh
sh -n deploy/hmn-run.sh
sh -n deploy/doctor.sh
sh -n deploy/hmn

sh deploy/install.sh --help >/dev/null
sh deploy/uninstall.sh --help >/dev/null
sh deploy/hmn help | grep -q 'passphrase'
if sh deploy/hmn no-such-command >/dev/null 2>&1; then
  echo "an unknown command should fail" >&2
  exit 1
fi

# The install pins the Bun version that CI tests.
grep -q "bun-version: $HMN_BUN_VERSION" .github/workflows/ci.yml
if grep 'bun-version:' .github/workflows/*.yml | grep -v "bun-version: $HMN_BUN_VERSION"; then
  echo "a workflow uses a different Bun version from deploy/lib.sh" >&2
  exit 1
fi

# The launchd job gets a Bun at a fixed address, not one inside a version manager.
hmn_bun_managed /Users/a/.nvm/versions/node/v23.10.0/bin/bun
hmn_bun_managed /Users/a/.volta/bin/bun
if hmn_bun_managed /Users/a/.bun/bin/bun || hmn_bun_managed /opt/homebrew/bin/bun; then
  echo "a fixed Bun address was called managed" >&2
  exit 1
fi
buns=$(mktemp -d)
mkdir -p "$buns/home/.bun/bin" "$buns/home/.nvm/versions/node/v1/bin" "$buns/sys" "$buns/other" "$buns/empty"
for file in "$buns/home/.bun/bin/bun" "$buns/home/.nvm/versions/node/v1/bin/bun" "$buns/sys/bun" "$buns/other/bun"; do
  printf '#!/bin/sh\n' >"$file"
  chmod 755 "$file"
done
managed="$buns/home/.nvm/versions/node/v1/bin/bun"
test "$(HMN_BUN_SYSTEM_DIRS="$buns/sys" hmn_pick_bun "$buns/home" 0 "$managed")" = "$buns/home/.bun/bin/bun"
test "$(HMN_BUN_SYSTEM_DIRS="$buns/sys" hmn_pick_bun "$buns/home" 1 "$managed")" = "$buns/sys/bun"
test "$(HMN_BUN_SYSTEM_DIRS="$buns/sys" hmn_pick_bun "$buns/empty" 0 "$managed")" = "$buns/sys/bun"
test "$(HMN_BUN_SYSTEM_DIRS="$buns/none" hmn_pick_bun "$buns/empty" 0 "$buns/other/bun")" = "$buns/other/bun"
test -z "$(HMN_BUN_SYSTEM_DIRS="$buns/none" hmn_pick_bun "$buns/empty" 0 "$managed")"
test -z "$(HMN_BUN_SYSTEM_DIRS="$buns/none" hmn_pick_bun "$buns/empty" 0 "")"
rm -rf "$buns"

# A launchd job does not run from a cloud folder or a protected folder.
hmn_unsafe_location "/Users/a/My Drive/Projects/hmn/server" /Users/a
hmn_unsafe_location "/Users/a/Library/CloudStorage/GoogleDrive-x/hmn/server" /Users/a
hmn_unsafe_location "/Users/a/Library/Mobile Documents/com~apple~CloudDocs/hmn/server" /Users/a
hmn_unsafe_location "/Users/a/Documents/hmn/server" /Users/a
if hmn_unsafe_location "/Users/a/hmn/server" /Users/a || hmn_unsafe_location "/Users/a/repos/HMN/server" /Users/a; then
  echo "a plain folder was called unsafe" >&2
  exit 1
fi

# A secret is shown to a person at a terminal, never to a pipe or a file.
shown=$(hmn_show_secret "A title" "amber-basin-cedar" </dev/null 2>&1 || true)
if [ -n "$shown" ]; then
  echo "a secret went to a pipe" >&2
  exit 1
fi
if sh deploy/hmn passphrase </dev/null >/tmp/hmn-pass.out 2>&1; then
  echo "the passphrase command should refuse a pipe" >&2
  exit 1
fi
grep -q 'only to a person at a terminal' /tmp/hmn-pass.out
rm -f /tmp/hmn-pass.out

# A command that needs an install says so.
if HMN_PREFIX=$(mktemp -d) sh deploy/hmn pair >/tmp/hmn-pair.out 2>&1; then
  echo "pair should fail with no install" >&2
  exit 1
fi
grep -q 'not installed' /tmp/hmn-pair.out
rm -f /tmp/hmn-pair.out

if sh deploy/install.sh --layout-only >/dev/null 2>&1; then
  echo "layout-only without a prefix should fail" >&2
  exit 1
fi

parsed=$(hmn_parse_boot_log deploy/test/fixtures/first-boot.log)
printf '%s\n' "$parsed" | grep -qx 'owner=hmn_owner'
printf '%s\n' "$parsed" | grep -qx 'agent=hmn_agent'
printf '%s\n' "$parsed" | grep -qx 'display=hmn_display'
printf '%s\n' "$parsed" | grep -qx 'backup=amber-basin-cedar-delta-ember-flint-grove-harbor-ivory-juniper-kelp-linen-maple'
printf '%s\n' "$parsed" | grep -qx 'fingerprint=abcdef1234'

next=$(hmn_parse_boot_log deploy/test/fixtures/next-boot.log)
printf '%s\n' "$next" | grep -qx 'owner='
printf '%s\n' "$next" | grep -qx 'fingerprint=abcdef1234'

dir=$(mktemp -d)
printf '0123456789' >"$dir/server.log"
hmn_rotate_log "$dir/server.log" 4
test -f "$dir/server.log.1"
test ! -f "$dir/server.log"
printf 'abcdef' >"$dir/server.log"
hmn_rotate_log "$dir/server.log" 4
test -f "$dir/server.log.2"
rm -rf "$dir"

# The supervisor passes a stop to the server at once, and the server can close cleanly.
# launchd kills a job that is still there 20 seconds after TERM.
sup=$(mktemp -d)
mkdir -p "$sup/server/src"
cat >"$sup/bun" <<'FAKE'
#!/bin/sh
# Stands in for the server: it runs until TERM, then records a clean stop.
trap 'echo stopped >>"$HMN_FAKE_MARK"; exit 0' TERM
echo "$$" >"$HMN_FAKE_MARK.pid"
echo started >>"$HMN_FAKE_MARK"
while true; do
  sleep 1 &
  wait $!
done
FAKE
chmod 755 "$sup/bun"
HMN_FAKE_MARK="$sup/mark" HMN_LOG="$sup/logs/server.log" HMN_SERVER_DIR="$sup/server" HMN_BUN="$sup/bun" \
  sh deploy/hmn-run.sh &
sup_pid=$!
tries=0
while [ ! -f "$sup/mark" ] && [ "$tries" -lt 50 ]; do
  tries=$((tries + 1))
  sleep 0.1
done
grep -q started "$sup/mark"
kill -TERM "$sup_pid"
tries=0
while kill -0 "$sup_pid" 2>/dev/null && [ "$tries" -lt 50 ]; do
  tries=$((tries + 1))
  sleep 0.1
done
if kill -0 "$sup_pid" 2>/dev/null; then
  kill -KILL "$sup_pid" 2>/dev/null || true
  kill -KILL "$(cat "$sup/mark.pid")" 2>/dev/null || true
  echo "the supervisor did not stop in 5 seconds" >&2
  exit 1
fi
grep -q stopped "$sup/mark" || {
  echo "the server did not get the stop signal" >&2
  exit 1
}
rm -rf "$sup"

prefix=$(mktemp -d)
sh deploy/install.sh --layout-only --prefix "$prefix" --bun /usr/bin/true
data="$prefix/Library/Application Support/HMN/data"
plist="$prefix/Library/LaunchAgents/org.hmn.server.plist"
menu="$prefix/Library/Application Support/HMN/menu.json"
test -d "$data"
test -f "$plist"
test -f "$menu"
test -x "$prefix/Library/Application Support/HMN/hmn-run.sh"
mode=$(stat -c %a "$data" 2>/dev/null || stat -f %OLp "$data")
test "$mode" = "700"
grep -q 'HMN_DATA_DIR' "$plist"
grep -q 'Do not put secrets' "$plist"
if grep -q 'hmn_' "$plist" "$menu"; then
  echo "plist or menu.json contains a key" >&2
  exit 1
fi
if grep -q 'passphrase' "$plist"; then
  echo "plist mentions a passphrase" >&2
  exit 1
fi
sum1=$(cksum "$plist" "$menu")
sh deploy/install.sh --layout-only --prefix "$prefix" --bun /usr/bin/true
sum2=$(cksum "$plist" "$menu")
test "$sum1" = "$sum2"

sh deploy/uninstall.sh --layout-only --prefix "$prefix"
test ! -f "$plist"
test ! -f "$menu"
test -d "$data"
sh deploy/uninstall.sh --layout-only --prefix "$prefix"
sh deploy/uninstall.sh --layout-only --prefix "$prefix" --purge
test ! -d "$data"

dedicated=$(mktemp -d)
sh deploy/install.sh --layout-only --prefix "$dedicated" --dedicated-user --bun /usr/bin/true
dplist="$dedicated/Library/LaunchDaemons/org.hmn.server.plist"
grep -q '<string>_hmn</string>' "$dplist"
grep -q 'HMN_KEYCHAIN' "$dplist"
grep -q 'System.keychain' "$dplist"
dmode=$(stat -c %a "$dedicated/var/hmn" 2>/dev/null || stat -f %OLp "$dedicated/var/hmn")
test "$dmode" = "700"
sh deploy/uninstall.sh --layout-only --prefix "$dedicated" --purge

test "$(hmn_pick_model apple 8)" = "qwen2.5:3b"
test "$(hmn_pick_model apple 16)" = "qwen2.5:7b"
test "$(hmn_pick_model apple 24)" = "qwen2.5:14b"
test "$(hmn_pick_model apple 48)" = "qwen2.5:32b"
test "$(hmn_pick_model intel 64)" = "qwen2.5:3b"

models=$(mktemp -d)
HMN_CHIP=apple HMN_MEM_GB=16 sh deploy/install.sh --layout-only --prefix "$models" --local-llm --bun /usr/bin/true
mplist="$models/Library/LaunchAgents/org.hmn.server.plist"
oplist="$models/Library/LaunchAgents/org.hmn.ollama.plist"
grep -q 'http://127.0.0.1:11434/api/chat' "$mplist"
grep -q 'qwen2.5:7b' "$mplist"
grep -q '127.0.0.1:11434' "$oplist"
if grep -q '0.0.0.0' "$oplist"; then
  echo "ollama plist is not localhost only" >&2
  exit 1
fi
if sh deploy/doctor.sh --prefix "$models" >/tmp/hmn-doctor.out 2>&1; then
  echo "doctor should notice a model that did not answer" >&2
  exit 1
fi
grep -q 'The local model did not answer.' /tmp/hmn-doctor.out
chmod 777 "$models/Library/Application Support/HMN/data"
if sh deploy/doctor.sh --prefix "$models" >/tmp/hmn-doctor.out 2>&1; then
  echo "doctor should fail when the data directory is open" >&2
  exit 1
fi
grep -q 'readable by others' /tmp/hmn-doctor.out
plain=$(mktemp -d)
sh deploy/install.sh --layout-only --prefix "$plain" --bun /usr/bin/true >/dev/null
sh deploy/doctor.sh --prefix "$plain" >/tmp/hmn-doctor-ok.out
grep -q 'No local model is configured.' /tmp/hmn-doctor-ok.out
grep -q 'Bun is in place.' /tmp/hmn-doctor-ok.out
grep -q 'Nothing here needs you.' /tmp/hmn-doctor-ok.out
# A layout has no Keychain and no launchd job, so the doctor does not read the real ones.
grep -q 'Keychain checks need an install on the Mac.' /tmp/hmn-doctor-ok.out
grep -q '^layout=1$' "$plain/Library/Application Support/HMN/install.manifest"
# The doctor names a job whose Bun is gone.
sed 's#<string>/usr/bin/true</string>#<string>/no/such/bun</string>#' \
  "$plain/Library/LaunchAgents/org.hmn.server.plist" >"$plain/plist.tmp"
mv "$plain/plist.tmp" "$plain/Library/LaunchAgents/org.hmn.server.plist"
if sh deploy/doctor.sh --prefix "$plain" >/tmp/hmn-doctor.out 2>&1; then
  echo "doctor should fail when Bun is gone" >&2
  exit 1
fi
grep -q 'a Bun that is not there' /tmp/hmn-doctor.out
# A purge without --yes is refused when no person is at a terminal, and nothing is removed.
if sh deploy/uninstall.sh --prefix "$plain" --purge </dev/null >/tmp/hmn-purge.out 2>&1; then
  echo "a purge ran with no person and no --yes" >&2
  exit 1
fi
grep -q 'Nothing was removed' /tmp/hmn-purge.out
test -d "$plain/Library/Application Support/HMN/data"
test -f "$plain/Library/LaunchAgents/org.hmn.server.plist"
rm -f /tmp/hmn-purge.out
sh deploy/uninstall.sh --layout-only --prefix "$models" --purge
sh deploy/uninstall.sh --layout-only --prefix "$plain" --purge
rm -rf "$models" "$plain" /tmp/hmn-doctor.out /tmp/hmn-doctor-ok.out

# An install with an older label: its two plists go, the new plist stays, and no other file is removed.
moved=$(mktemp -d)
sh deploy/install.sh --layout-only --prefix "$moved" --bun /usr/bin/true
agents="$moved/Library/LaunchAgents"
moved_manifest="$moved/Library/Application Support/HMN/install.manifest"
sed -i.bak -e 's/^label=.*/label=example.old.server/' -e "s#^plist=.*#plist=$agents/example.old.server.plist#" "$moved_manifest"
rm -f "$moved_manifest.bak"
touch "$agents/example.old.server.plist" "$agents/example.old.ollama.plist" "$agents/example.other.plist"
sh deploy/install.sh --layout-only --prefix "$moved" --bun /usr/bin/true
test ! -e "$agents/example.old.server.plist"
test ! -e "$agents/example.old.ollama.plist"
test -f "$agents/example.other.plist"
test -f "$agents/org.hmn.server.plist"
grep -q '^label=org.hmn.server$' "$moved_manifest"
rm -rf "$moved"

rm -rf "$prefix" "$dedicated"
echo "layout tests passed"
