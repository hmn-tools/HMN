# HMN interface

The visual language is a washed terminal. Black ink, warm paper, IBM Plex Mono, almost no colour. Colour is a whisper: a stripe, a cursor, a quiet row, a chip on a proposal. The mock-ups for Today, Agents, and the home screen are the reference for layout and type. Tokens live in one place on each platform: `server/src/tokens.ts` and `ios/HMN/Theme/Theme.swift`.

Demonstration copy in this document uses the fictional household from [SCHEMA.md](SCHEMA.md).

## Design system

The owner chose this system on 2026-11-23, after a review of the whole UI. Its name is Garden. The first design was all mono, on ruled paper, with ink borders. That design is retired on the phone.

The idea: white cards on a calm stone ground, one sans face, and ink for the main action. The four washed accents are from the first brief ("washed Vaillant, used sparingly"): teal is the body colour of the livery, and lilac, coral, and sand are its stripes. They do not replace ink.

### Colour

Each token has a light and a dark value. The phone chooses, from its own appearance setting. Dark Garden is a warm near-black ground with cards one step lighter. Ink turns light, so the one main button is a light pill with dark text.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| ground | `#EAEAE7` | `#121211` | The wall behind the cards. |
| card | `#FFFFFF` | `#252523` | Each group of rows. |
| ink | `#0D0D0D` | `#EDEDEA` | Text, and the one main button of a screen. |
| paper | `#F4F4F2` | `#121211` | Text on ink. |
| graphite | `#434343` | `#C6C6C1` | A sentence under a title. |
| stone | `#595956` | `#9E9E98` | Labels and second lines. Contrast 5.8 to 1 on the light ground, 6.9 to 1 on the dark ground. |
| hair | `#D3D3CF` | `#42423E` | The edge of a field and of a white button. |
| rule | `#ECECE9` | `#383835` | The line between two rows of one card. |
| teal | `#6FA8A0` | `#7DB8AF` | Alive: a done mark, a switch, a count. |
| teal dark | `#3F6F68` | `#8FC8BF` | Teal as text. Contrast 5.7 to 1 on a light card, 7.1 to 1 on a dark card. |
| teal tint | `#E8F1EF` | `#1E2E2B` | A message, a person chip, the sleeping panel. |
| lilac, coral, sand | `#9A8BB0`, `#D98A82`, `#E8CF8A` | `#A898BF`, `#E0958D`, `#E3CB88` | The band only. |
| danger | `#A33A2E` | `#EC8A7A` | Revoke, remove, and an error. |

Rules:

- A screen has one ink button. A second action is a white button or a text button.
- Teal is not a button colour. White text on teal fails the contrast rule.
- The band (lilac, coral, sand) is on a screen one time at most. It is 84 by 5 points, below the greeting on Today.
- Coral is not an error colour. An error uses danger.
- Colour is not the only signal. A tier has its name, and an error has its words.
- Each text takes a colour from the theme. A text with no colour of its own takes ink. A fixed system colour such as white or black is not used, because it does not change with the appearance.
- The widget has its own copy of card, ink, and graphite, in light and dark. The Live Activity card is always dark, with light text.

### Type

One sans face, IBM Plex Sans, for titles, rows, sentences, and buttons. Its files are in the iPhone app and the website since 2026-11-23. The system sans is the fallback, if a file does not load. IBM Plex Mono is for labels and data only. Each size follows the text size that the owner set on the phone.

| Role | Face and size | Use |
| --- | --- | --- |
| title | Sans 30 semibold | The greeting, and the name of a tab screen. |
| heading | Sans 22 semibold | The title of a proposal, an empty state. |
| row | Sans 16 medium | The title of a row. |
| body | Sans 16 | A sentence in a card. |
| text | Sans 14 | A second sentence, a value. |
| small | Sans 13 | The second line of a row. |
| label | Mono 11 medium, upper case | The label of a section or a field. |
| data | Mono 13 | A date mark, an id, a count. |

### Shape and space

- Space: 4, 8, 12, 16, 24.
- Corners: 10 for a small mark, 14 for a field, 18 for a card. A button and a chip are pills.
- A card has no border. It has one soft shadow.
- A control is at least 44 points tall.

### Components

Each one is in `ios/HMN/Theme/Theme.swift` or `ios/HMN/Views/ReviewSupport.swift`.

