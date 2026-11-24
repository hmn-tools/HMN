# Changes

## Unreleased

Update the server and the iPhone app together.

- A new tier, Household, between Public and Personal. The fridge, the people of the home, and your own surfaces read it. A guest agent, the lock screen, and a Public display do not.
- The fridge: a TRMNL BWRY claimed at Household shows four household screens by the time of day, in four inks. See [docs/TRMNL.md](docs/TRMNL.md).
- Lists: a project of the kind `list` holds items. Tick an item, or bring a done one back with Again. Items stay off Today and the reviews. The evening fridge screen shows the newest list on one yellow row.
- Family tasks: a task can be for several people, and it can have steps. The server records who completed a task, and when. A client cannot write that name.
- New routes: `GET /api/v1/lists`, `GET /api/v1/items?parent_id=`, `POST /api/v1/items`.
- Knock again shows Knocking, gives a haptic, and says when the last knock got no answer.
- Household members: Settings > Household makes a pairing code for a person, as Partner or Child. A partner reads Household, and the Family area at Private on the phone. A child reads Household. A member's add and tick are applied with an undo in Activity. A removal, a change of tier or area, and a child's new date wait for you. Routes: `POST /api/v1/members/pairing`, `GET /api/v1/members`, `DELETE /api/v1/members/:id`.
- Member mode: a member's phone shows Home, Lists, and Family, and none of your tabs. Home greets the member, and shows the tasks for them, the household's day, the next days, and the next fixture. A tick that waits for you says "waiting for a yes". The member's Settings has Hide and Forget. Your app has a Family filter next to Projects and Lists. Routes: `GET /api/v1/screens/home`, `GET /api/v1/family-tasks`. `GET /api/v1/me` names the member.
- Pairing at the fridge: Settings > Household > Show on the fridge puts a member code on the fridge as a QR code, for twenty minutes. The phone camera opens HMN, which names the server and asks before it pairs. The code works once. Take it off, a new code, or Hide on your phone ends it. The fridge leaves out a name above Household. Routes: `GET` and `DELETE /api/v1/members/pairing/fridge`. A pairing link now carries the address (`url=`) when the server knows it, so a new phone needs no typing. The iPhone app opens `hmn://pair` links.
- Routines for the children: Projects > Family > New routine makes a routine for a person at Household, on some days of the week. A child sees today's routines first on Home and ticks them. A tick by mistake comes off with a second tap. A child ticks only the child's own routines. A partner sees and ticks every child's. There is no streak and no score. The morning and evening fridge screens show what is left for each child, or "all done". Your Today keeps your own habits only. Routes: `GET` and `POST /api/v1/routines`, `DELETE /api/v1/habits/:id/check-in`.
- The app and the services have the neutral id `org.hmn`: the bundle ids, the App Group, the Keychain service, and the launchd labels. `deploy/hmn update` stops the jobs with the older label, removes their two plists, and installs the new ones. On the phone, the app with the new id is a new app: pair it again, then delete the old app.
- The demonstration is in Perth time (`Australia/Perth`, AWST). A server with no zone from the caller uses UTC.
- The person page: People gives each person one line, the kind and the next date with them. A tap opens the person's page: the next dates, the open tasks with a tick, their routines, the notes about them, the things and people linked to them, and what was done in the last two weeks. Edit opens the record. A new person kind, Organisation, is for a school, a garage, or a doctor, and People lists organisations after the people. Routes: `GET /api/v1/people`, `GET /api/v1/person/:id/page`.

## 0.2.1, 2026-11-23

This version fixes the low findings of the security audit of 2026-11-23. Only the server and the scripts change.

- A key gets the same answer for a row that it cannot read and for a row that does not exist. An inbox item from a key gets one fixed answer. A journal gives no reason to a reader who cannot see its items. The audit routes are for the owner.
- A guest's inbox text is Personal, with no attachment, link, or chosen source.
- The audit check finds a head row that was edited behind the log. `deploy/doctor.sh` checks the audit head against the copy in the Keychain, and warns 60 days before the certificate ends.
- The TLS key is wrapped under the KEK, and the CA key is removed. At the first start of this version, an existing plain key is wrapped. The fingerprint does not change.
- TLS 1.2 allows only AEAD ciphers.
- New commands: `deploy/hmn renew-cert` (a new certificate; each phone needs the new fingerprint) and `deploy/hmn rotate-keys` (a new database key).
- Plugin secrets, model names, tool paths, Docker, CI, and the Bun download are hardened.
- Documented and not changed: the secret on the `security` command line, AES-GCM associated data for Sealed values, and rotation of the KEK and the Sealed key.

## 0.2.0, 2026-11-23

This version fixes the findings of the security audit of 2026-11-23. Update the server on the mini and install the new iPhone app together: the app and the server of this version expect each other.

### Before you update

- `deploy/hmn pair` now reads the owner key from the Keychain (`hmn.owner`). A pairing code needs the owner key.
- A phone cannot end its own Hide. Choose Show my things in the menu bar of the mini.
- The iPhone app accepts only an address that starts with `https://`.
- The key of an outside MCP client works only on the outside port (8788).
- Pair each phone again after `deploy/hmn restore`.

### The agent boundary

- A key that is not the owner's cannot make a row more visible through a proposal. The server checks at the proposal and at the approval.
- Each proposal has a summary from the server. The Review card shows each changed field with its value now, and a warning for a change of tier.
- A key reads only its own proposals. History and the inbox apply the limits of the key.
- The name on a card is the name that the owner gave the key. Hidden characters are removed.

### The admin plane

- A pairing code needs the owner key on the mini.
- A hidden phone cannot end Hide, pair a phone, or make a key.
- A revoke also revokes the keys that the credential made.
- Each port has its own lockout.
- A writer changes only a row that it can read.

### Cost and floods

- A request that changes nothing does not save the graph. Saves come at most once a second.
- Each key has a budget for proposals and inbox items.
- A declined proposal keeps only a short record.

### Storage and recovery

- The working copy of the graph is in memory only.
- A failed Keychain read stops the start, and no new key replaces the old one.
- Purge also removes the proposals and journals that hold the text.
- A restore keeps the revokes and Hide of the live graph.
- `deploy/hmn restore` restores a backup with the paper passphrase alone, also on a new Mac.
- A backup runs each day and keeps fourteen. `HMN_BACKUP_COPY_DIR` copies each one to a second disk.
- `deploy/hmn renew-owner` renews the owner key.

### Inputs and clients

- Worker calls to a cloud model have the egress record, the monthly cap, and a size limit.
- Calendar reads have limits on the address, time, size, and redirects. A family date from a subscribed feed waits for review.
- An e-ink display gets its key only at the first address that asked.
- The OAuth setup code is longer, and wrong codes have a limit.
- The iPhone app covers the app switcher, closes the vault in the background, refreshes the widgets on Hide, keeps unsent captures, and keeps the audit alarm until you tap it.

### Not in this version

- A review by a second person.
- A test on a real iPhone.
- The low findings that remain: the oracles of finding 29, AES-GCM with no associated data, TLS key renewal, and the Docker items.
