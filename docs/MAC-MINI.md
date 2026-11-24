# Mac mini

HMN runs on the owner's Mac. This is the install for that machine: a launchd job, keys in the Keychain, and a menu bar app. The iPhone setup after this is the first-run list in [RUNNING.md](RUNNING.md). Docker is still an alternative and is unchanged.

Nothing here opens a port on the router. The server listens on TLS, port 8787. Use the LAN, or Tailscale, for the phone.

## Before the install

- macOS 14 or later. The menu bar app does not run on an older system.
- FileVault is on. Encryption of the database is not a substitute for it.
- The repo lives somewhere stable, for example `~/hmn`. The launchd job runs Bun from that checkout. The install refuses a checkout in a cloud folder (Google Drive, iCloud Drive, Dropbox, OneDrive) or in Desktop, Documents, or Downloads. A background job cannot read those folders reliably.
- Do not set `HMN_INSECURE_DEV_KEK`. That flag is for a Linux test runner.

## Install for the login user

This is the path that matches the Keychain. The job is a LaunchAgent. It starts when you log in, which is when the login Keychain unlocks. A mini that is powered on but still at the login window will not unwrap the database.

From the repo:

```sh
deploy/hmn install
```

A new graph needs one decision first. `--empty` starts a graph with the three keys and the default kinds, for your own data. `--demo` starts with the fictional demonstration, for a test. The demonstration cannot be removed later as a whole. The way back is `deploy/hmn uninstall --purge` and a new install, which makes new keys and a new recovery passphrase. With neither option the install asks a person at a terminal. When no person is there, it stops and changes nothing. The options have no effect on a graph that exists.

`deploy/hmn install` runs `deploy/install.sh` with the same options. The script is safe to run again. A second run rewrites the job and restarts the server. It does not delete the graph and it does not rotate keys.

What it does:

1. Checks the Mac before it changes anything. It stops if the checkout is in a cloud folder or a protected folder, or if another process has port 8787. It also stops if the Keychain has `hmn.kek` and the data directory has no graph. Such a key is from another install or from a test, and the server would use it for the new graph with no message. It prints a note if FileVault is off or macOS is older than 14.
2. Selects a Bun at a fixed address: `~/.bun/bin/bun`, then Homebrew, then the Bun on the path. A Bun inside a version manager (nvm, Volta, asdf, fnm, mise) is not used, because its address changes with the manager. If no Bun at a fixed address exists, the script installs the Bun version that CI tests into `~/.bun`. `--bun PATH` selects one yourself.
3. Creates `~/Library/Application Support/HMN/data` and sets it to mode `0700`.
4. If this is a new graph, starts the server once, lets it create the Keychain item `hmn.kek`, the TLS certificate, and the wrapped keys, then stops it.
5. On that first boot the server stores `hmn.owner`, `hmn.agent`, `hmn.display`, and `hmn.backup` in the login Keychain. The script does not write the passphrase or the API keys into a file or the log.
6. Writes `menu.json` next to the data directory. That file has the server URL, the certificate fingerprint, and the launchd label. It has no secrets.
7. Installs `~/Library/LaunchAgents/org.hmn.server.plist` and bootstraps it.
8. Waits until the server answers on `/health`. If it does not answer in 30 seconds, the script shows the end of the log and exits with an error.
9. Shows the recovery passphrase, on a new graph only. See the next section.

### The recovery passphrase

The passphrase is 13 words. Write it on paper. The script shows it only to a person at a terminal. It asks you to press Return, shows the words on a separate screen, and removes them when you press Return again. The words do not stay in the scroll-back of the window.

If an agent, a script, or a pipe runs the install, the passphrase is not shown and it is not in the output. It stays in the Keychain item `hmn.backup`. Open Terminal yourself and run:

```sh
deploy/hmn passphrase
```

That command also refuses a pipe. The API keys are never printed. If the Keychain refuses a key, the script shows that key to a person at a terminal in the same way, and stops with an error when no person is there.

## Day to day

One command covers the usual tasks. Each one has the same effect as the matching item in the menu bar app.

| Command | What it does |
| --- | --- |
| `deploy/hmn status` | Runs the health check. Exit 1 when a check failed. |
| `deploy/hmn start`, `stop`, `restart` | Controls the launchd job, then says whether the server answers. |
| `deploy/hmn logs` | Shows the end of the server log. `-f` follows it. |
| `deploy/hmn restore <file>` | Stops the server, asks for the paper passphrase, restores the backup, makes a new owner key in the Keychain, and starts the server. On a mini that has a graph, add `--replace`. Pair each phone again after it. |
| `deploy/hmn renew-owner` | Gives the owner key a new secret and 90 more days, and puts it in the Keychain. It works up to 30 days after the end date. |
| `deploy/hmn pair` | Reads the owner key from the Keychain, makes a pairing code with it, and prints the three values that the iPhone app needs: the code, the certificate fingerprint, and the server URL. |
| `deploy/hmn passphrase` | Shows the recovery passphrase to a person at a terminal. |
| `deploy/hmn update` | Runs `git pull --ff-only`, then the install again with the options of the first install. The server restarts. |
| `deploy/hmn uninstall` | Removes the launchd job. See "Uninstall". |

