import Foundation

enum ServiceAction: String {
    case start
    case stop
    case restart
    case status
}

struct ServiceSpec: Equatable {
    var label: String
    var domain: String
    var uid: String
    var plistPath: String
}

enum ServiceControl {
    static func command(action: ServiceAction, spec: ServiceSpec) -> [String] {
        let target = spec.domain == "system" ? "system/\(spec.label)" : "gui/\(spec.uid)/\(spec.label)"
        switch action {
        case .status:
            return ["launchctl", "print", target]
        case .stop:
            return ["launchctl", "bootout", target]
        case .start:
            let domain = spec.domain == "system" ? "system" : "gui/\(spec.uid)"
            return ["launchctl", "bootstrap", domain, spec.plistPath]
        case .restart:
            return ["launchctl", "kickstart", "-k", target]
        }
    }

    static func run(_ action: ServiceAction, spec: ServiceSpec) async -> Bool {
        let argv = command(action: action, spec: spec)
        return await Task.detached {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            process.arguments = Array(argv.dropFirst())
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            do {
                try process.run()
                process.waitUntilExit()
                return process.terminationStatus == 0
            } catch {
                return false
            }
        }.value
    }
}
