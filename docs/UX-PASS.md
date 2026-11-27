# UX and knowledge pass, November 2026

The owner asked on 2026-11-27 for a full pass on the app: buttons, status, data types, friction in flows, display problems and errors, and the way knowledge is kept, edited, and shown. Five audits read the code and ran fictional test servers and simulators, one lane each: item types and editing, priority and staleness, flows and errors, the visual UI, and a critical review of the knowledge model. This file is the plan made from them, in the order of work. Each item has its status.

## The verdict

- **The rules are right and the screens lied in places.** Tiers, provenance, and "the owner decides" hold. But each screen compared the day and not the time, so a game that started this afternoon stayed on Today, Upcoming, Week, the lock screen, and the widget until midnight. Overdue tasks were on no screen. One unreadable date stopped Today and Week, and the phone then said "Your HMN is sleeping".
- **Knowledge has no shape of its own.** A fact ("Luca is allergic to penicillin", "the passport expires 02/2027") can live only in a note body or in properties that the phone cannot see. Filing a capture to a record did not keep the text. A note could not be made on the phone.
- **The type system exists on the server and in the docs, but a person never meets it.** One generic editor serves eleven types: title, notes, date, status, tier. The phone cannot create a project, person, place, asset, goal, event, or note, and cannot set a kind, an area, or a link other than "for".
- **The look is close, and inconsistent in small ways that add up.** Two screen insets, six date formats, three title styles, raw values ("personal", "side_project", ISO times), a tab bar that breaks at large text.

## Batch 1: the record tells the truth (server). Done on 2026-11-27.

- An event leaves every screen when it is over: an all-day event at the end of its last day, a timed event at its end, or one hour after its start (two for a fixture). A cancelled event never shows. This covers Today, Upcoming, Week, Home, the fridge, the person page, the lock screen, and the widget's next event. `eventOver` in `server/src/time.ts`.
- Today has an **Overdue** section first, with "3 days late". It is counted in the summary and the badge.
- Family dates on Today cover the next seven days, at most four. Upcoming covers two weeks, at most eight in a section, with "8 of 12".
- Week puts **Slipped** first, then **Next 7 days** as one list in time order that includes today, then the calendar, then **Done** by the time it was done, then goals.
- A task line names its day or how late it is, so "by 17:00" never hides the date.
- Today's routines follow their days. Home is in time order and counts what it shows.
- The fridge: no event that is over, no inbox task, the screen after midnight shows the coming day, the routines cannot push today's tasks off the panel, and a cut section says "+2 more". In the evening, a task still due today is red.
- A date that HMN cannot read is refused on every write ("Use a date like 2026-12-01"), and an old one is no date on a screen. An empty string is no value.
- "Edit first" on a proposed change edits the change, not a stray copy.
- An area with items cannot be removed. Its removal made a Sealed health note Personal and readable by an agent.
- Filing a capture to a record makes a note about that record with the text. A capture can become a task, a note, or a person in one step, with no tag (`accept` with `route`).
- The stored zone label of a fixture ("AWST") is gone. The time is in the owner's zone.

## Batch 2: knowledge and editing

The server half is done on 2026-11-27: items 1, 2, 3, 7 (the single route was there), and 9, with typed fields for people, places, assets, goals, notes, and projects in the schema route. The rules are in [SCHEMA.md](SCHEMA.md), "Archive, note kinds, fields, and links". The app half is done on 2026-11-27: one record editor for every type (`ios/HMN/Views/RecordView.swift`) with kind, status, date, typed fields, area, links in words with Add a link, who sees it with a question before a move toward Public, Archive, and a read-only view of a mirrored event and a source. New on People, Projects, and the record lists. A capture becomes a task, a note, or a person in one tap, and File to keeps the text. Lists can be edited, and their items renamed and deleted. A routine opens an editor for its name, person, days, and pause. A task made on a person or project page takes that page's area and tier. Lists show Show archived.

