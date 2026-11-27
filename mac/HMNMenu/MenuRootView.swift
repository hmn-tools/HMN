import SwiftUI

struct MenuRootView: View {
    @ObservedObject var model: MenuModel
    @State private var ownerDraft = ""
    @State private var confirmRestore = false
    @State private var restoreName = ""
    @State private var restoreLabel = ""
    @State private var confirmRevoke = false
    @State private var revokeName = ""
    @State private var revokeID = ""

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    // An error that no card owns is first. Each other error sits in its own card, next to its control.
                    if !model.notice.isEmpty && model.noticeArea == .general {
                        Text(model.notice)
                            .font(Theme.font(13))
                            .foregroundStyle(Theme.danger)
                            .padding(.horizontal, 4)
                    }
                    if !model.ownerKeyPresent && model.serverState == .running {
                        ownerSection
                    }
                    serverSection
                    if model.panelsReady {
                        externalSection
                        hideSection
                        pairSection
                        deviceSection
                        backupSection
                        modelSection
                        auditSection
                    }
                }
                .padding(.horizontal, Theme.inset)
                .padding(.bottom, Theme.inset)
            }
        }
        // A MenuBarExtra window proposes no height, so a ScrollView with only
        // maxHeight collapses. The header and footer alone are about 80 points
        // tall, and the rest of the panel never appears.
        .frame(width: 360, height: 560)
        .background(Theme.ground)
        .task { await model.refresh() }
        .alert("Restore this backup?", isPresented: $confirmRestore) {
            Button("Restore") {
                let name = restoreName
                Task { await model.restore(name) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("\(restoreLabel). Your records go back to how they were then. Changes made since are lost.")
        }
        .alert("Revoke this phone?", isPresented: $confirmRevoke) {
            Button("Revoke", role: .destructive) {
                let id = revokeID
                Task { await model.revoke(id) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("\(revokeName) loses access, and so do the keys it made.")
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("HMN")
                    .font(Theme.font(22, weight: .semibold))
                    .foregroundStyle(Theme.ink)
                Spacer()
                if model.busy {
                    Text("Working")
                        .font(Theme.font(13))
                        .foregroundStyle(Theme.stone)
                } else {
                    Text(dateLabel)
                        .font(Theme.mono(11, weight: .medium))
                        .foregroundStyle(Theme.stone)
                }
                Button("Refresh") { Task { await model.refresh() } }
                    .buttonStyle(.plain)
                    .font(Theme.font(13, weight: .medium))
                    .foregroundStyle(Theme.ink)
                    .disabled(model.busy)
            }
            Stripe()
        }
        .padding(.horizontal, Theme.inset)
        .padding(.top, 14)
        .padding(.bottom, 10)
    }

    private var serverSection: some View {
        let state = model.serverState
        return VStack(alignment: .leading, spacing: 8) {
            label("Server")
            Text(state.title)
                .font(Theme.font(16, weight: .medium))
                .foregroundStyle(state == .running ? Theme.tealDark : (state == .unreachable || state == .fault ? Theme.danger : Theme.ink))
            Text(serverLine(state))
                .font(Theme.font(13))
                .foregroundStyle(Theme.graphite)
            note(.server)
            HStack(spacing: 8) {
                QuietButton(title: "Start") { Task { await model.start() } }
                    .disabled(model.busy || state == .running || state == .starting || state == .fault)
                QuietButton(title: "Stop") { Task { await model.stop() } }
                    .disabled(model.busy || state == .stopped)
                QuietButton(title: "Restart") { Task { await model.restart() } }
                    .disabled(model.busy || state == .stopped)
            }
        }
        .gardenCard()
    }

    private func serverLine(_ state: ServerState) -> String {
        switch state {
        case .stopped: return "The server is not running. Press Start."
        case .starting: return "This takes a few seconds."
        case .running: return model.version.isEmpty ? "It answers." : "It answers. Version \(model.version)."
        case .unreachable:
            return model.health == "No certificate pin yet."
                ? "There is no certificate pin yet. Start the server once to make one."
                : "It is running, but it does not answer. Try Restart."
        case .fault: return "It answers, but it could not give its status. Try Restart."
        }
    }

    private var externalSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            label("Outside agents")
            Toggle(isOn: Binding(
                get: { model.externalOn },
                set: { on in Task { await model.setExternal(on) } }
            )) {
                Text(model.externalOn ? "On" : "Off")
                    .font(Theme.font(14, weight: .medium))
                    .foregroundStyle(Theme.ink)
            }
            .toggleStyle(.switch)
            .disabled(model.busy)
            .accessibilityLabel("Outside agents")
            Text(model.externalOn
                 ? "Port \(model.externalPort) is open. Outside agents see Personal at most."
                 : "The gate is closed. No outside agent can connect.")
                .font(Theme.font(13))
                .foregroundStyle(model.externalOn ? Theme.tealDark : Theme.graphite)
            note(.outside)
        }
        .gardenCard()
    }

    private var hideSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            label("Hide")
            Text("Phones drop to public. Nothing is deleted.")
                .font(Theme.font(13))
                .foregroundStyle(Theme.graphite)
            if model.hiddenCount > 0 {
                Text("\(model.hiddenCount) \(model.hiddenCount == 1 ? "phone is" : "phones are") hidden.")
                    .font(Theme.font(13))
                    .foregroundStyle(Theme.tealDark)
            }
            QuietButton(title: model.hiddenCount > 0 ? "Show my things" : "Hide my things") {
                Task { await model.hide() }
            }
            .disabled(model.busy)
            note(.hide)
        }
        .gardenCard()
    }

    private var pairSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            label("Pairing")
            QuietButton(title: "Pair a phone", filled: true) { Task { await model.pair() } }
                .disabled(model.busy)
            if !model.pairingCode.isEmpty {
                Text(model.pairingCode)
                    .font(Theme.mono(21, weight: .semibold))
                    .tracking(4)
                    .foregroundStyle(Theme.ink)
                    .textSelection(.enabled)
                Text("Use it once, in the next ten minutes.")
                    .font(Theme.font(13))
                    .foregroundStyle(Theme.stone)
                if let image = QRCode.image(for: model.pairingPayload) {
                    Image(nsImage: image)
                        .interpolation(.none)
                        .resizable()
                        .frame(width: 148, height: 148)
                        .accessibilityLabel("QR code to pair a phone")
                }
            }
            note(.pair)
        }
        .gardenCard()
    }

    private var deviceSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            label("Phones")
            if model.devices.isEmpty {
                Text("No phone is paired.")
                    .font(Theme.font(13))
                    .foregroundStyle(Theme.graphite)
            }
            ForEach(model.devices) { device in
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(device.name)
                            .font(Theme.font(14, weight: .medium))
                            .foregroundStyle(Theme.ink)
                        Text(deviceLine(device))
                            .font(Theme.font(13))
                            .foregroundStyle(Theme.stone)
                    }
                    Spacer()
                    if !device.isRevoked {
                        Button("Revoke") {
                            revokeID = device.id
                            revokeName = device.name
                            confirmRevoke = true
                        }
                        .buttonStyle(.plain)
                        .font(Theme.font(13, weight: .medium))
                        .foregroundStyle(Theme.danger)
                        .disabled(model.busy)
                        .accessibilityLabel("Revoke \(device.name)")
                    }
                }
            }
            note(.phones)
        }
        .gardenCard()
    }

    private var backupSection: some View {
        let files = model.backups.sorted { $0.modifiedAt > $1.modifiedAt }
        return VStack(alignment: .leading, spacing: 8) {
            label("Backups")
            QuietButton(title: "Back up now") { Task { await model.backup() } }
                .disabled(model.busy)
            if files.isEmpty {
                Text("No backup yet.")
                    .font(Theme.font(13))
                    .foregroundStyle(Theme.graphite)
            }
            ForEach(Array(files.prefix(5))) { file in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(backupTitle(file))
                            .font(Theme.font(13, weight: .medium))
                            .foregroundStyle(Theme.ink)
                            .lineLimit(1)
                        Text(MenuWords.size(file.bytes))
                            .font(Theme.font(13))
                            .foregroundStyle(Theme.stone)
                    }
                    Spacer()
                    Button("Restore") {
                        restoreName = file.name
                        restoreLabel = backupTitle(file)
                        confirmRestore = true
                    }
                    .buttonStyle(.plain)
                    .font(Theme.font(13, weight: .medium))
                    .foregroundStyle(Theme.ink)
                    .disabled(model.busy)
                    .accessibilityLabel("Restore the backup from \(backupTitle(file))")
                }
            }
            if files.count > 5 {
                Text("The latest 5 of \(files.count).")
                    .font(Theme.font(13))
                    .foregroundStyle(Theme.stone)
            }
            note(.backups)
        }
        .gardenCard()
    }

    private func backupTitle(_ file: BackupFile) -> String {
        let when = MenuWords.when(file.modifiedAt)
        return when.isEmpty ? "A backup" : when
    }

    private var modelSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            label("Models")
            Text(model.voice)
                .font(Theme.font(13))
                .foregroundStyle(Theme.graphite)
            Text(model.modelRam.hasPrefix("no")
                 ? "No extra memory in use."
                 : "Uses \(model.modelRam) of memory.")
                .font(Theme.font(13))
                .foregroundStyle(Theme.stone)
            Text(model.spendLine)
                .font(Theme.font(13))
                .foregroundStyle(model.spendNotice ? Theme.danger : Theme.graphite)
            if model.modelRoutes.isEmpty {
                Text("No job has a model yet.")
                    .font(Theme.font(13))
                    .foregroundStyle(Theme.graphite)
            }
            ForEach(model.modelRoutes, id: \.self) { line in
                Text(line)
                    .font(Theme.font(13))
                    .foregroundStyle(Theme.ink)
            }
            ForEach(model.localModels) { item in
                HStack {
                    Text(item.name)
                        .font(Theme.font(13))
                        .foregroundStyle(Theme.ink)
                    Spacer()
                    Button(item.installed ? "Remove" : "Install") {
                        Task {
                            if item.installed {
                                await model.removeModel(item.id)
                            } else {
                                await model.pullModel(item.id)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .font(Theme.font(13, weight: .medium))
                    .foregroundStyle(item.installed ? Theme.danger : Theme.ink)
                    .disabled(model.busy)
                    .accessibilityLabel("\(item.installed ? "Remove" : "Install") \(item.name)")
                }
            }
            note(.models)
        }
        .gardenCard()
    }

    private var auditSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            label("Activity")
            Text(model.chain)
                .font(Theme.font(13, weight: .medium))
                .foregroundStyle(model.chainOK == false ? Theme.danger : Theme.tealDark)
            if model.audit.isEmpty {
                Text("No private reads yet.")
                    .font(Theme.font(13))
                    .foregroundStyle(Theme.graphite)
            }
            ForEach(Array(model.audit.prefix(20))) { entry in
                VStack(alignment: .leading, spacing: 1) {
                    Text(auditTitle(entry))
                        .font(Theme.font(13, weight: .medium))
                        .foregroundStyle(Theme.ink)
                    Text(auditDetail(entry))
                        .font(Theme.font(13))
                        .foregroundStyle(Theme.stone)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
            }
            if model.audit.count > 20 {
                Text("The latest 20 of \(model.audit.count).")
                    .font(Theme.font(13))
                    .foregroundStyle(Theme.stone)
            }
        }
        .gardenCard()
    }

    private func auditTitle(_ entry: AuditEntry) -> String {
        let tier = MenuWords.tier(entry.tier)
        let action = MenuWords.action(entry.action)
        return tier.isEmpty ? action : "\(action), \(tier)"
    }

    private func auditDetail(_ entry: AuditEntry) -> String {
        [MenuWords.surface(entry.surface), MenuWords.when(entry.at)].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private var ownerSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            label("Owner key")
            Text("Paste the owner key from the first start. It is saved in the Keychain and not shown again.")
                .font(Theme.font(13))
                .foregroundStyle(Theme.graphite)
            SecureField("Owner key", text: $ownerDraft)
                .textFieldStyle(.plain)
                .font(Theme.font(13))
                .padding(.horizontal, 12)
                .frame(minHeight: 36)
                .background(Theme.card)
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.hair, lineWidth: 1))
            QuietButton(title: "Save in Keychain") {
                if model.saveOwnerKey(ownerDraft) {
                    ownerDraft = ""
                    Task { await model.refresh() }
                } else {
                    model.noticeArea = .owner
                    model.notice = "That is not an owner key. It starts with hmn_ and has no spaces."
                }
            }
            .disabled(ownerDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            note(.owner)
        }
        .gardenCard()
    }

    private var dateLabel: String {
        let formatter = DateFormatter()
        formatter.locale = Locale.current
        formatter.setLocalizedDateFormatFromTemplate("EEE d MMM")
        return formatter.string(from: Date()).uppercased()
    }

    private func label(_ text: String) -> some View {
        Text(text.uppercased())
            .font(Theme.mono(11, weight: .medium))
            .tracking(0.8)
            .foregroundStyle(Theme.stone)
    }

    /// The sentence for an error, in danger, inside the card whose control caused it.
    @ViewBuilder
    private func note(_ area: NoticeArea) -> some View {
        if !model.notice.isEmpty && model.noticeArea == area {
            Text(model.notice)
                .font(Theme.font(13))
                .foregroundStyle(Theme.danger)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func deviceLine(_ device: PairedDevice) -> String {
        if device.isRevoked { return "Revoked" }
        if device.isHidden { return "Hidden. It sees public things only." }
        return "Sees up to \(MenuWords.tier(device.maxTier))"
    }
}

struct QuietButton: View {
    var title: String
    var filled = false
    var action: () -> Void
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        // A pill. The filled one is the one ink button of the panel. The others are white with a hair edge.
        Button(action: action) {
            Text(title)
                .font(Theme.font(13, weight: .medium))
                .frame(maxWidth: .infinity, minHeight: 32)
                .foregroundStyle(filled ? Theme.paper : Theme.ink)
                .background(filled ? Theme.ink : Theme.card)
                .clipShape(Capsule())
                .overlay(Capsule().stroke(filled ? Color.clear : Theme.hair, lineWidth: 1))
                .contentShape(Capsule())
                .opacity(isEnabled ? 1 : 0.45)
        }
        .buttonStyle(.plain)
    }
}
