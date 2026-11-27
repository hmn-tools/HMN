import SwiftUI

enum AppTab { case today, people, projects, agents }

struct RootView: View {
    @EnvironmentObject private var session: Session
    @Environment(\.scenePhase) private var phase
    @State private var tab: AppTab = .today

    var body: some View {
        ZStack(alignment: .bottom) {
            Theme.ground.ignoresSafeArea()
            Group {
                if session.isMember {
                    MemberRootView()
                } else {
                switch tab {
                case .today: TodayView()
                case .people: NavigationStack { PeopleView() }
                case .projects: NavigationStack { ProjectsHome() }
                case .agents: NavigationStack { AgentsView() }
                }
                }
            }
            .padding(.bottom, session.isMember ? 0 : 76)
            if !session.isMember { tabBar }
        }
        .sheet(isPresented: $session.showCapture) { CaptureView().themed() }
        .sheet(isPresented: $session.showSettings) {
            if session.isMember { MemberSettingsView().themed() } else { SettingsView().themed() }
        }
        .sheet(item: $session.pairLink) { link in PairLinkSheet(link: link).themed() }
        .onOpenURL { url in
            guard let link = PairLink(url) else { return }
            // One sheet at a time: close the others first, then ask.
            let busy = session.showSettings || session.showCapture
            session.showSettings = false
            session.showCapture = false
            Task {
                if busy { try? await Task.sleep(for: .milliseconds(500)) }
                session.pairLink = link
            }
        }
        .task { await session.refreshMember() }
        .task { await session.flushInbox() }
        .task { await session.refreshWaiting() }
        // A new day: each screen reads again, so yesterday's rows do not stay.
        .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged).receive(on: RunLoop.main)) { _ in
            session.refreshTick += 1
        }
        .overlay {
            // The app switcher takes its picture when the scene is not active. This cover is all it sees.
            if phase != .active {
                ZStack {
                    Theme.ground.ignoresSafeArea()
                    Mark(size: 40).foregroundStyle(Theme.ink)
                }
            }
        }
        .onChange(of: phase) { _, next in
            if next == .active {
                // Back at the front: the open screen reads again, and so do the Review count and the hidden state.
                session.refreshTick += 1
                Task {
                    await session.flushInbox()
                    await session.refreshMember()
                    await session.refreshWaiting()
                }
            }
            if next == .inactive || next == .background { session.persistConnection() }
            if next == .background { session.closeVault() }
        }
    }

    /// The tab bar is one white pill above the ground. The plus is the one ink circle on it.
    private var tabBar: some View {
        HStack(spacing: 0) {
            tabButton(.today, "Today")
            tabButton(.people, "People")
            Button { session.showCapture = true } label: {
                Image(systemName: "plus")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Theme.paper)
                    .frame(width: 48, height: 48)
                    .background(Theme.ink)
                    .clipShape(Circle())
            }
            .padding(.horizontal, 4)
            .accessibilityLabel("Capture")
            tabButton(.projects, "Projects")
            tabButton(.agents, "Review", count: session.waiting)
        }
        .padding(.horizontal, 8)
        .frame(height: 64)
        .background(Theme.card)
        .clipShape(Capsule())
        .shadow(color: Theme.shadow.opacity(0.2), radius: 14, x: 0, y: 10)
        .padding(.horizontal, 16)
        .padding(.bottom, 4)
    }

    private func tabButton(_ value: AppTab, _ title: String, count: Int = 0) -> some View {
        Button { tab = value } label: {
            HStack(spacing: 4) {
                Text(title)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                if count > 0 {
                    // A small count when something waits. It is the one mark on the bar that is not a tab.
                    Text(count > 99 ? "99+" : "\(count)")
                        .font(Theme.sans(10, weight: .semibold))
                        .monospacedDigit()
                        .foregroundStyle(Theme.paper)
                        .padding(.horizontal, 5)
                        .frame(minWidth: 16, minHeight: 16)
                        .background(Theme.tealDark)
                        .clipShape(Capsule())
                }
            }
            .font(Theme.sans(13, weight: .medium))
            .foregroundStyle(tab == value ? Theme.ink : Theme.stone)
            .frame(maxWidth: .infinity, minHeight: 48)
            .background(tab == value ? Theme.ground : Color.clear)
            .clipShape(Capsule())
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(count > 0 ? "\(title), \(count) waiting" : title)
        .accessibilityAddTraits(tab == value ? [.isSelected] : [])
    }
}