A stop is clean. launchd sends TERM to the supervisor, the supervisor sends it to the server at once, and the server saves the graph and removes its working copy. `stop`, `restart`, and the install wait for that, for a maximum of 25 seconds. The working copy of the database is in the memory of the server process only. A kill or a power cut leaves no plaintext file. A start removes a plaintext copy that a version from before 2026-11-23 left in the temporary folder. A save writes a complete new file and puts it in place in one step, so a kill during a save leaves the old graph.

The health check (`deploy/doctor.sh`) reads: the mode of the data directory and the certificate key, the certificate against the pin in `menu.json`, the Bun and the checkout that the job points at, FileVault, the Keychain items, the launchd job, an answer from `/health`, the age of the newest backup, and a configured local model. Each line that needs you says what to do.

The server log is `~/Library/Logs/HMN/server.log`. The supervisor rotates it when the process starts and when it grows past one megabyte, and keeps five older files. The server does not reopen a log on SIGHUP, so the supervisor restarts the process to rotate a large log. A restart from the menu does the same.

The certificate is the one the server creates under `data/tls` on first boot. The fingerprint in `menu.json` is the one the server prints. The menu bar pins that fingerprint and refuses a different certificate. ATS is relaxed in the menu app for the same reason it is relaxed on the phone: the certificate is a private CA, and the pin is the check.

## Menu bar

Open `mac/HMNMenu.xcodeproj` and run HMNMenu. There is no Apple team and no provisioning profile. The project ad-hoc signs so macOS will launch it (`CODE_SIGN_IDENTITY` is `-`). The app is not sandboxed: it has to call `launchctl` and read the Keychain items the installer created with `security`.

The menu item is the word HMN. It shows:

- Whether launchd has the job, and whether `GET /health` answered.
- Start, Stop, and Restart.
- Hide. Every paired phone drops to Public. The owner key on the mini is not hidden, so the menu can undo it. Nothing is deleted. Show my things clears it.
- Pair a phone. The code and a QR code. The QR is the `hmn://pair` payload from `POST /api/v1/pairing`. The code is single use and dies in ten minutes.
- Phones, with Revoke.
- Back up, and Restore. Restore asks once, then replaces the graph with that encrypted backup.
- Activity. The audit rows are a time, an action, a tier, and a surface. Titles are not shown. A line says whether the hash chain verifies.

If the owner key is missing from the Keychain, the menu has a secure field. Paste the key from the first boot. It is stored as `hmn.owner` and not shown again.

Build from the command line, still without a team:

```sh
xcodebuild -project mac/HMNMenu.xcodeproj -scheme HMNMenu \
  -destination 'platform=macOS' -configuration Debug test \
  CODE_SIGN_STYLE=Manual 'CODE_SIGN_IDENTITY=-' CODE_SIGNING_REQUIRED=NO \
  DEVELOPMENT_TEAM= ENABLE_HARDENED_RUNTIME=NO
```

`mac/project.yml` describes the same targets for XcodeGen. The committed `xcodeproj` is what CI builds.

## Dedicated user

```sh
sudo deploy/install.sh --dedicated-user
```

This creates `_hmn` with shell `/usr/bin/false` and home `/var/hmn`, puts the data directory at `/var/hmn` mode `0700`, and installs a LaunchDaemon that runs as `_hmn`. The KEK is created in the System keychain so the job can start at boot without a login session. The owner key is also copied into the login Keychain of the user who ran sudo, which is what the menu bar reads.

This path has to be confirmed on the mini. The System keychain item is created with an ACL that allows `security` and Bun to read it without a prompt. If a reboot starts the daemon and the server exits because it cannot read `hmn.kek`, use the login-user install instead. A copy of `/var/hmn` without the System keychain still does not unwrap the database.

## Uninstall

```sh
deploy/uninstall.sh
```

This bootstraps the job out and deletes the plist, the wrapper, and `menu.json`. The data directory and the Keychain stay.

```sh
deploy/uninstall.sh --purge
```

This also deletes the data directory and the Keychain items `hmn.kek`, `hmn.owner`, `hmn.agent`, `hmn.display`, `hmn.backup`, and `hmn.audit.tip`. The backups are in the data directory, so they go too. It will not delete a path that is not the HMN data or log directory. It does not delete the git checkout.

