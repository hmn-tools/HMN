import CryptoKit
import Foundation
import Security

enum CertPin {
    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func matches(expected: String, actual: String) -> Bool {
        let left = expected.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let right = actual.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !left.isEmpty, left.count == right.count else { return false }
        var diff = 0
        for (a, b) in zip(left.utf8, right.utf8) {
            diff |= Int(a ^ b)
        }
        return diff == 0
    }

    static func leafFingerprint(_ trust: SecTrust) -> String? {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first else { return nil }
        return sha256Hex(SecCertificateCopyData(leaf) as Data)
    }
}