1. **Archive.** One archived state for notes, goals, projects, people, places, assets, areas, and events. Archived rows leave lists, search, and screens, and stay readable with "Show archived". Archive is the first choice in each editor; Delete is behind it.
2. **Note kinds.** Notes get kinds: note, reference, decision, fact, reading, review, and capture. `properties.reading` and `properties.year_review` move to kinds once, at the next start.
3. **One schema route.** `GET /api/v1/schema` returns the statuses, the kinds with their titles, and the relations, so the app stops copying them. This fixes the event status that the server refused ("Done" for an event).
4. **An editor for each type.** The shared parts: name, about text, kind chips, area chips, linked rows that say the relation ("For Sam", "At School", "Part of Lisbon trip") with Add a link, who sees it, and Archive. Then the type's own card: a person's nickname and birthday, an asset's model and year, a goal's horizon, an event's end, place, and people, an area's tier for its items. No date toggle where a date means nothing. A source is read-only.
5. **Create from the phone.** A New button on People, Projects, and each list in Settings, and a "New" choice in Capture: task, note, project, person, place, thing, goal, event.
6. **Lists and routines can be managed.** Rename, re-tier, complete, and delete a list; rename and delete an item; edit a routine's name, person, and days.
7. **Open one record by its id**, not by reading the whole list (a list stops at 200).
8. **A task made on a person or project page takes the area and tier of that page.**
9. **Links are checked.** A relation must be one HMN knows, between types that fit; a duplicate or a self link is refused.

## Batch 3: flows and errors. Done on 2026-11-27.

All nine items are in the app. The client keeps one connection with an 8 second timeout, and each failure has its own state (`HMNError` and `Session.reach`). Today has a card for each state and a search button. A tick is optimistic. Review has a count on its tab, Undo all after a list, and no unread decline. Privacy opens the vault. The record editor guards unsaved edits.

1. **Search** from Today and from the inbox's File to, with the type of each result.
2. **Honest states.** "Not paired any more", "Hidden", "Your HMN had a fault", and "Your HMN is sleeping" are different cards. Requests time out after 8 seconds. Each server answer has a plain message.
3. **Refresh.** Today reads again when the app comes back to the front and when the day changes. A page change clears the old page.
4. **Quick ticks.** A tick changes at once and rolls back on an error. One client is kept, so the connection stays warm, and the widget and audit work runs at most once a minute.
5. **Review.** A mark on the Review tab when something waits. Review all comes back with "4 approved. Undo all." The Sealed card offers the vault, and no unread decline.
6. **Inbox.** Each capture shows Task, Note, Person, and File to. Save cannot be tapped twice. A failed save goes to the offline queue.
7. **Safe edits.** A move toward Public asks first. Leaving an edited record asks to save. Edit first uses a date picker.
8. **The vault** can be opened from Privacy, and the phone knows when it closes.
9. **Messages next to their control**, or a short toast, never at the foot of a long page.

## Batch 4: look and feel. Done on 2026-11-27.

All ten items are in the app. The rules are in [UX.md](UX.md), "One grammar for the app". Left: the member tab bar (Home, Lists, Family) has words only, and a link in a proposal with no name shows its id.

1. One screen inset (16 points) on every screen.
2. One date formatter: "Today", "Tomorrow", "Fri 13 Nov", "13 Nov 2027", and the phone's own clock.
3. A tab bar with icons that holds at large text.
4. One helper that turns stored ids into words: no "personal", "active", "side_project", "Version", or ISO time on a screen.
5. One title style for tab roots, inline titles for pushed screens.
6. A quiet selected style for small toggles, so ink is only for the main action.
7. One row grammar: two heights, two divider insets, a chevron on each row that opens, one done mark.
8. The tick names its task for VoiceOver. The Review label column does not split at large text.
9. Dark cards lift from the ground, and placeholders and disabled labels are readable.
10. The Journal screen in Garden. The widget's font names fixed.

## Later, and decisions for the owner

1. **Typed fields for each kind. Done on 2026-11-27.** See [SCHEMA.md](SCHEMA.md), "Typed fields". A small set of field types (text, long text, date, expiry, link, choice, number, person, thing) that a kind adds, kept in properties, shown as a form, and validated on the server. The first version would cover people, assets, and notes.
2. **Expiry as a fact. Done on 2026-11-27:** "Expiring soon" on Today, Upcoming, and the weekly review. An expiry field feeds a Renewals worker and an "Expiring soon" section.
3. **Hub pages** for things, places, and areas, like the person page.
4. **Merge and retype**, as proposals with undo.
5. **Approval by kind of fact**, after real use shows what agents propose most.
6. **Fewer type words in the app**: Task, Note, Person or place or thing, Date, List.
7. **A widget that reads its own data**, with a key in a shared Keychain group, so it is current without the app.
