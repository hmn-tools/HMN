import SwiftUI

struct TodayView: View {
    @EnvironmentObject private var session: Session
    @State private var screenId = "today"
    @State private var screen: TodayScreen?
    /// A tick shows at once. The server's answer replaces it, or an error takes it back.
    @State private var optimistic: [String: Bool] = [:]
    /// A short line next to the tick that failed. It goes after a few seconds.
    @State private var toast: String?
    @State private var showSearch = false
    /// True while a knock waits for an answer. The time of the last knock that got none.
    @State private var knocking = false
    @State private var lastKnock: Date?
    @State private var loaded = false
    @State private var note: String?
    /// The task that the owner completed last, so that one tap takes it back.
    @State private var completed: ScreenItem?
    /// The yearly review opens from the week page.
    @State private var showYear = false
    /// The row that the owner opened.
    @State private var opened: ScreenItem?
    private let deck = ["today", "upcoming", "commitments", "quiet", "week"]
    /// The sections whose rows are tasks. A row there has a circle that completes it.
    private let taskSections: Set<String> = ["overdue", "due", "commitments", "slipped", "mine", "today", "next"]

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    header
                    if !session.isPaired {
                        firstRun
                    } else {
                        stateCard
                        if session.hidden { hiddenCard }
                        if let screen {
                            content(screen)
                        } else if !offline && !loaded {
                            ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                        }
                    }
                    if session.auditAlarm { auditAlarmCard }
                    if let note { MessageLine(text: note) }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 16)
            }
            .refreshable { await load() }
            // A swipe to the side moves through the pages, as the dots do. A vertical drag still scrolls.
            .simultaneousGesture(
                DragGesture(minimumDistance: 24)
                    .onEnded { drag in
                        guard session.isPaired, !session.isMember, screen != nil else { return }
                        let dx = drag.translation.width
                        let dy = drag.translation.height
                        guard abs(dx) > 70, abs(dx) > abs(dy) * 2 else { return }
                        turn(dx < 0 ? 1 : -1)
                    }
            )
            // The line stays above the pager, so that the owner sees it on a long day.
            if let toast {
                MessageLine(text: toast, isError: true)
                    .padding(.horizontal, 16).padding(.top, 6)
                    .transition(.opacity)
                    .task(id: toast) {
                        try? await Task.sleep(nanoseconds: 4_000_000_000)
                        withAnimation { self.toast = nil }
                    }
            }
            if let completed { undoLine(completed).padding(.horizontal, 16).padding(.top, 6) }
            if session.isPaired && screen != nil && !session.isMember { pager }
        }
        .task {
            // A member's phone has one screen: Home.
            if session.isMember { screenId = "home" }
            await load()
        }
        .sheet(isPresented: $showYear) { YearReviewView().themed() }
        .sheet(isPresented: $showSearch, onDismiss: { Task { await load() } }) { SearchView().themed() }
        // Back at the front, or a new day: read the page again.
        .onChange(of: session.refreshTick) { _, _ in Task { await load() } }
        .sheet(item: $opened, onDismiss: { Task { await load() } }) { item in OpenedItem(item: item).themed() }
        // The owner pairs the phone in Settings. Today reads again when that sheet closes.
        .onChange(of: session.showSettings) { _, open in
            if !open { Task { await load() } }
        }
        // A pairing link from the camera gives a new key without Settings. Read again then too.
        .onChange(of: session.token) { _, _ in
            if session.isMember { screenId = "home" }
            Task { await load() }
        }
    }

    private var auditAlarmCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("The audit log on your HMN does not match this phone.")
                .font(Theme.text)
                .foregroundStyle(Theme.danger)
            Text("It may have been changed.")
                .font(Theme.font(12)).foregroundStyle(Theme.graphite)
            Button("I have seen this") { Task { await session.acknowledgeAuditAlarm() } }
                .buttonStyle(PillButtonStyle(kind: .secondary))
        }
        .card()
    }

    private var header: some View {
        HStack(spacing: 8) {
            Mark()
            SmallLabel(text: screen?.dateLabel ?? "HMN")
            Spacer()
            if session.isPaired && !session.isMember {
                Button { showSearch = true } label: {
                    Image(systemName: "magnifyingglass")
                        .font(.body.weight(.medium))
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.ink)
                .accessibilityLabel("Search")
            }
            Button { session.showSettings = true } label: {
                Image(systemName: "slider.horizontal.3")
                    .font(.body.weight(.medium))
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(Theme.ink)
            .accessibilityLabel("Settings")
        }
        .padding(.horizontal, 4)
    }

    @ViewBuilder private func content(_ today: TodayScreen) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(today.greeting).font(Theme.title).tracking(-0.6)
            if screenId == "today" || screenId == "home" { Stripe() }
        }
        .padding(.horizontal, 4)
        .padding(.bottom, 2)
        if today.sections.isEmpty {
            EmptyState(title: today.summary, text: today.closing)
        }
        ForEach(today.sections) { section in
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    SmallLabel(text: section.label, color: section.accent == "teal" ? Theme.tealDark : Theme.stone)
                    Spacer()
                    if let trailing = section.trailing { SmallLabel(text: trailing) }
                }
                .padding(.top, 10)
                .padding(.bottom, 4)
                ForEach(Array(section.items.enumerated()), id: \.element.id) { index, item in
                    row(item, in: section)
                        .overlay(alignment: .top) { if index > 0 { Theme.hair.frame(height: 1) } }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
            .card(padding: 0)
            .opacity(offline ? 0.6 : 1)
        }
        // The week page ends with the way to the year.
        if screenId == "week" && !session.isMember {
            Button { showYear = true } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("The year").font(Theme.row).foregroundStyle(Theme.ink)
                        Text("What it held, and your note.").font(Theme.small).foregroundStyle(Theme.stone)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.stone)
                }
                .padding(.horizontal, 16)
                .frame(minHeight: 60)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .card(padding: 0)
        }
    }

    private func rowText(_ item: ScreenItem) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(item.title).font(Theme.row)
            if !item.subtitle.isEmpty {
                Text(item.subtitle).font(Theme.small).foregroundStyle(Theme.stone)
            }
        }
    }

    /// The owner opens a row that is an entity. A member's Home stays a glance.
    /// True when the last request did not reach your HMN, or it refused this phone.
    private var offline: Bool { session.reach != .ok }

    private func opens(_ item: ScreenItem) -> Bool {
        item.type != nil && !session.isMember && !offline
    }

    /// The row as the owner sees it now: a tick that waits for the server shows at once.
    private func shown(_ item: ScreenItem) -> ScreenItem {
        var copy = item
        if let done = optimistic[item.id] { copy.done = done }
        return copy
    }

    private func row(_ raw: ScreenItem, in section: ScreenSection) -> some View {
        let item = shown(raw)
        return HStack(alignment: .center, spacing: 12) {
            if section.id == "routines" {
                Button { Task { await checkIn(item) } } label: { glyph(item) }
                    .buttonStyle(.plain)
                    .frame(minWidth: 32, minHeight: 44)
                    .accessibilityLabel(item.done ? "Done: \(item.title). Tap to take it back." : "Check in: \(item.title)")
            } else if item.glyph == "checkbox" && !item.done && taskSections.contains(section.id) && !offline {
                Button { Task { await complete(item) } } label: { glyph(item) }
                    .buttonStyle(.plain)
                    .frame(minWidth: 32, minHeight: 44)
                    .accessibilityLabel("Mark as done: \(item.title)")
            } else {
                glyph(item).frame(minWidth: 32)
            }
            if opens(item) {
                Button { opened = item } label: {
                    HStack(spacing: 0) {
                        rowText(item)
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens it")
            } else {
                rowText(item)
                Spacer(minLength: 0)
            }
            if let badge = item.badge {
                Text(badge)
                    .font(Theme.mono(10, weight: .medium))
                    .tracking(0.8)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .overlay(Capsule().stroke(Theme.ink, lineWidth: 1))
            }
        }
        .frame(minHeight: 52)
    }

    /// The owner sees this before the phone is paired.
    private var firstRun: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Hello.").font(Theme.title).tracking(-0.6)
            Text("Pair this phone with your HMN to begin.").font(Theme.body).foregroundStyle(Theme.graphite)
            Button("Pair this phone") { session.showSettings = true }
                .buttonStyle(PillButtonStyle())
        }
        .card(padding: 20)
    }

    /// One card for each state of the connection. The last day that the phone saw stays below each one.
    @ViewBuilder private var stateCard: some View {
        switch session.reach {
        case .ok: EmptyView()
        case .asleep: sleeping
        case .fault:
            stateNote(
                title: "Your HMN had a fault.",
                text: screen == nil
                    ? "It is awake, but it could not make this page."
                    : "It is awake, but it could not make this page. This is your day as this phone saw it at \(screen?.updatedLabel ?? "").",
                action: knocking ? "Trying" : "Try again"
            ) { Task { await knock() } }
        case .unpaired:
            stateNote(
                title: "This phone is not paired any more.",
                text: "Your HMN does not know this phone's key. The key was removed, or your HMN was set up again.",
                action: "Pair again"
            ) { session.showSettings = true }
        case .pin:
            stateNote(
                title: "Your HMN has a new certificate.",
                text: "This phone trusts only the certificate that it paired with. Pair again to trust the new one.",
                action: "Pair again"
            ) { session.showSettings = true }
        }
    }

    private func stateNote(title: String, text: String, action: String, perform: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(Theme.heading)
            Text(text).font(Theme.text).foregroundStyle(Theme.graphite)
                .fixedSize(horizontal: false, vertical: true)
            Button(action, action: perform).buttonStyle(PillButtonStyle())
        }
        .card(padding: 20)
    }

    /// The phone is hidden: it reads Public only. The owner ends Hide on the server.
    private var hiddenCard: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "eye.slash").foregroundStyle(Theme.tealDark)
            Text("This phone is hidden. It shows Public only. Hide ends on your HMN, from its menu bar.")
                .font(Theme.text).foregroundStyle(Theme.graphite)
                .fixedSize(horizontal: false, vertical: true)
        }
        .card()
    }

    /// The phone is paired, and your HMN does not answer. The last day that the phone saw stays below, in grey.
    private var sleeping: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .bottom, spacing: 5) {
                Mark(size: 54).rotationEffect(.degrees(90))
                Text("z").font(Theme.sans(13, weight: .semibold)).padding(.bottom, 16)
                Text("z").font(Theme.sans(17, weight: .semibold)).padding(.bottom, 24)
                Text("z").font(Theme.sans(22, weight: .semibold)).padding(.bottom, 32)
                Spacer()
            }
            .foregroundStyle(Theme.tealDark)
            .padding(.horizontal, 12)
            .padding(.top, 10)
            .frame(maxWidth: .infinity)
            .background(Theme.tealTint)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.field, style: .continuous))
            .accessibilityHidden(true)
            Text("Your HMN is sleeping.").font(Theme.heading)
            Text(screen == nil
                ? "This phone cannot reach it now."
                : "This is your day as this phone saw it at \(screen?.updatedLabel ?? "").")
                .font(Theme.text).foregroundStyle(Theme.graphite)
            if let lastKnock, !knocking {
                // The knock got no answer. Say so, with the time, so the person knows the tap did something.
                Text("No answer at \(When.timeWithSeconds(lastKnock)). Still asleep.")
                    .font(Theme.small).foregroundStyle(Theme.stone)
                    .transition(.opacity)
            }
            Button {
                Task { await knock() }
            } label: {
                HStack(spacing: 8) {
                    if knocking { ProgressView().tint(Theme.paper) }
                    Text(knocking ? "Knocking" : "Knock again")
                }
            }
            // Not disabled: a disabled pill turns grey, and the knock should stay visible. A second tap does nothing.
            .buttonStyle(PillButtonStyle())
        }
        .card(padding: 20)
        .animation(.easeOut(duration: 0.2), value: knocking)
    }

    /// One knock: a visible wait of at least a moment, then the answer, or a line that says there was none.
    private func knock() async {
        guard !knocking else { return }
        knocking = true
        let started = Date()
        await load()
        let waited = Date().timeIntervalSince(started)
        if waited < 0.8 { try? await Task.sleep(nanoseconds: UInt64((0.8 - waited) * 1_000_000_000)) }
        if offline {
            lastKnock = Date()
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
        } else {
            lastKnock = nil
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        }
        knocking = false
    }

    private func undoLine(_ item: ScreenItem) -> some View {
        HStack(spacing: 12) {
            Text("Done: \(item.title)").font(Theme.text).lineLimit(1)
            Spacer(minLength: 0)
            Button("Undo") { Task { await reopen(item) } }
                .font(Theme.sans(13, weight: .semibold))
                .foregroundStyle(Theme.tealDark)
                .padding(.horizontal, 14)
                .frame(minHeight: 44)
                .background(Theme.card)
                .clipShape(Capsule())
        }
        .padding(.leading, 18)
        .padding(.trailing, 4)
        .frame(minHeight: 52)
        .background(Theme.tealTint)
        .clipShape(Capsule())
    }

    /// Go one page forward (1) or back (-1). The first and the last page stop there.
    private func turn(_ step: Int) {
        guard let index = deck.firstIndex(of: screenId) else { return }
        let next = index + step
        guard deck.indices.contains(next) else { return }
        show(deck[next])
    }

    private func show(_ id: String) {
        guard id != screenId else { return }
        withAnimation(.easeOut(duration: 0.2)) { screenId = id }
        completed = nil
        // The old page goes at once, so its rows never show under the new page's dot.
        screen = nil
        loaded = false
        Task { await load() }
    }

    /// The pages of Today. The row stays above the tab bar, so that it does not move with the content.
    private var pager: some View {
        HStack(spacing: 0) {
            ForEach(deck, id: \.self) { id in
                Button { show(id) } label: {
                    Capsule()
                        .fill(screenId == id ? Theme.ink : Theme.hair)
                        .frame(width: screenId == id ? 18 : 6, height: 6)
                        .frame(width: 30, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(id.capitalized)
                .accessibilityAddTraits(screenId == id ? [.isSelected] : [])
            }
        }
        .frame(maxWidth: .infinity)
    }

    /// A tick on a routine, or a tick taken back when it was by mistake.
    private func checkIn(_ raw: ScreenItem) async {
        let item = shown(raw)
        guard optimistic[item.id] == nil else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        optimistic[item.id] = !item.done
        do {
            if item.done { _ = try await session.client().uncheck(item.id) } else { _ = try await session.client().checkIn(item.id) }
            await load()
        } catch {
            withAnimation { toast = "\(item.title) did not change. \(error.localizedDescription)" }
            session.noteReach(error)
        }
        optimistic[item.id] = nil
    }

    private func complete(_ item: ScreenItem) async {
        guard optimistic[item.id] == nil else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        optimistic[item.id] = true
        do {
            let answer = try await session.client().setDone(item.id, true)
            if answer.pending {
                // A member's tick on a task that is not theirs waits for the owner. It is news, not an error.
                note = "\(item.title): waiting for a yes."
            } else {
                completed = item
            }
            await load()
        } catch {
            withAnimation { toast = "\(item.title) is not done yet. \(error.localizedDescription)" }
            session.noteReach(error)
        }
        optimistic[item.id] = nil
    }

    private func reopen(_ item: ScreenItem) async {
        do {
            _ = try await session.client().setDone(item.id, false)
            completed = nil
            await load()
        } catch {
            withAnimation { toast = "\(item.title) is still done. \(error.localizedDescription)" }
            session.noteReach(error)
        }
    }

    private func load() async {
        guard session.isPaired else { return }
        // Only Today has a saved copy. Another page shows nothing old while it loads.
        if screen == nil, screenId == "today" {
            if let cached = session.today ?? SnapshotStore.loadPhone() ?? SnapshotStore.load() {
                screen = cached
                session.today = cached
            }
        }
        let asked = screenId
        do {
            let answer = try await session.client().screen(asked)
            // The owner turned the page while this one loaded: keep the new page.
            guard asked == screenId else { return }
            screen = answer
            if asked == "today" {
                session.today = answer
                SnapshotStore.savePhone(answer)
            }
            session.noteReach(nil)
            loaded = true
        } catch is CancellationError {
            return
        } catch {
            // The last day stays, and the pairing stays. The card above it says what happened.
            session.noteReach(error)
            loaded = true
            return
        }
        guard screenId == "today", session.sideWorkDue() else { return }
        // The copies for the widget and the lock screen, and the check of the audit log.
        // A fault here does not change what Today shows.
        do {
            let widget = try await session.client().today(surface: "widget")
            SnapshotStore.save(widget)
            let lock = try await session.client().lock()
            SnapshotStore.savePublic(dueCount: lock.dueCount, title: lock.next?.title ?? "", subtitle: lock.subtitle)
            await LiveEvent.sync(title: lock.next?.title ?? "Nothing coming.", subtitle: lock.subtitle)
            // While the alarm is open, the phone keeps the old tip. That tip is the evidence.
            if !session.auditAlarm {
                if let previous = KeychainStore.loadAuditTip() {
                    let check = try await session.client().checkAuditTip(previous)
                    if check.rewritten {
                        session.raiseAuditAlarm()
                    } else {
                        let tip = try await session.client().auditTip()
                        try? KeychainStore.saveAuditTip(tip.hash)
                    }
                } else {
                    let tip = try await session.client().auditTip()
                    try? KeychainStore.saveAuditTip(tip.hash)
                }
            }
        } catch {
            // The next load tries again.
        }
    }

    @ViewBuilder private func glyph(_ item: ScreenItem) -> some View {
        if item.glyph == "date" {
            Text(item.dateMark ?? "")
                .font(Theme.mono(12, weight: .medium))
                .frame(width: 32, height: 32)
                .background(Theme.ground)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.chip, style: .continuous))
        } else if item.glyph == "flag" {
            Image(systemName: "flag")
                .font(.footnote)
                .frame(width: 32, height: 32)
                .background(Theme.ground)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.chip, style: .continuous))
        } else if item.glyph == "dashed" {
            Circle().stroke(Theme.tealDark, style: StrokeStyle(lineWidth: 1.5, dash: [3, 3])).frame(width: 24, height: 24)
        } else {
            DoneMark(done: item.done)
        }
    }
}

struct Mark: View {
    var size: CGFloat = 22
    var body: some View {
        Image("Mark")
            .resizable()
            .renderingMode(.template)
            .scaledToFit()
            .frame(width: size, height: size)
    }
}

/// A row of Today, opened in a sheet: a person opens the person page, and the rest open the record.
struct OpenedItem: View {
    @Environment(\.dismiss) private var dismiss
    let item: ScreenItem
    /// An editor below has edits that are not saved. Its own Cancel takes the place of Close.
    @State private var unsaved = false

    var body: some View {
        NavigationStack {
            Group {
                ItemPage(type: item.type ?? "task", id: item.id, title: item.title)
            }
            .toolbar {
                if !unsaved { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            }
        }
        .onPreferenceChange(UnsavedEditsKey.self) { unsaved = $0 }
    }
}
