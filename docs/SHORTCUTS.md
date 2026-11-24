# Shortcuts

HMN adds two actions to Shortcuts. Both write to the inbox or read the personal snapshot already on the phone. Neither one writes the graph by itself.

**Add to HMN** takes text and a Private switch. It is the phrase "Add to HMN".

**Send to HMN** is the generic intake. An automation can pass text, a URL, JSON, an optional tag, and a tier hint. The capture is an inbox item with source `shortcut`. The tier starts at Personal. Private and Sealed are accepted. Public is ignored and stored as Personal. A `#private` or `#sealed` tag still raises the tier. The words are data. JSON is stored as text and is not executed.

The phone queues the capture and sends it the next time the app is open. Processing it is the same swipe as any other inbox row.

Voice capture is not in this build.

## Reminders

A personal automation, when a reminder is completed:

1. Get the reminder's title.
2. Send to HMN. Text is the title. Tag is `todo`. Tier is Personal.
3. Leave the URL and JSON empty.

The inbox row suggests a task. Nothing is added to the graph until the swipe.

## Home

A personal automation, when a scene runs:

1. Send to HMN. Text is the scene name, for example "Good night". Tag is `home`. Tier is Personal.

`home` matches the Home area when that area exists, and the row is filed there only after an accept.

## Another app

A share-sheet or automation that has a link and a note:

1. Send to HMN. Text is the note. URL is the link. JSON may be the other app's dictionary, pasted or passed as text. Tag is optional. Tier is Personal unless the note is family, in which case the hint is Private.

A Private hint is hidden from the widget and from an agent. A Sealed hint is hidden from the phone until the vault is open. The shortcut cannot use the hint to make a family note Public.
