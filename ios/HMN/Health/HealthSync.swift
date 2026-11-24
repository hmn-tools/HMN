import Foundation
import HealthKit

enum HealthSync {
    static let includeNumbersKey = "hmn.health.includeNumbers"

    static var includeNumbers: Bool {
        get { UserDefaults.standard.bool(forKey: includeNumbersKey) }
        set { UserDefaults.standard.set(newValue, forKey: includeNumbersKey) }
    }

    /// The HealthKit entitlement is not in this build. Without it, HealthKit raises an exception.
    /// Set this to true only together with the entitlement and the usage text.
    static let isEnabled = false

    static func summaries() async throws -> [[String: Any]] {
        guard isEnabled else { throw HMNError.message("Health numbers are not available yet.") }
        let store = HKHealthStore()
        guard HKHealthStore.isHealthDataAvailable() else { return [] }
        guard let steps = HKObjectType.quantityType(forIdentifier: .stepCount) else { return [] }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            store.requestAuthorization(toShare: [], read: [steps]) { granted, error in
                if let error { continuation.resume(throwing: error); return }
                if granted { continuation.resume() }
                else { continuation.resume(throwing: HMNError.message("Health access was declined.")) }
            }
        }
        let start = Calendar.current.startOfDay(for: Date())
        let predicate = HKQuery.predicateForSamples(withStart: start, end: Date())
        let total: Double = try await withCheckedThrowingContinuation { continuation in
            let query = HKStatisticsQuery(quantityType: steps, quantitySamplePredicate: predicate, options: .cumulativeSum) { _, result, error in
                if let error { continuation.resume(throwing: error); return }
                let value = result?.sumQuantity()?.doubleValue(for: .count()) ?? 0
                continuation.resume(returning: value)
            }
            store.execute(query)
        }
        var row: [String: Any] = [
            "id": "hk-steps-\(Self.dayStamp())",
            "label": "Steps",
            "day": Self.dayStamp(),
        ]
        if includeNumbers {
            row["value"] = Int(total)
            row["unit"] = "count"
        }
        return [row]
    }

    private static func dayStamp() -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_GB")
        // The day of a step total is the day on this phone.
        formatter.timeZone = TimeZone.current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: Date())
    }
}
