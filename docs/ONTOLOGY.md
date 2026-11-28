# The ontology of a life, and the surfaces around it

23/11/2026 · The owner answered the decisions on 23/11/2026 (section 8). The Household tier and the first fridge are built.

[PHILOSOPHY.md](PHILOSOPHY.md) says why HMN exists. [STRATEGY.md](STRATEGY.md) says where it sits. [SCHEMA.md](SCHEMA.md) says what the server stores now. This document says how the parts of a life fit together, what a person does with them, and which surface shows what to whom. It also adds the one thing that the first design left out: a household that shares a fridge.

## 1. Three questions that every object answers

Each object in HMN answers three questions. The screens and the rules use only these answers.

| Question | Answered by | Example |
| --- | --- | --- |
| What is it? | Its type, and its kind (a word that the owner chooses) | A task. An event of the kind "school". |
| Where does it belong? | Its area, and its links | In Family. With Yves. At the school. |
| Who may see it? | Its tier, from the item, or else from its area | Household. |

A screen never asks a fourth question, such as "is this a work thing". It asks for a role of an area, or for a kind with a role. This is already true for the rules ([kinds.ts](../server/src/kinds.ts)). This document makes it true for the surfaces too.

## 2. The objects

A life has more parts than an app has tables. HMN keeps a small set of types, and the owner's words go into kinds. A new part of life is a new kind, not a new type. A new type is added only when it needs its own lifecycle, its own screen grammar, or its own rule.

### 2.1 The map