| Component | What it is |
| --- | --- |
| `.card()` | The one container: white, corner 18, soft shadow. |
| `PillButtonStyle` | Primary (ink), secondary (white), and danger (white with danger text). It shows the disabled state. |
| `TextButtonStyle` | A text button with an underline, 44 points tall. A danger form for Remove and Revoke. |
| `ChipButtonStyle` | One value of a small choice. The selected value is ink. |
| `FieldStyle` | A text field on white, corner 14. Its label is a `SmallLabel` above it. |
| `SmallLabel` | The mono label. |
| `MessageLine` | The result of an action, next to its control. An error has the danger colour. |
| `EmptyState` | One line and one smaller line, in a card. |
| `Stripe` | The band. |

### Other surfaces

Since 2026-11-24 the menu bar app, the widget, and the pages that the server serves use Garden, with the tokens above in light and dark. The menu bar app and the widget bundle IBM Plex Sans for text and keep Plex Mono for labels and data. The server pages name Plex Sans first and fall back to the system sans, because they load nothing from the network. The Public TRMNL deck stays one-bit black and white, with a thin rule and a plain label at the foot. The fridge keeps its own four inks.

### Voice

- Do not explain a rule that the owner did not ask about. The server refuses a score on a fixture, and no screen says so.
- Do not repeat what the screen or the button shows.
- The machine that runs HMN is "your HMN". Not "the server", "the Mac", or "the mini".
- A date is in the form of the owner, never a raw ISO value.
- Character is for the moments: no connection, nothing waiting, the first start. "Your HMN is sleeping." A working screen has plain words.
- A safeguard at a real decision stays, such as the three lines before a Private grant.

## Surfaces and what they may show

The phone, the widget, the lock screen, and the shared display are different ceilings over the same graph. The server decides. The app does not filter a full payload down, because a full payload would already have leaked.

| Surface | Ceiling | Demonstration Today |
| --- | --- | --- |
| Phone, unlocked | Private | The designed screen: three due, the concert, the race, the quiet fault. No passport note. |
| Vault, after Face ID or device passcode | Sealed | The sealed proposal and the sealed notes. This is the only place the Agents mock is fully readable. |
| Widget | Personal | Weekly notes, the garage reply, the quiet fault. The race is the "next" item, because the concert is Private. Due count is 2. |
| Lock screen (v1.1) and `/api/display` | Public | No greeting name. No tasks. The race, and the line that nothing public is due. |
| Agents, MCP | Personal. Private only while the owner's grant for that one key is open. Never Sealed. | They can read the race and the work tasks. They cannot read family, health, or the passport note. |

A section that loses every row is omitted. Counts are computed after the ceiling, so the phone can say "three things due" while the widget says "2 due" and the display says nothing is due. That is not a sync bug.

When the ceiling hides a row, the surface does not draw a checkbox that says "private". An omitted row is absent. The one exception is a sealed proposal on the phone: a fixed card, "Sealed", with no title, no names, and no reason. The display does not show that line.

## Navigation

The phone uses a custom tab bar, not the system one.

| Tab | Screen |
| --- | --- |
| Today | Daily orientation. Sun glyph. |
| People | People in the graph. Person glyph. |
| + | Capture sheet. Ink square, raised. |
| Projects | Projects in the graph. |
| Agents | Proposals. Shield glyph. A teal square sits on the icon when a proposal is pending. |

The wordmark at the top of Today opens Settings. Entity rows push a detail screen. There is no hamburger, no search field on Today, and no notification centre.

Browse of the other types (areas, goals, notes, events, places, assets, sources, habits) is a list in Settings called "The graph". It uses the same row and the same detail screen as People and Projects. Habits have a list and a detail view and no special editor in this build.

Weekly review is the Week control under the pager. It is not in the tab bar and it is not one of the four rotating screens.

## How screens rotate

TRMNL shows one screen, then later another. HMN does the same. The deck is fixed:

| Index | Id | What it is | This build |
| --- | --- | --- | --- |
| 1 | `today` | Orientation: due, family, fixtures, quiet. | Rendered. |
| 2 | `upcoming` | The next family dates and fixtures only. No tasks. | Rendered. |
| 3 | `commitments` | Open tasks in Work and Side project. | Rendered. |
| 4 | `quiet` | Open tasks with no date that have sat still. | Rendered. |

Week, Inbox, and Agents are rendered too, and they are not in the rotation. A swipe to the side moves through the deck screens, and a tap on a dot opens that screen. Week is the text button beside Hide.

The Today bar reads `> today · screen 1 of 4` whether or not the later screens are rendered. The count is the deck, not the number of finished renderers. A teal rectangle sits after the label, like a block cursor.

