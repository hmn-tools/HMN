import UIKit
import UniformTypeIdentifiers

@objc(ShareViewController)
public final class ShareViewController: UIViewController {
    override public func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        Task { await capture() }
    }

    private func capture() async {
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        var text: [String] = []
        var attachments: [PendingFile] = []
        for item in items {
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                    attachments.append(PendingFile(kind: "photo", name: "photo", contentType: "image"))
                } else if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                    if let url = await load(provider, UTType.fileURL.identifier) as? URL {
                        attachments.append(PendingFile(kind: "file", name: url.lastPathComponent, contentType: "file"))
                        if text.isEmpty { text.append(url.lastPathComponent) }
                    }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    if let value = await load(provider, UTType.plainText.identifier) as? String { text.append(value) }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    if let url = await load(provider, UTType.url.identifier) as? URL { text.append(url.absoluteString) }
                }
            }
        }
        let body = text.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        if !body.isEmpty || !attachments.isEmpty {
            InboxQueue.enqueue(text: body, source: "share", privateNote: false, attachments: attachments)
        } else {
            InboxQueue.requestOpen()
        }
        extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
    }

    private func load(_ provider: NSItemProvider, _ type: String) async -> NSSecureCoding? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: type, options: nil) { item, _ in
                continuation.resume(returning: item)
            }
        }
    }
}