| Layer | Question | Types | Kinds (examples, the owner's words) |
| --- | --- | --- | --- |
| Domains | What part of my life? | area | family, work, health, money, home, sport, cars |
| Who | Who is involved? | person | me, spouse, child, friend, colleague, organisation |
| Where | Where does it happen? | place | home, school, office, garage |
| What I have | What do I own or hold? | asset | car, house, device, document |
| What I want | What am I working toward? | goal, project, task, habit | list, item, family task, routine |
| When | What is fixed in time? | event | family date, appointment, fixture, trip, school |
| What I know | What do I keep? | note, source | idea, reference, document text, import |
| What arrives | What came in and is not filed? | inbox item, proposal | capture, agent proposal |

Each type exists now. The new parts are shown in bold in the next table: they are new kinds and new uses, not new types.

### 2.2 Each type, its lifecycle, and its one line

The "one line" is the second line of a row on every surface. A type always uses the same grammar, so the eye learns it once.

| Type | Lifecycle | One line on a row | Notes |
| --- | --- | --- | --- |
| area | active, archived | its kind, and how many open items | The top of the map. Sets the default tier of what is filed in it. |
| person | (none) | relation, and the next date with them | "Spouse · Fri dinner". An organisation is a person of the kind `organisation`: a school, a garage, a doctor. |
| place | (none) | address line | Linked from events with `at`. |
| asset | active, gone | its kind, and the next date about it | "Car · service 2 Dec". A renewal is a task or an event linked to the asset. |
| goal | active, paused, done | horizon | "This year". |
| project | active, paused, someday, done | area, and how many open tasks | **A project of the kind `list` is a list**: shopping, packing, gifts. See 2.4. |
| task | inbox, open, done | project or person, and when | "Weekly brief · by 17:00". **A task of the kind `item` is an item of a list.** |
| habit | active, paused | cadence, who, and last done | **A habit is also a routine for a child**: "Feed the cat · Every day · Luca". A routine shows on the member's Home, in Family, and on the fridge. See 2.5. |
| event | upcoming, past, cancelled | day, time, place | "Fri 13/11 · 16:30 · School". A fixture adds its badge, never a result. |
| note | open, archived | what it is about | Text that the owner keeps. A document note keeps what the owner reasons about: an expiry date, a renewal, a link to the item in the password manager. The number of the document stays in the password manager. |
| source | (none) | where facts came from | Written by the server. The owner does not file into it. |
| inbox item | new, filed, dismissed | when, and from where | "08:12 · share sheet". It becomes a typed object, or it goes. |
| proposal | pending, approved, declined, expired, undone | who, and what it changes | The summary from the server, with each field and its value now. |

### 2.3 The links

Seven relations cover a life. They exist in the code now. This table fixes their meaning, so that agents and screens use them the same way.

| Relation | From, to | Meaning | Example |
| --- | --- | --- | --- |
| `part_of` | task to project, project to goal | is a step of | "Book flights" is part of "Lisbon trip". |
| `in` | anything to area | belongs to the domain | (Usually the `area_id` field. The link is for a second area.) |
| `with` | event or task to person | involves this person | Dentist with Luca. |
| `for` | task or asset to person | is done for, or belongs to, this person | Gift for Sam. The car belongs to Alex. |
| `about` | note or task to anything | is about | A note about the garage. |
| `at` | event to place | happens at | Concert at the school. |
| `from` | anything to source | came from | Event from the family calendar. |

Rules:

- A link takes the stricter tier of its two ends. A link to a hidden row is absent.
- **`for` on a task, a list item, or a routine names who can do it** ("Sam, Alex", "Luca"). A family task can have several. This is the one new use, and it needs no new relation.
- No other relation is added until two real cases need it.

### 2.4 Lists, the one new shape

A household needs shared lists: groceries, packing, the things to take to school. A list is not a project of commitments. Its items are small, many, and they come back.

- A list is a project of the kind `list`. An item is a task of the kind `item`, `part_of` that list.
- Ticking an item marks it done. A done item can come back with "Again", so the grocery list keeps its usual items.
- Items do not appear on Today, in the weekly review, or in the "quiet" section. Only the list shows them.
- The tier of a list is the tier of its items. The grocery list is Household. A gift list for Sam is Private.

This needs no new type. `item` is a fixed kind of task in code, as `task` is, because the screens read it. A list is a project of the kind `list`. A task of the kind `item` is in no list of tasks, on no screen, and in no review: only its list or its task shows it.

### 2.5 Shared family tasks, and routines for the children

The owner's answer on 23/11/2026: the household needs family tasks that more than one person can complete, for example "Renew Yves's passport". Chores are useful only as small tasks for the children.

**A shared family task** is an ordinary task. Nothing new is stored.

- It is at the Household tier, and it has `for` links to each person who can do it: "Sam, Alex".
- Any one of those people can complete it. The record keeps who completed it and when.
- It can have steps. A step is a task of the kind `item`, `part_of` the task, as on a list: "Photo", "Form", "Appointment". The task is done when someone marks it done. A step does not close it by itself.
- The passport number is not in HMN. It stays in the password manager (STRATEGY.md, "Boundaries"). The note keeps the expiry date and a link to the vault item. A Sealed fact stays Sealed. The task links to the note with `about`. A link takes the stricter tier of its two ends, so the household sees the task and its steps, and not the link to the note.

**A routine** is a habit, for a small thing that repeats: "Feed the cat", "Pack the school bag". It has days of the week (`days`, none for every day), a `for` link to a child, and a check-in for the day. There is no streak and no score. Adults use tasks, not routines. Built on 24/11/2026:

- The owner makes a routine in Projects > Family, for a person at Household. The routine is at Household. A person above Household would hide the routine from the child, because a link takes the stricter tier of its two ends.
- A child sees today's routines first on Home, and ticks them. A second tap takes back a tick by mistake. A child ticks only the child's own routines. A partner sees every child's routines, with the names, and can tick for a child.
- The server writes who ticked and when. A tick is applied at once, also from a member key, and the take-back is its undo.
- The morning and evening fridge screens show one row for each child: what is left today, or "all done".
- The owner's Today shows the owner's own habits, and no routine of a child.

### 2.6 Time

Time is three things in HMN, and a screen keeps them apart.

| Kind of time | Type | Example | Moves? |
| --- | --- | --- | --- |
| A fixed moment | event | The concert at 16:30. | No. The calendar owns it. |
| A deadline | task with `due_at` | Send the notes by 17:00. | Yes. The owner can move it. |
| A rhythm | habit with `cadence` | Bins every Tuesday. | It repeats. |

A recurring task (rent, a car service each year) is a habit with a long cadence and a link to the asset, or a task that a worker proposes again. HMN does not add a repeat rule to the task type.

## 3. Who may see it: tiers and audiences

### 3.1 The gap

The four tiers are Public, Personal, Private, and Sealed. Public means "fine on a shared display". The first design had one shared display and no other people. A family fridge shows the gap:

- The school pickup, dinner, and the grocery list are for the household. They are not for a guest agent, a lock screen in a café, or a friend's assistant. Today they must be Public to reach the fridge, and then a guest key can read them too.
- The same items are not Private, because the family must see them.

### 3.2 The proposal: a Household tier

Add one tier between Public and Personal.

| Tier | Who sees it | Surfaces |
| --- | --- | --- |
| Public | Anyone | A guest agent, a Public display. |
| **Household** | The people who live in the home | The fridge, the phones of household members, the owner's lock and StandBy widgets, the owner's home widget and phone. |
| Personal | The owner | The owner's phone and home-screen widget, the owner's agents. |
| Private | The owner, phone unlocked | The unlocked phone. An agent only with a grant that ends. |
| Sealed | The owner, vault open | The vault. No agent. |

What changes:

- The order becomes Public < Household < Personal < Private < Sealed. Every rule that compares tiers already uses the order, so the policy layer needs one new value and its place.
- A new area default: a **Home** area (or a household area) whose items are Household. The Family area stays Private for the sensitive family things: a school report, a child's health, a hard conversation. The logistics of family life (pickup, dinner, a match) move to Household.
- A guest key stays at Public. A household member reads Household. The fridge reads Household. The owner's lock and StandBy widgets read Household, so household fixtures can show there; they never read Personal, Private, or Sealed.
- Hide on a phone still drops it to Public.

The cost is real: a migration of the tier value, the order in each comparison, the tests, the app's tier chips and the Privacy screen. It is one release of work. The alternative, a "shared" flag beside the tier, gives two answers to "who may see it", and the rules then need both. One ordered tier is simpler to reason about.

## 4. What a person does

Nine verbs cover what a person does with the record. Each surface supports some of them.

| Verb | What it means | Result |
| --- | --- | --- |
| Glance | See what matters now, with no tap. | Nothing changes. |
| Capture | Put something in, with no form. | An inbox item. |
| File | Turn an inbox item into a typed object. | A task, a note, an event, an item. An agent can propose the filing. |
| Decide | Approve, decline, or edit a proposal. | The graph changes, with an undo. |
| Do | Tick a task, an item, or a routine. | Done, with a time and a name. |
| Plan | Give a date, a person, a project, a list. | The object moves on the map. |
| Look up | Find a person, a place, a thing, a fact. | Nothing changes. A read log row for an agent. |
| Tend | Prune what is quiet, close what is done, once a week. | Fewer loose ends. |
| Guard | Hide a device, revoke a key, give or end a grant. | The boundary changes. |

The principle: **capture and glance are everywhere, decide and guard are only on the owner's phone and the mini.** Do and plan are where the person is when the moment comes.

## 5. The surfaces

### 5.1 Who sees which surface

| Surface | Person | Ceiling | Verbs |
| --- | --- | --- | --- |
| iPhone app, owner | The owner | Private, Sealed with the vault | All nine |
| Home-screen widget | The owner | Personal | Glance |
| Lock screen and StandBy | The owner | Household | Glance |
| Share sheet, Siri, Shortcuts | The owner | (writes only) | Capture |
| **Fridge display** | The household and visitors | **Household** | Glance |
| **Household app** | Each household member | **Household** | Glance, capture, do, plan (lists, family tasks, household dates) |
| Mac menu bar | The owner at the mini | Admin | Guard |
| Agents (MCP) | The owner's agents | Personal, Private with a grant | Look up, propose |
| Guest agent | Another person's agent | Public | Free and busy times, propose an event |

### 5.2 The iPhone app: the integrator

The phone is where a life enters HMN and where the owner decides. It is not a dashboard of everything.

- **Today** answers "what needs me now": due tasks, the next family date, today's events, the next fixture, what is quiet. At most three items in a section, then a count.
- **Capture** is one field and the share sheet. It never asks for a type first.
- **Review** is the one place for decisions: proposals, then the inbox to file.
- **Browse** is the map: areas, people, places, assets, goals, lists. A person page is the hub of a relationship: the next dates, the open tasks for them, their routines, the notes about them, and the things and people linked to them (built on 24/11/2026).
- **Settings** holds the boundaries: keys, grants, calendars, areas and kinds, privacy, the audit log, and the household.

The tabs follow the verbs: Today (glance, do), People (look up), plus (capture), Projects (plan), Review (decide). Lists belong next to Projects, as a filter, not as a sixth tab.

### 5.3 The fridge display

The fridge is a **TRMNL BWRY**: the OG hardware with a four-colour panel. Facts from TRMNL, read on 23/11/2026:

| Fact | Value | Source |
| --- | --- | --- |
| Resolution | 800 × 480 | The TRMNL models API, model `og_bwry` |
| Inks | Black, white, red (#FF0000), yellow (#FFFF00). The panel shows them darker and flatter than a screen. | The palettes API, `color-4bwry` |
| Image | PNG, at most 90,000 bytes | The models API |
| One refresh | About 13 seconds, with several flashes for each colour | The TRMNL help article on BWRY |
| Not documented | How a server encodes red and yellow in the PNG. The `Model` value that the device sends. | To test on the device |

What this means for the design:

- **Few refreshes.** A colour refresh is slow and it flashes. The fridge changes at the start of each time window, and when the content of the current screen changes. It does not rotate every few minutes.
- **Colour with a meaning.** Black or white for text, never red or yellow words. Red is a mark for now and today: the next start, a task due today, a leftover routine. Yellow is one highlight: the Garden band under the title, and a rail on the grocery list. A screen uses red and yellow sparingly, as the Garden accents are on the phone, and colour is never the only signal.
- **Large type, in segments.** 800 × 480 is a large kitchen panel, but it is read from a few metres. The screen is four cards, like the iOS widget, with the official mark in the header and one dark focus pane (white on black) for this moment. Type stays large enough to read across the room; a pane that cannot show every row ends with "+N more".
- **A test first.** HMN draws 1-bit BMP and grey PNG now. Red and yellow need a palette PNG. The first job when the device arrives is to read its setup call and to draw one test image with the four inks.

The fridge shows the Household tier only, and it changes by the time of day. The owner said on 23/11/2026: try it, there is a lot to show. These are the first screens. Each one is a test, and the household's use decides what stays.

| Time | Screen | Content |
| --- | --- | --- |
| 06:00 to 09:00 | This morning | The first part of the day: the next or current start in the focus pane, who they are with, family tasks due today, and the children's routines. Timed events from 16:00 wait for This evening. |
| 09:00 to 16:00 | This week | The household calendar for seven days. Family tasks with a date this week. |
| 16:00 to 21:00 | This evening | Dinner in the focus pane, tomorrow's early start, the children's routines, and the grocery list on a yellow rail. Tomorrow's first start keeps a row when the panel is full. |
| 21:00 to 06:00 | Quiet | The date and tomorrow's first event. |

Other blocks to try in these screens: the next birthday in the family, school term dates, the next fixture of a team you follow, a short note that a member leaves on the fridge, the bin day, and the weather. Weather and the bin day are world data that sit beside an HMN screen. They are not part of the record (STRATEGY.md, the read contract).

Rules for the fridge:

- Names of household members are allowed. A guest's name or a Private title is never there, because the tier stops it.
- No count of hidden things, no "sealed" line, no proposals.
- The fridge has its own device key at Household. It is not the owner key.

### 5.4 The household app

A display cannot take input well. The household acts on its phones.

**The same server.** The household uses your HMN on the mini. It is not a second server and not a second graph. A household member is close to an agent in the machinery: a key with a ceiling, limits by area, and rules for its writes. The difference is that a person uses it through the app, and the key is linked to the person record of that member.

**Two roles.** A household has adults and children, and they need different reach.

| Role | Reads | Writes with no review | Writes that wait for you |
| --- | --- | --- | --- |
| Partner | Household everywhere, and the Family area at Private: the children's records, school, the family's dates | Add and tick list items. Complete and add family tasks. Change the children's records: school, sizes, doctor, contacts. Each with an undo. | A removal. A change of tier or area. |
| Child | Household only | Add and tick list items. Tick a task or a routine that is `for` them. | A new household date. Anything else. |

- A partner does not read your Personal or Private rows outside the Family area: work, your notes, money. Sealed stays in your vault, also for a partner.
- A child does not read another child's Private record, or a parent's.
- The Private reach of a partner needs one new part in the policy layer: **a ceiling for named areas**. Today a key has one ceiling, with limits by area. A partner key has Household as its ceiling, and Private in the Family area.

**Approval.** Your answer on 23/11/2026: members add and tick with no review, and each change has an undo. A new household date from a child waits for you. A removal always waits.

**Pairing.** You make a member pairing code on your phone, for a person and a role. Show on the fridge puts the code on the fridge as a QR code for twenty minutes, so a child pairs at the fridge with the phone camera. The code leaves the fridge when it is used, when you take it off, or when it is old. The fridge shows the person's name only if the person is at Household or below.

**The app.** The same iPhone app, in a member mode that the member key sets. It shows Home (the household Today), Lists, and Family tasks, and none of your tabs. Each member of the household has an iPhone (your answer on 23/11/2026), so no web app is needed now.

## 6. How it comes together: one day

The names are the people of the demonstration data.

- 07:10. The fridge shows "This morning": Yves has school at 08:00 and football at 16:00, Luca has the dentist at 15:30 with Sam, and the form for Yves's passport is due today, in red. Nobody opened an app.
- 07:20. Sam completes the form step of the passport task in the household app. The fridge shows it at the next refresh. The record keeps Sam's name on the step.
- 12:40. The owner shares a school email to HMN. It is an inbox item. An agent proposes an event "Sports day, Fri 4 Dec" for Yves at Household. The owner approves it on Review in one tap.
- 17:30. Sam adds "milk" to the grocery list. A rule accepts it.
- 18:00. The fridge shows "This evening": dinner, leftover tasks, the 07:30 start tomorrow, and the grocery list with milk.
- 21:00. The owner's Today shows the work task that is due, and nothing of the household logistics that the fridge already said.

## 7. What changes in the code

The order, from the owner's answers on 23/11/2026. The fridge comes first, because the device is on its way and it only reads. The member app comes after the shapes that members write to.

| # | Work | Size |
| --- | --- | --- |
| 1 | Done on 23/11/2026. The Household tier. | Large |
| 2 | Done on 23/11/2026, not yet tested on the device. The fridge, first version: a Household device key, the BWRY palette PNG (`Model: og_4clr`), the four screens in four inks, a schedule by time of day, refresh on change. It shows the household calendar, family tasks, and the next fixture. See [TRMNL.md](TRMNL.md). | Medium |
| 3 | Done on 23/11/2026. Lists and shared family tasks in your app: the kinds `list` and `item`, tasks `for` several people, steps, who completed it. The evening fridge screen shows the newest list. Who completed it reads "you" until member keys exist (step 4). | Medium |
| 4 | Done on 23/11/2026, and the QR code on the fridge on 24/11/2026. Member keys linked to a person, with the roles Partner and Child, a ceiling for named areas, member pairing in Settings > Household, pairing by QR on the fridge, and the approval rules for members. | Large |
| 5 | Done on 23/11/2026. Member mode in the iPhone app: Home, Lists, Family tasks. The member key sets the mode. Home greets the member and shows what is for them first. Your app has a Family filter in Projects. | Medium |
| 6 | Done on 24/11/2026. Routines for the children: days of the week, a tick for today with a take-back, on Home, in Family, and on the fridge. See 2.5. | Small |
| 7 | Done on 24/11/2026. A person page as the hub of a relationship, and `organisation` as a person kind. People gives each person one line, the kind and the next date, and lists organisations after the people. | Small |

## 8. Decisions

The owner's answers on 23/11/2026.

1. **The Household tier.** Accepted and built.
2. **What moves to Household.** School dates, pickups, the children's sport sessions and matches, and dinner move to Household. Health, school reports, and hard topics stay Private. The fixtures of the teams that you follow as a fan are already Public, so the fridge can show them with no change.
3. **The fridge device.** A TRMNL BWRY. See 5.3.
4. **Family phones.** Each member has an iPhone. The members use the same server, with member keys and the roles Partner and Child. See 5.4.
5. **Writes with no review.** Yes: members add and tick, with an undo. A new household date from a child waits for you.
6. **Lists and family tasks.** Lists and steps are kinds, with no new types. A family task is a task `for` several people. Routines are only for the children, and they come last (built on 24/11/2026).
7. **The fridge screens.** Try the four time windows, and add blocks from real use.
8. **The order of work.** The fridge first, then lists and family tasks, then the member keys and the member app. See section 7.

Answered later on 23/11/2026:

9. **A partner reads the Family area at Private.** Yes.
10. **Sealed for a partner.** Yes, through a Private summary that you approve: a child's allergy or medication, as a row in the Family area. The Sealed source stays in your vault.

## 9. The target, not built: a vault for each adult

The owner asked on 23/11/2026 whether a partner should have their own vault. This is the direction, for later.

- **Each adult owns a record.** The household is a shared space (Household, and the Family area), and each adult has their own Personal, Private, and Sealed rows. The mini is the shared infrastructure of the home, not the archive of one person that others are allowed into.
- **A real vault is a key that the server does not hold.** Today a Sealed row is encrypted with one sealed key, which the server unwraps with its KEK. So whoever runs the mini can in principle read every vault on it. A partner's vault is private from the owner only if the partner's Sealed rows are encrypted with a key that exists only on the partner's phone (in the Secure Enclave), and the server stores only the ciphertext.
- **What that costs.** No agent and no worker can ever read those rows, also not a summary, unless the partner's phone makes it. A lost phone with no backup of that key loses those rows. Search on the server cannot see them. The same design could later move your own vault to your phone.
- **When.** After the member keys and the member app are in use. It is not in section 7.