Refresh is hourly. The bar's right side is `12:30 → next 13:30` in the owner's zone: the time the screen was composed, then an hour later. The zone is the zone of the Mac, or `HMN_TZ` if it is set.

`GET /api/display` returns the TRMNL-style payload for the current screen. All four deck screens are ready, so the server advances one screen per hour and skips any that are later marked not ready. `GET /api/v1/screens` lists the deck. Forcing `?screen=today` does not move the cursor. Week, Inbox, and Agents are fetched by id and are not part of that rotation.

The phone's Today screen is screen 1. It does not auto-advance while the owner is looking at it. The dots under the cards show the position in the deck. A swipe to the left or right moves one screen, and a tap on a dot opens that screen. The first and the last screen stop there.

## Settings, pairing, and the key

The phone pairs with the mini. It does not ship with a baked-in owner key.

Settings asks for:

- Server URL. On a phone this is the Mac mini's LAN or Tailscale address, not `127.0.0.1`. Traffic is TLS. There is no HTTP port.
- The certificate fingerprint shown by the server at startup. The app pins it and refuses a different certificate.
- A pairing code from the mini (`hmn pair` prints a short code and a payload). The code is single use and dies in ten minutes. The server returns a device key once.

The device key is stored in the Keychain (`org.hmn`, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`). It is not written into UserDefaults and it is not put in the widget snapshot. The address and the fingerprint are written whenever they change and when the app leaves the screen, both to UserDefaults and to a second Keychain item next to the device key, so a later launch can still show them. Settings says "This phone is already paired" once the key is present. The app does not show the key again after save. It shows the device name, scope, and maximum tier from `GET /api/v1/me`.

A pasted key is a fallback for a credential the server has already issued. It is stored the same way. The owner key that can read Private from curl should stay on the mini. The phone's device key is the one that may request a vault grant.

Opening the vault runs a biometric or device-passcode prompt (`LocalAuthentication`) and only then calls `POST /api/v1/vault/grants`. The grant is five minutes. The vault opens from a Sealed card in Review and from Settings > Privacy, which says "The vault is open until 14:05." and has **Close**. The phone closes it at that time, and when the app leaves the screen. The server cannot check that Face ID actually ran. The Keychain and the prompt are the control. That limit is stated in one line on the vault sheet: "This phone asks before it opens the vault. The mini cannot see Face ID."

Below that, Connections lists Calendar, Health, and Sport as "Not installed". There is no switch. Copy under the list: "Plugins are not in this build. Nothing is fetched."

A "The graph" section links to each entity type. "Privacy" and "Activity" are the other two rows.

If the server cannot be reached, Today first restores the last snapshot this phone saved (the phone-ceiling copy in the app's own defaults, or the widget snapshot if that is all it has). The snapshot was built from a phone-ceiling or widget-ceiling response already, and it is cleared by Hide. A card says "Your HMN is sleeping." If a snapshot is present, the last day stays below in a lighter tone, with "This is your day as this phone saw it at 12:39." If the phone is already paired and there is no snapshot: "This phone cannot reach it now. The pairing is still saved." Only an unpaired phone sees the first-run card, "Pair this phone with your HMN to begin."

The widget reads a snapshot the app writes into the App Group `group.org.hmn`. The app fills that snapshot only from `GET /api/v1/screens/today` with surface `widget`. Private and Sealed fields are never written into the group. The key stays in the Keychain. Signing team is unset in the project. The App Group works once a team is selected and the group exists; until then the widget shows the unset state. This has to be confirmed in Xcode.

## Today

Header: the mark, the date as a label, and a control that opens Settings.

Then, top to bottom:

1. Greeting, as the title. `Good morning`, `Good afternoon` (from 12:00), or `Good evening` (from 17:00). On the phone, then the name of the person whose kind is `self`, when that person is within the ceiling. "Good afternoon, Alex." On the display, the name is omitted because the person is Personal: "Good afternoon."
2. The band.
3. One card for each section. The label of the section is in the card, with a count where it has one.
4. **Overdue.** Open tasks whose due date is before today, the oldest first, at most four with the count on the right. The second line says how late: "3 days late". A task leaves Overdue when it is done or has a new date.
5. **Due today.** Open tasks whose due date is today in the owner's zone. A circle, the title, the second line. The second line is the linked project or person or asset, then `· by 17:00` when the due value has a time. A tap on the circle marks the task as done. A line "Done: ..." with **Undo** shows after it.
6. **Family.** Events of kind `family` in the next seven days that are not over, at most four. "4 of 9" on the right when there are more; Upcoming has the rest. The mark of the row is the day of the month. Title is `Yves · school concert` when the event is with one person and the stored title does not already include the name. Second line is `Fri 13/11 · 16:30`.
6a. **Expiring soon.** Each value of a field of the type `expiry` (an asset's renewal, a car's insurance, any expiry field the owner made) that ended in the last 30 days or ends in the next 30, soonest first, at most four. "4 of 9" on the right when there are more. The second line is the field's name and the time: "Insurance ends · ends in 12 days", "ends tomorrow", "ends today", "ended 3 days ago". A row with two expiry fields has two lines. The glyph is the flag, and a tap opens the row. It sits after Overdue and Due today because it needs a decision as they do, and before Family because a lapsed insurance matters more than a school concert. It is not on the lock screen, the widget, the display, the fridge, or a member's Home, because an expiry can be a passport. Upcoming has the same section for the next 60 days (not the past), first, at most eight.
7. **On the calendar.** Today's events from a mirrored calendar that are not over, in time order, with an event of several days that covers today ("Since Mon 23/11"). An all-day event marked free time goes last. The second line is the start time, or "All day".
8. **To watch.** The events of kind `fixture` that start in the next 36 hours, at most three: tonight, or early tomorrow when a league plays in another time zone. When more start in that time, their count is on the right. The Upcoming screen lists the rest of the week. The lock screen still names the next fixture, on any day. A badge such as `GT` is allowed when it is a series name, never a result. The second line is the start and the zone label.
9. **Routines.** The owner's own habits that are due today by their days. A routine for a child is the household's, and it is on Home and the fridge.
10. **Quiet.** Open tasks with no due date whose `updated_at` is 14 or more days ago. With one item the label is "Quiet for 21 days" in teal. The mark is a dashed teal circle. The second line is "No date".

**When an item leaves.** An event leaves every screen when it is over: an all-day event at the end of its last day, a timed event at its end, or one hour after its start when the calendar gives no end (two hours for a fixture). A cancelled event never shows. The next event (the lock screen and the widget) is the first that has not started, else one that is on now. A date that the server cannot read is no date on a screen, and a write with such a date is refused.

The server also makes one sentence from the counts, for example "Three things due, one family date, and one thing that has gone quiet." The widget and the display show it. The phone shows it only when Today has no section, as "The day is clear."

The pages of Today are today, upcoming, commitments, quiet, and week. A row of five marks above the tab bar selects one. The row does not move when the content changes.

**Not paired.** A card: "Hello." and "Pair this phone with your HMN to begin.", with the button **Pair this phone**. After a pairing, Settings closes and Today loads.

**No answer.** When the phone is paired and your HMN does not answer, a card shows the figure of the mark on its side, with three letters "z". Title: "Your HMN is sleeping." If a snapshot was restored, the line is "This is your day as this phone saw it at 12:39." and the last day stays below, in a lighter tone, and its circles do nothing. If there is no snapshot: "This phone cannot reach it now. The pairing is still saved." The button is **Knock again**. The pairing on this phone is not cleared. The phone waits at most 8 seconds for an answer.

**Other states.** Each has its own card above the last day, so the owner knows what to do:

- "Your HMN had a fault." It answered with a fault of its own. **Try again**.
- "This phone is not paired any more." The key was removed, or the server was set up again. **Pair again** opens Settings.
- "Your HMN has a new certificate." The pin refused it. **Pair again** opens Settings.
- "This phone is hidden. It shows Public only." A line, not a block: the day below is real, at Public.

Today reads again when the app comes back to the front and when the day changes. A tick shows at once. If the server refuses it, the tick goes back and one line under the page says why, for a few seconds.

Hide is in Settings, under Privacy. The phone drops to the public ceiling, clears the widget snapshot, and tells the server to force that device to Public. The app asks first, because the phone cannot undo it: **Show my things** is in the menu bar of the Mac that runs HMN. While the phone is hidden, Settings and Privacy say so in one line. Hide does not delete anything.

A mirrored event is read-only. A change to its title, its time, or its text is refused with "This event comes from a calendar. Change it in the calendar." The owner can make one mirrored event more private, and can put notes and links around it.

Inbox tasks (status `inbox`) are not on Today. Done tasks are not on Today. Sealed rows are not on Today. Health and money do not appear here.

## Capture and the inbox

The plus button, the Inbox control under the pager, the share sheet, the shortcut "Add to HMN", and the widget's plus all open the same inbox. Siri and the share sheet can also drop text in without the owner typing it twice. A mail forwarder or webhook posts to `POST /api/v1/inbox/in`. An agent uses the MCP tool `capture_inbox`, which only adds a row.

The sheet is a washed terminal list, not a form with types.

- One field. The owner dumps text, a link, or both. `#todo`, `#person`, `#idea`, `#read`, `#family`, `#area/health` are tags, typed with a hash. Suggestions come from tags the owner has used, Life Areas, and entity names, and only from records this surface can already see.
- Personal is the default. One tap marks the capture Private. `#private` or `#sealed` does the same and wins if it is stricter. `#sealed` needs the vault before the phone will show it back.
- Save puts it in the inbox. It does not create a task.

Shortcuts also has **Send to HMN**, for automations. It takes text, a URL, or JSON, plus an optional tag and a tier hint. The hint can raise the capture to Private or Sealed. It cannot make it Public. Examples are in [SHORTCUTS.md](SHORTCUTS.md). Voice notes are not in this build.

Each row shows the words and the route the tags suggest: a task, a person, a reading note, or an area. A row with no route says "Waiting". That one stays until the owner files it, or until the triage worker does. The worker reads the inbox through the policy layer, so a private row is not in its list.

Processing is a swipe. Accept files the suggestion and keeps the inbox id on the new record. Archive puts it aside. Delete removes it. A tap retags the row, or files it onto something search already returns. There is no score, no streak, and no confetti.

Empty copy, on the phone and on the inbox screen: "Inbox zero." and "Nothing waiting to be placed."

"What's today" speaks the personal snapshot already saved for the widget. It does not read the phone's private list, and it does not open the vault.

## Agents and confirm-before-save

The Agents screen is one proposal at a time, the oldest pending proposal the ceiling can see. A sealed proposal ahead of it is not skipped silently. If the oldest is sealed and the vault is closed, the screen is the sealed state below, not the next personal proposal. It is not a list with badges.

Top label: "Agents · 1 waiting", or "Agents · nothing waiting".

Headline, from the agent name and the operation:

- create task → "Trip helper would like to add one thing."
- update → "Trip helper would like to change one thing."
- delete → "Trip helper would like to remove one thing."
- link or unlink → "Trip helper would like to link two things."

The card has the source and the kind of change as its label, for example "Trip helper · new task", then the title of the item. Below the card, **Decline** and **Approve**. After a decision a line shows "Approved: ..." with **Undo**, or "Declined: ...".

Morning, Week, and Triage use this same card. So do People, Fixtures, and Goals. Morning's proposal is the Today focus line and the first three items it was allowed to see. Week's proposal is the weekly review. Triage's proposal is a task, a person, or a link from a captured note. People's proposal is a birthday, an anniversary, or a note that it has been a while; a family one stays Private. Fixtures proposes a "What to watch" note with no results. Goals proposes one next step. The headline uses that worker's name in place of Trip helper. The eye line still lists what the proposal says it read, and Health and Money stay in the denial. Nothing is written before Approve.

Settings for these workers is `GET /api/v1/workers.html` on the mini: tier, model, schedule, last run, and Pause.

The card:

- Header band in paper2: "Proposed · new task" and the local time, "Today 12:36".
- A tinted row with a teal `+` and the title, for a create. An update shows the new title the same way. A delete uses a plain row and no tint.
- Due, when present.
- Linked, as chips. A person chip uses teal tint, teal border, and teal-dark text. Any other chip is white with a hairline border.
- Why, the reason.

Under the card, an eye icon and two sentences. The first is what this proposal says it read: "This time it read: People, Tasks, one note." The second is fixed for an agent key: "It cannot see Health or Money, and cannot write without you." The denied names come from the key. If a key was granted health, that name is not in the sentence.

Buttons, pinned above the tab bar: **Decline** (outline) and **Approve** (ink fill). Between the buttons and the tab bar, the text button **Edit first**.

Edit first opens a sheet with title, due date, and reason. Save writes those fields back onto the pending proposal. It does not approve. Links are shown and not editable in this build. That limit is stated on the sheet: "Links stay as proposed."

Approve asks the server to apply the proposal. The screen then shows the next pending proposal, or the empty state.

Decline marks it rejected. The graph does not change. This screen stays one proposal at a time.

Under the card, and also when nothing is waiting:

- **Review all N from Triage.** One line for each source that has two or more waiting proposals. It opens Review: a list of that source's proposals, each with a tick. All rows start ticked. Headline: "Read the list. Then decide once." Two buttons carry the count: **Decline 4** and **Approve 4**. A row with no tick stays in the queue. A sealed proposal shows a lock, cannot be ticked, and is decided on the Agents screen after the vault opens. After the decision, one line: "4 approved." When the list closes, Review keeps that line with **Undo all**, which takes back each approval of that list.
- **Activity.** Decided proposals, newest first, as cards: the title, then the source, the outcome ("approved", "accepted by a rule", "declined", "expired", "undone"), the tier, and the time. **Undo** is on a card that can be undone. That includes an approved removal: undo brings the item back. **Let it be proposed again** is on a declined, expired, or undone card of a worker. A source that is a key shows the name that the owner gave it: "Agent key: research", or "Guest: Mara". The id of a key is not shown.
- **Rules.** Headline: "Review is the default." One card for each worker, plugin, import, and outside agent, with the choices **Review**, **Auto**, and **Deny**. An outside agent and an import have no Auto. Below the cards: "Always waits for you. A delete. A change to a tier or an area. Sealed data. An outside agent. No rule changes these."

Settings has **Agent keys**. Headline: "One key for each agent." The line below it: "An agent key reads up to Personal and can only propose. A view key reads, and it cannot propose. You can stop one and leave the others." A view key has the word "view" on its card and the line "A view reads, and it cannot propose. It cannot get Private." The form for a new key starts with the switch "A view. It reads Public rows, and it cannot propose." The small label at the top is "Keys" and the count of active keys. One card for each key: the name, where it runs, what it reads up to, the end date of the key, and the last use. A key at Personal has **Give Private for a time**. That opens a screen made from the real graph: "Private adds 6 rows.", the count by type, five example titles, what stays closed, and three lines to read before the grant: the model of this client receives the text, HMN cannot take it back, and the grant ends on a date. The owner picks 7, 30, or 90 days. The button says "I understand. Give Private for 30 days". A key with the grant shows "Private until 11/12/2026" and **End Private now**. Each active key has **Give busy times** or **Stop busy times**, and **Revoke**. A key with the permission shows "reads busy times" in its line. A guest shows "guest" in its line, with one sentence: "A guest is the agent of another person. It can propose an event or leave a message. Each one waits for you." Under the cards, a field makes a new key. The key itself is not shown on the phone.

Settings has **Areas and kinds**. Headline: "Your areas, in your words." One card for each area: the name, its kind, the tier of its items, and one sentence for the role of the kind, for example "Health summaries go to this area. No agent reads it." A form adds an area: a name, a kind, and the tier of its items. The tier is "From the role" at the start, and one line says what that gives: "With this kind, the items are Sealed." Under the areas, the kinds of each type are listed with the role, "built in", and how many items use the kind. A kind that is not built in and not in use has **Remove**. A form adds a kind: the type, a name, and a role. The phone makes the stored word from the name, so "Side project" is stored as `side_project`. A new title for a kind is set through the API.

Settings has **Calendars**: each mirrored calendar with its event count, its tier, its approval, whether it gives busy times, and the last read, then a form to add one. **Give busy times** on a calendar shows one sentence: "A key that you allow gets the times in which you are busy. It gets no title and no other detail." The address field hides its text, because the address is a secret. The log of private reads in Settings is named **Audit log**, so that it is not confused with Activity. A worker does not propose a declined item again. A proposal about a date, such as a birthday, leaves the list on the day after that date.

Sealed state, vault closed. No card, no chips, no why. Headline: "Sealed". One button: **Open the vault**. Decline and Approve are not offered until the owner can read the proposal. The owner should not approve what the owner has not seen.

Empty state, in place of the card and the buttons: "Nothing is waiting." The headline is omitted. The tab count disappears. The Review tab shows the number of proposals that the owner can read now, in a small teal mark. A Sealed proposal with the vault closed is not counted, because a mark on the tab would be a second signal and the line of copy is enough. When the vault is open, it counts.

A proposal that fails to apply (the person was deleted, the payload breaks the fixture rule) stays pending and the screen shows the server's message under the buttons. The owner can decline it.

## Graph browse and entity detail

People and Projects are tabs. The other types are reached from Settings. Each browse screen is a single column:

- Label: the type, uppercase, and the count.
- Rows: title, and a subtitle of kind or status in stone.
- No avatars, no photos, no presence dots.

Empty: "No one here yet." for people, "No projects yet." for projects, and "Nothing here yet." otherwise.

Detail:

- Title.
- Kind, status, area, due, in a definition list like the proposal card (label in stone, value in ink).
- Body, if there is one.
- Links, as chips that push the other entity.
- Privacy. The effective tier, then "Inherited from Family" or "Set on this item". Tapping offers Public, Household, Personal, Private, Sealed. Moving down toward Public on the phone asks one line of confirmation: "This will show on shared displays." when the new tier is Public, or "This will show on the widget." when the new tier is Personal. Setting or reading Sealed requires the vault. The change is audited.
- A property stricter than its entity shows as its own line ("this field is sealed") and the value is absent until the ceiling allows it.
- Provenance in stone: "Seed", "You", "Trip helper", or a plugin name, plus the time.
- For a fixture, a line: "Results are not stored."
- Destructive action: Delete, which soft-deletes after a confirmation. Write key required. An agent key is told to propose it instead, and the button becomes "Propose removal".

There is no rich editor. The owner can change title, status, due date, and body. That is enough to file an inbox item or give a quiet task a date.

## Weekly review

Built. One card, same chrome as Today, opened from the Week control under the pager. It is not one of the four rotating screens. What needs a decision comes first. Sections, each omitted when empty:

| Section | Content |
| --- | --- |
| Slipped | Open tasks whose due date is before today, the oldest first. The second line says how late. |
| Expiring soon | The expiry fields that ended in the last 30 days or end in the next 7, soonest first. It is after Slipped because a lapsed renewal needs a decision as a late task does, and before the week ahead. |
| Next 7 days | Today and the next seven days in one list in time order: open tasks with a date, family dates, and fixtures that are not over. A task names its day. |
| On the calendar | The mirrored events of the next seven days that are not over, in time order, with the day and the time. At most 12. The label on the right is "next 7 days", or "12 of 30" when there are more. A family date and a fixture are in Next 7 days, not here. |
| Done | Tasks done in the last seven days, by the time they were done, the newest first. |
| Goals | Active goals and their status. No progress bars. |
| Quiet | The same quiet rule as Today. |

Summary line, examples: "Two things done, one slipped, no project moved." Closing line, always: "Decide what next week is for. Leave the rest."

No charts, no comparison with last week, no "you usually".

## Yearly review

Built on 2026-11-24. "The year" is the last card of the week page. It opens one sheet for a calendar year. Chips at the top change the year when the record has more than one. Sections, each omitted when empty:

| Section | Content |
| --- | --- |
| Your note | One Private note that the owner writes for the year: "What was this year for?" It sits above the record. |
| Goals | The goals made or changed in the year, and the active goals made before its end. The status: Active, Reached, or Paused. |
| Finished | The projects done in the year, with the month. A list is not a project here. |
| Month by month | For each month: the things done and the family dates. A month with neither is left out. |
| People | At most five people, by the dates and the done tasks with them or for them in the year. The owner is not one of them. |
| Still open | The tasks added in the year that are not done, the oldest first, at most five. For a past year the label is "Carried on". |

Summary line, example: "212 things done, 4 projects finished, 2 goals reached, and 31 notes." The note of the year is not counted. Closing line, always: "Write down what the year was for. Keep what matters." The title is "Your 2026 so far." in the year itself, and "Your 2025." after it.

No charts, no streaks, no comparison with another year.

## Privacy lens

Settings → Privacy. Four short lines, one per tier, in the words from the tier table in [PRODUCT.md](PRODUCT.md). Then the current ceiling: "This phone can see up to Private. The vault is closed." **Open vault** runs the biometric prompt. **Hide** is the same panic as on Today. There is no dashboard of other people's access, because there are no other people.

The lens does not list sealed titles while the vault is closed. It can list Public, Personal, and Private titles the owner can already see, with their tier in stone, so the owner can spot an item that was left Public by mistake.

## Activity

Settings → Activity. The audit log. Each row is a time, an action (`read`, `write`, `approve`, `grant`, `panic`, `auth_failure`), a tier, and a surface. Titles are not repeated here. Sealed bodies are not repeated here. Empty: "No private reads yet." The list itself is Private. It is not on the widget or the display.

## Menu bar

The Mac menu bar is the same paper, the same type, and the same stripe. It is not a phone screen. It does not show Today, family names, or note titles.

It names the state of the server: Stopped, Starting, Running, Not answering, or Had a fault. The cards for phones, backups, and activity show only while it runs. Start, Stop, and Restart talk to launchd, and a button that does nothing in the current state is dimmed. **Hide my things** drops every paired phone to Public and does not delete anything. **Show my things** clears that. **Pair a phone** shows the eight-character code and a QR of the `hmn://pair` payload. Phones list with Revoke. Backups can be taken and restored. Activity is the audit list, plus one line for whether the hash chain verifies. A broken chain is in the danger colour as well as the words. Teal is not the only signal.

The owner key stays in the Keychain. The menu does not print it. Empty phones: "No phone is paired." Empty backups: "No backup yet." Empty activity: "No private reads yet." If the server is down: "Stopped" with "The server is not running. Press Start." An error sits inside the card of its button. The panel has one 16 point inset.

## Widgets and the lock screen

A snapshot from an earlier day does not look like today: the widget says "Not updated since Yesterday 12:30." and shows no count. It reads the time from the labels that the snapshot already has. A second timeline entry at midnight makes the change without the app. Medium shows "+2 more" when more than three are due.

Home screen widget, two sizes. The layout matches the home mock. The contents are the Personal ceiling, so they do not match the phone's counts.

**Small.** White card. "Today" and "2 due" with the demonstration data. A large numeral, the due count at this ceiling. Then "Next:" and the next visible event. That is the race, not the concert. If nothing is next: "Nothing coming."

**Medium.** White card. "HMN · Today" and "Updated 12:30". Up to three due-today titles that are Personal or Public, with square checkboxes. The demonstration rows are "Send weekly notes" and "Reply to garage about the coupe service". The dentist row is not here. If fewer than three are due, stop. Do not pad with family items or with a "private" placeholder.

The widget does not show quiet items, fixtures' results (there are none), proposal text, or anything Private or Sealed. Tapping opens the app on Today.

Lock screen accessories, the StandBy widget, and the Live Activity for the next event are Public. They read `GET /api/v1/screens/lock`, which stays Public even if the phone has a vault grant. The home-screen widget is a different snapshot and stays Personal. With the demonstration data the public card is the race and its start. A routine check-in on Today marks that habit for the day. It does not count streaks.

## Empty states

| Place | Copy |
| --- | --- |
| Today, nothing due or coming or quiet | "The day is clear." |
| Agents, no pending proposal | "Nothing is waiting." |
| Inbox | "Nothing waiting to be placed." |
| People | "No one here yet." |
| Projects | "No projects yet." |
| Any other browse | "Nothing here yet." |
| Search, later | "Nothing matched." |
| Server unreachable, unpaired | "Hello." / "Pair this phone with your HMN to begin." |
| Server unreachable, paired, no snapshot | "Your HMN is sleeping." / "This phone cannot reach it now. The pairing is still saved." |
| Server unreachable, paired, with snapshot | "Your HMN is sleeping." / "This is your day as this phone saw it at 12:39." |
| Widget, no snapshot | "Open HMN and set the server." |
| Fixture detail | "Results are not stored." |
| Sealed proposal, vault closed | "Sealed", and the button **Open the vault**. |
| Vault sheet | "This phone asks before it opens the vault. The mini cannot see Face ID." |
| Activity, empty | "No private reads yet." |
| Display, nothing public due | "Nothing public is due." |

## Motion and sound

No animation beyond the system sheet. No haptics on approve. No sound. The product should feel like paper that has already been set, not like something arriving.

## Accessibility

Ink on paper is the text contrast. Teal is never the only carrier of meaning: quiet rows also say "quiet", the agent mark is also the word Agents and the waiting count, the cursor is next to the screen name. Checkboxes are buttons with the task title as their label. Type sizes follow the table above and scale with Dynamic Type up to the point the card scrolls. The card scrolls vertically; the tab bar and the proposal buttons stay put.

## One grammar for the app (2026-11-27)

- Each screen has a side inset of 16 points.
- A tab root has a large title in the page. A pushed screen has a small title in the bar.
- The app writes a date as "Today", "Tomorrow", "Yesterday", "Fri 13 Nov", or "13 Nov 2027", and a time in the phone's own clock. A stored id is never on a screen: "Personal", not "personal".
- A chosen small chip is teal tint with a teal edge. Solid ink is for the main action only.
- A row that opens has a chevron. A done task has one mark, a filled teal circle with a tick.
- The tab bar has an icon and a word for each tab, on the owner's phone and on a member's. At the largest text sizes it shows the icons only.
