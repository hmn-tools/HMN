import SwiftUI

/// The people of the home who use HMN on their own phone. docs/ONTOLOGY.md, section 5.4.
struct HouseholdView: View {
    @EnvironmentObject private var session: Session
    @State private var members: [Member] = []
    @State private var people: [Entity] = []
    @State private var loaded = false
    @State private var message: String?
    @State private var personId: String?
    @State private var role = "partner"
    @State private var code: MemberCode?
    @State private var working = false
    @State private var revoking: Member?
    @State private var fridge: FridgeStatus?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let message { MessageLine(text: message, isError: true) }
                if !loaded { LoadingState() }
                if loaded && members.isEmpty { EmptyState(title: "Just you for now.") }
                if !members.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(members) { member in
                            memberRow(member)
                            if member.id != members.last?.id { Theme.hair.frame(height: 1).padding(.leading, Theme.Space.l) }
                        }
                    }
                    .card(padding: 0)
                }
                if let code { codeCard(code) }
                if let up = fridge?.fridge { fridgeCard(up) }
                SmallLabel(text: "Add a member").padding(.top, 10)
                VStack(alignment: .leading, spacing: 12) {
                    Menu {
                        ForEach(candidates) { person in
                            Button(person.title) { personId = person.id }
                        }
                    } label: {
                        HStack {
                            Text(chosenName ?? "Choose a person").font(Theme.row)
                                .foregroundStyle(chosenName == nil ? Theme.stone : Theme.ink)
                            Spacer()
                            Image(systemName: "chevron.up.chevron.down").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.stone)
                        }
                        .padding(.horizontal, 14)
                        .frame(minHeight: 48)
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.hair, lineWidth: 1))
                    }
                    HStack(spacing: 6) {
                        Button("Partner") { role = "partner" }.buttonStyle(ChipButtonStyle(selected: role == "partner"))
                        Button("Child") { role = "child" }.buttonStyle(ChipButtonStyle(selected: role == "child"))
                    }
                    Text(role == "partner" ? "Sees the household and the Family area. Adds, ticks, and edits." : "Sees the household. Adds and ticks on lists and on their own tasks.")
                        .font(Theme.small).foregroundStyle(Theme.stone)
                    // Side by side when they fit, one above the other with large text.
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 8) { codeButtons }
                        VStack(alignment: .leading, spacing: 8) { codeButtons }
                    }
                }
                .card()
            }
            .padding(16)
        }
        .navigationTitle("Household")
        .navigationBarTitleDisplayMode(.inline)
        .background(Theme.ground.ignoresSafeArea())
        .confirmationDialog("Revoke this phone?", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), titleVisibility: .visible) {
            Button("Revoke", role: .destructive) {
                if let member = revoking { Task { await revoke(member) } }
                revoking = nil
            }
            Button("Cancel", role: .cancel) { revoking = nil }
        } message: {
            Text("\(revoking?.name ?? "This phone") stops at once. Their records stay.")
        }
        .onAppear { Task { await load() } }
    }

    @ViewBuilder private var codeButtons: some View {
        Button(working ? "Making the code" : "Make a code") { Task { await makeCode(fridge: false) } }
            .buttonStyle(PillButtonStyle())
            .disabled(personId == nil || working)
        // Only with a display claimed at Household: the fridge draws the code as a QR code.
        if fridge?.ready == true {
            Button("Show on the fridge") { Task { await makeCode(fridge: true) } }
                .buttonStyle(PillButtonStyle(kind: .secondary))
                .disabled(personId == nil || working)
        }
    }

    /// Anyone but you. A person with a phone already can get a second one.
    private var candidates: [Entity] { people.filter { $0.kind != "self" } }

    private var chosenName: String? { people.first { $0.id == personId }?.title }

    private func memberRow(_ member: Member) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(member.name).font(Theme.row).foregroundStyle(Theme.ink)
                Text(subtitle(member)).font(Theme.small).foregroundStyle(Theme.stone)
            }
            Spacer()
            Button("Revoke") { revoking = member }.buttonStyle(TextButtonStyle(danger: true))
        }
        .padding(.horizontal, Theme.Space.l)
        .frame(minHeight: 60)
    }

    private func subtitle(_ member: Member) -> String {
        var parts = [Words.id(member.role)]
        if member.hidden { parts.append("Hidden") }
        if let used = member.lastUsedAt, DateText.parse(used) != nil {
            parts.append("Last seen \(When.day(used))")
        } else {
            parts.append("Not used yet")
        }
        return parts.joined(separator: " · ")
    }

    private func codeCard(_ code: MemberCode) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SmallLabel(text: "Code for \(code.person.title)")
            Text(code.code).font(Theme.mono(28, weight: .semibold)).foregroundStyle(Theme.ink).textSelection(.enabled)
            Text("Pair their phone with it before \(endTime(code.expiresAt)).").font(Theme.small).foregroundStyle(Theme.stone)
        }
        .card()
    }

    /// The code on the fridge: whose, until when, and a way to take it off. The phone never shows the code here.
    private func fridgeCard(_ up: FridgeStatus.FridgePairing) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SmallLabel(text: "On the fridge")
            Text(up.personName.map { "\($0)'s phone" } ?? "A new phone").font(Theme.heading)
            Text("Until \(endTime(up.expiresAt)). The fridge shows it within a few minutes. Press the button on its back to show it now.")
                .font(Theme.small).foregroundStyle(Theme.stone)
                .fixedSize(horizontal: false, vertical: true)
            Button("Take it off") { Task { await endFridge() } }.buttonStyle(TextButtonStyle(danger: true))
        }
        .card()
    }

    private func endTime(_ iso: String) -> String {
        guard let date = DateText.parse(iso) else { return "it ends" }
        return When.time(date)
    }

    private func load() async {
        do {
            members = try await session.client().members()
            people = try await session.client().entities("person")
            fridge = try? await session.client().fridgePairing()
            message = nil
        } catch { message = error.localizedDescription }
        loaded = true
    }

    private func makeCode(fridge onFridge: Bool) async {
        guard let personId else { return }
        working = true
        defer { working = false }
        do {
            let made = try await session.client().memberCode(personId: personId, role: role, fridge: onFridge)
            // A code on the fridge stays off this screen. The fridge card says whose it is and until when.
            code = onFridge ? nil : made
            fridge = try? await session.client().fridgePairing()
            message = nil
        } catch { message = error.localizedDescription }
    }

    private func endFridge() async {
        do {
            try await session.client().endFridgePairing()
            fridge = try? await session.client().fridgePairing()
        } catch { message = error.localizedDescription }
    }

    private func revoke(_ member: Member) async {
        do {
            try await session.client().revokeMember(member.id)
            await load()
        } catch { message = error.localizedDescription }
    }
}