A purge cannot be undone. The script lists what it will delete and asks you to type the word `purge`. It asks before it stops the server, so a refusal changes nothing. With no person at a terminal it refuses, unless `--yes` is passed.

`--layout-only --prefix DIR` writes or removes the files under that directory and does not call Bun, launchctl, or the Keychain. The layout tests use it.

## Docker

Docker remains the other way to run the server. The compose file does not contain a key. Create the secret from the Keychain and mount it, as [RUNNING.md](RUNNING.md) says. The menu bar talks to `https://127.0.0.1:8787`, so a container must publish that port on localhost. The admin routes still require the peer to be loopback. Do not put a reverse proxy in front of them.

## Admin routes

The menu uses the existing loopback routes for pairing, backup, revoke, and the audit log. These were added because the menu had no way to list phones, hide every phone at once, list backups, or restore one. All of them require a write key and a loopback socket. `X-Forwarded-For` is not consulted.

| Method and path | What it returns |
| --- | --- |
| `GET /api/v1/admin/status` | Version, certificate fingerprint, how many phones are paired, how many are hidden, backup count. |
| `GET /api/v1/admin/devices` | Id, name, scope, tier, expiry, revoked time, forced ceiling. No key hash. |
| `POST /api/v1/admin/panic` | Sets every live phone to Public. One audit row per phone. |
| `POST /api/v1/admin/panic/clear` | Clears that. Audited as `panic_clear`. |
| `GET /api/v1/admin/backups` | File name, size, and time. Not the bytes and not a directory path. |
| `POST /api/v1/admin/restore` | Body `{ "name": "backup-….hmn" }`. A name with a slash or `..` is rejected. Audited as `restore`. |

A phone's own Hide is still `POST /api/v1/panic` on that device. The menu's Hide is the one that covers every phone. A phone cannot end Hide. Show my things in the menu ends it for every phone.

## What CI proves

The `install` job in `.github/workflows/mac.yml` runs `deploy/test/install.mac.test.sh` on a macOS runner. That is a real install for a login user, with a real Keychain file and real launchd. The runner uses a temporary keychain, not a login Keychain that was unlocked by a login. The test shows:

- A key with no graph stops the install, and the refused install makes no file.
- A new graph with no decision and no person stops the install, and it makes no file. `--empty` gives a graph with no demonstration, a restart does not add the demonstration, and `--demo` does not change a graph that exists.
- An install with no person at a terminal finishes, the server answers, and the output, the logs, the plist, and `menu.json` contain no key and no recovery passphrase.
- The owner key from the Keychain reads Today.
- The calendar plugin child makes a proposal when the server runs under launchd, so `sandbox-exec` works in that context.
- `deploy/hmn status`, `pair`, `stop`, `start`, and `restart` work, and `passphrase` refuses a pipe.
- A stop or a kill leaves no working copy of the database on disk.
- A backup appears in `data/backups` each day. With `HMN_BACKUP_COPY_DIR` in the plist, a copy appears on the second disk too.
- `deploy/hmn restore` with the paper passphrase works on a second Mac.
- A second install, and an install after an uninstall, keep the graph, the keys, and the certificate pin.
- A purge without a person and without `--yes` removes nothing. A purge with `--yes` removes the data, the job, and the Keychain items.

The test cannot show a reboot, a login, a Keychain that a login unlocks, FileVault, the passphrase screen in a real Terminal window, the menu bar app against this install, or a phone.

## Verify on the mini

This repository was not run on the owner's Mac. Confirm these there:

- `deploy/install.sh` as the login user, then a second run, leaves the graph in place and the server answering.
- After a reboot and a login, launchd starts HMN and the Keychain unlock does not leave the server crash-looping. The log must not contain `hmn_` secrets or the recovery passphrase.
- FileVault is on.
- The menu bar item appears, Start and Stop match `launchctl print`, and the certificate pin rejects a replaced `server.crt`.
- Pairing from the QR works once. The same code does not work again. Revoke makes that phone's secret fail.
- Show on the fridge: the code is on the BWRY panel after a press of its button, the iPhone camera reads it from across the kitchen, and HMN opens and pairs. The fridge goes back to its screen within a minute.
- Hide removes Private rows from the phone and leaves the owner key on the mini able to read them. Show my things brings the phone back.
- A backup file does not contain plaintext titles. Restore returns the graph to that copy. The recovery passphrase from the first boot is on paper, not in the backup folder.
- `GET /api/v1/audit/verify` in the menu matches a direct curl, and editing a row in the database makes the menu say the chain does not verify.
- `sudo deploy/install.sh --dedicated-user` if you use it: `_hmn` can read `hmn.kek` from the System keychain after a reboot without a GUI prompt, and a normal user cannot.
- The menu app is ad-hoc signed only. A Developer ID or notarized build was not made.
