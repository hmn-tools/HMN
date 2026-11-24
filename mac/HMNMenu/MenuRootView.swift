import SwiftUI

struct MenuRootView: View {
    @ObservedObject var model: MenuModel
    @State private var ownerDraft = ""
    @State private var confirmRestore = false
    @State private var restoreName = ""
    @State private var confirmRevoke = false
    @State private var revokeName = ""
    @State private var revokeID = ""

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    // An error is first, in danger, next to nothing else.
                    if !model.notice.isEmpty {
                        Text(model.notice)
                            .font(Theme.font(13))
                            .foregroundStyle(Theme.danger)
                            .padding(.horizontal, 4)
                    }
                    if !model.ownerKeyPresent {
                        ownerSection
                    }
                    serverSection
                    externalSection
                    hideSection
                    pairSection
                    deviceSection
                    backupSection
                    modelSection
                    auditSection
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 12)
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
            Text("The graph returns to that copy.")
        }
        .alert("Revoke this phone?", isPresented: $confirmRevoke) {
            Button("Revoke", role: .destructive) {
                let id = revokeID
                Task { await model.revoke(id) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("\(revokeName). The keys that this phone made are revoked with it.")
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("HMN")
                    .font(Theme.font(22, weight: .semibold))
                    .foregroundStyle(Theme.ink)
                Spacer()
                Text(dateLabel)
                    .font(Theme.mono(11, weight: .medium))
                    .foregroundStyle(Theme.stone)
                Button("Refresh") { Task { await model.refresh() } }
                    .buttonStyle(.plain)
                    .font(Theme.font(13, weight: .medium))
                    .foregroundStyle(Theme.ink)
            }
            Stripe()
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 10)
    }

    private var serverSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            label("Server")
            Text("Launchd · \(model.launchd)")
                .font(Theme.font(12))
                .foregroundStyle(Theme.graphite)
            Text(serverLine)
                .font(Theme.font(12))
                .foregroundStyle(Theme.graphite)
            HStack(spacing: 8) {
                QuietButton(title: "Start") { Task { await model.start() } }
                QuietButton(title: "Stop") { Task { await model.stop() } }
                QuietButton(title: "Restart") { Task { await model.restart() } }
            }
        }
        .gardenCard()
    }

    private var externalSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            label("Outside agents")
            Text("Off until you turn it on. The switch calls the mini, on localhost, and never leaves this machine.")
                .font(Theme.font(12))
                .foregroundStyle(Theme.graphite)
            Text(model.externalOn ? "Port \(model.externalPort) is open. Personal at most." : "The gate is closed.")
                .font(Theme.font(12))
                .foregroundStyle(model.externalOn ? Theme.tealDark : Theme.stone)
            Toggle("Outside agents", isOn: Binding(
                get: { model.externalOn },
                set: { on in Task { await model.setExternal(on) } }
            ))
            .font(Theme.font(14))
            .labelsHidden()
            .accessibilityLabel("Outside agents")
        }
        .gardenCard()
    }

    private var serverLine: String {
        if model.version.isEmpty { return "Server · \(model.health)" }
        return "Server · \(model.health) · \(model.version)"
    }

    private var hideSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            label("Hide")
            Text("Phones drop to public. Nothing is deleted.")
                .font(Theme.font(12))
                .foregroundStyle(Theme.graphite)
            if model.hiddenCount > 0 {
                Text("\(model.hiddenCount) \(model.hiddenCount == 1 ? "phone is" : "phones are") hidden.")
                    .font(Theme.font(12))
                    .foregroundStyle(Theme.tealDark)
            }
            QuietButton(title: model.hiddenCount > 0 ? "Show my things" : "Hide") {
                Task { await model.hide() }
            }
        }
        .gardenCard()
    }

    private var pairSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            label("Pair a phone")
            QuietButton(title: "Pair a phone", filled: true) { Task { await model.pair() } }
            if !model.pairingCode.isEmpty {
                Text(model.pairingCode)
                    .font(Theme.mono(21, weight: .semibold))
                    .tracking(4)
                    .foregroundStyle(Theme.ink)
                Text("Single use. Dies in ten minutes.")
                    .font(Theme.font(12))
                    .foregroundStyle(Theme.stone)
                if let image = QRCode.image(for: model.pairingPayload) {
                    Image(nsImage: image)
                        .interpolation(.none)
                        .resizable()
                        .frame(width: 148, height: 148)
                        .accessibilityLabel("Pairing code")
                }
            }
        }
        .gardenCard()
    }

    private var deviceSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            label("Phones")
            if model.devices.isEmpty {
                Text("No phone is paired.")
                    .font(Theme.font(12))
                    .foregroundStyle(Theme.graphite)
            }
            ForEach(model.devices) { device in
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(device.name)
                            .font(Theme.font(14, weight: .medium))
                            .foregroundStyle(Theme.ink)
                        Text(deviceLine(device))
                            .font(Theme.font(12))
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
                    }
                }
            }
        }
        .gardenCard()
    }

    private var backupSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            label("Backups")
            QuietButton(title: "Back up") { Task { await model.backup() } }
            if model.backups.isEmpty {
                Text("No backup yet.")
                    .font(Theme.font(12))
                    .foregroundStyle(Theme.graphite)
            }
            ForEach(model.backups) { file in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(file.name)
                            .font(Theme.font(12))
                            .foregroundStyle(Theme.ink)
                            .lineLimit(1)
                        Text("\(file.bytes) bytes")
                            .font(Theme.font(12))
                            .foregroundStyle(Theme.stone)
                    }
                    Spacer()
                    Button("Restore") {
                        restoreName = file.name
                        confirmRestore = true
                    }
                        .buttonStyle(.plain)
                        .font(Theme.font(12))
                        .foregroundStyle(Theme.ink)
                }
            }
        }
        .gardenCard()
    }

    private var modelSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            label("Models")
            Text(model.voice)
                .font(Theme.font(12))
                .foregroundStyle(Theme.graphite)
            Text("RAM · \(model.modelRam)")
                .font(Theme.font(12))
                .foregroundStyle(Theme.stone)
            Text(model.spendLine)
                .font(Theme.font(12))
                .foregroundStyle(model.spendNotice ? Theme.danger : Theme.graphite)
            if model.modelRoutes.isEmpty {
                Text("No route yet.")
                    .font(Theme.font(12))
                    .foregroundStyle(Theme.graphite)
            }
            ForEach(model.modelRoutes, id: \.self) { line in
                Text(line)
                    .font(Theme.font(12))
                    .foregroundStyle(Theme.ink)
            }
            ForEach(model.localModels) { item in
                HStack {
                    Text(item.name)
                        .font(Theme.font(12))
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
                    .font(Theme.font(12))
                    .foregroundStyle(Theme.ink)
                }
            }
        }
        .gardenCard()
    }

    private var auditSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            label("Activity")
            Text(model.chain)
                .font(Theme.font(12, weight: .medium))
                .foregroundStyle(model.chainOK == false ? Theme.danger : Theme.tealDark)
            if model.audit.isEmpty {
                Text("No private reads yet.")
                    .font(Theme.font(12))
                    .foregroundStyle(Theme.graphite)
            }
            ForEach(Array(model.audit.prefix(40))) { entry in
                HStack {
                    Text(String(entry.at.prefix(16)).replacingOccurrences(of: "T", with: " "))
                    Spacer()
                    Text(entry.action)
                    Text(entry.tier ?? "none")
                    Text(entry.surface ?? "none")
                }
                .font(Theme.mono(11))
                .foregroundStyle(Theme.graphite)
            }
        }
        .gardenCard()
    }

    private var ownerSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            label("Owner key")
            Text("Paste the owner key from the first boot. It is saved in the Keychain and not shown again.")
                .font(Theme.font(12))
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
                    model.notice = "That key was not saved."
                }
            }
        }
        .gardenCard()
    }

    private var dateLabel: String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_GB")
        formatter.dateFormat = "EEE dd/MM/yyyy"
        return formatter.string(from: Date()).uppercased()
    }

    private func label(_ text: String) -> some View {
        Text(text.uppercased())
            .font(Theme.mono(11, weight: .medium))
            .tracking(0.8)
            .foregroundStyle(Theme.stone)
    }

    private func deviceLine(_ device: PairedDevice) -> String {
        if device.isRevoked { return "Revoked" }
        if device.isHidden { return "Hidden · public" }
        return "Paired · \(device.maxTier)"
    }
}

struct QuietButton: View {
    var title: String
    var filled = false
    var action: () -> Void

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
        }
        .buttonStyle(.plain)
    }
}
