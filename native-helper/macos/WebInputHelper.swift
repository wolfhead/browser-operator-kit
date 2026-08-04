import AppKit
import ApplicationServices
import Darwin
import Foundation

private struct Point: Codable, Equatable {
    let x: Double
    let y: Double
}

private struct TrajectoryStep: Codable, Equatable {
    let point: Point
    let delayMs: Double
}

private struct TrajectoryPlan: Codable, Equatable {
    let seed: UInt64
    let start: Point
    let target: Point
    let distance: Double
    let durationMs: Double
    let holdMs: Double
    let steps: [TrajectoryStep]
}

private struct WheelStep: Codable, Equatable {
    let deltaY: Int
    let delayMs: Double
}

private struct WheelPlan: Codable, Equatable {
    let deltaY: Int
    let durationMs: Double
    let steps: [WheelStep]
}

private struct StatusResult: Codable {
    let accessibilityPostEventAccess: Bool
    let frontmostBundleIdentifier: String
    let frontmostProcessIdentifier: Int32?
    let frontmostWindowBounds: Rectangle?
}

private struct ApplicationActivationResult: Codable {
    let command: String
    let processIdentifier: Int32
    let bundleIdentifier: String
    let activated: Bool
    let frontmostBundleIdentifier: String
}

private struct BrowserBootstrapResult: Codable {
    let command: String
    let bundleIdentifier: String
    let runningBefore: Bool
    let openedUrl: Bool
    let activated: Bool
    let processIdentifier: Int32?
    let frontmostBundleIdentifier: String
}

private struct Rectangle: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    init(_ rectangle: CGRect) {
        x = rectangle.origin.x
        y = rectangle.origin.y
        width = rectangle.width
        height = rectangle.height
    }
}

private struct ExecutionResult: Codable {
    let command: String
    let seed: UInt64
    let steps: Int
    let durationMs: Double
    let holdMs: Double
    let deltaY: Int?
    let wheelEvents: Int?
    let wheelDurationMs: Double?
    let typedCharacterCount: Int?
    let inputMethod: String?
    let clipboardRestored: Bool?
    let arrived: Bool
    let finalDistancePx: Double
    let replanAttempts: Int
    let emittedMoveEvents: Int
    let movementElapsedMs: Double
    let clickEmitted: Bool
}

private struct PointerMovementResult {
    let arrived: Bool
    let finalDistancePx: Double
    let replanAttempts: Int
    let emittedMoveEvents: Int
    let elapsedMs: Double
    let clickEmitted: Bool
}

private struct SplitMix64 {
    private var state: UInt64

    init(seed: UInt64) {
        state = seed
    }

    mutating func next() -> UInt64 {
        state &+= 0x9E3779B97F4A7C15
        var value = state
        value = (value ^ (value >> 30)) &* 0xBF58476D1CE4E5B9
        value = (value ^ (value >> 27)) &* 0x94D049BB133111EB
        return value ^ (value >> 31)
    }

    mutating func double(in range: ClosedRange<Double>) -> Double {
        let unit = Double(next() >> 11) / Double(1 << 53)
        return range.lowerBound + unit * (range.upperBound - range.lowerBound)
    }

    mutating func sign() -> Double {
        (next() & 1) == 0 ? -1 : 1
    }
}

private enum TrajectoryPlanner {
    static func plan(start: Point, target: Point, seed: UInt64) -> TrajectoryPlan {
        var random = SplitMix64(seed: seed)
        let deltaX = target.x - start.x
        let deltaY = target.y - start.y
        let distance = hypot(deltaX, deltaY)

        if distance < 0.5 {
            let holdMs = random.double(in: 62...128)
            return TrajectoryPlan(
                seed: seed,
                start: start,
                target: target,
                distance: distance,
                durationMs: 0,
                holdMs: holdMs,
                steps: [TrajectoryStep(point: target, delayMs: 0)]
            )
        }

        let durationJitter = random.double(in: 0.90...1.12)
        let rawDuration = (210 + sqrt(distance) * 17) * durationJitter
        let durationMs = clamp(rawDuration, lower: 260, upper: 920)
        let stepCount = Int(clamp(round(durationMs / 12.5), lower: 22, upper: 74))

        let unitX = deltaX / distance
        let unitY = deltaY / distance
        let perpendicularX = -unitY
        let perpendicularY = unitX
        let curveDirection = random.sign()
        let curveMagnitude = min(max(distance * random.double(in: 0.045...0.095), 7), 62)
        let firstProgress = random.double(in: 0.24...0.38)
        let secondProgress = random.double(in: 0.62...0.80)
        let firstCurve = curveMagnitude * curveDirection
        let secondCurve = curveMagnitude * curveDirection * random.double(in: 0.45...0.85)

        let control1 = Point(
            x: start.x + deltaX * firstProgress + perpendicularX * firstCurve,
            y: start.y + deltaY * firstProgress + perpendicularY * firstCurve
        )
        let control2 = Point(
            x: start.x + deltaX * secondProgress + perpendicularX * secondCurve,
            y: start.y + deltaY * secondProgress + perpendicularY * secondCurve
        )

        var rawDelays = (0..<stepCount).map { _ in random.double(in: 0.86...1.14) }
        let delayScale = durationMs / rawDelays.reduce(0, +)
        rawDelays = rawDelays.map { $0 * delayScale }

        var steps = [TrajectoryStep(point: start, delayMs: 0)]
        for index in 1...stepCount {
            let linearProgress = Double(index) / Double(stepCount)
            let easedProgress = minimumJerk(linearProgress)
            var point = cubicBezier(
                start: start,
                control1: control1,
                control2: control2,
                end: target,
                t: easedProgress
            )
            if index == stepCount {
                point = target
            }
            steps.append(TrajectoryStep(point: point, delayMs: rawDelays[index - 1]))
        }

        return TrajectoryPlan(
            seed: seed,
            start: start,
            target: target,
            distance: distance,
            durationMs: durationMs,
            holdMs: random.double(in: 62...128),
            steps: steps
        )
    }

    private static func minimumJerk(_ t: Double) -> Double {
        10 * pow(t, 3) - 15 * pow(t, 4) + 6 * pow(t, 5)
    }

    private static func cubicBezier(
        start: Point,
        control1: Point,
        control2: Point,
        end: Point,
        t: Double
    ) -> Point {
        let inverse = 1 - t
        let startWeight = pow(inverse, 3)
        let control1Weight = 3 * pow(inverse, 2) * t
        let control2Weight = 3 * inverse * pow(t, 2)
        let endWeight = pow(t, 3)
        return Point(
            x: startWeight * start.x + control1Weight * control1.x + control2Weight * control2.x + endWeight * end.x,
            y: startWeight * start.y + control1Weight * control1.y + control2Weight * control2.y + endWeight * end.y
        )
    }
}

private enum WheelPlanner {
    static func plan(deltaY: Int, seed: UInt64) -> WheelPlan {
        var random = SplitMix64(seed: seed ^ 0xD1B54A32D192ED03)
        let magnitude = abs(deltaY)
        let direction = deltaY < 0 ? -1 : 1
        let eventCount = Int(clamp(round(Double(magnitude) / 58), lower: 8, upper: 22))
        let durationMs = clamp(
            160 + sqrt(Double(magnitude)) * 7.5 * random.double(in: 0.90...1.12),
            lower: 210,
            upper: 460
        )
        var weights = (0..<eventCount).map { index -> Double in
            let progress = Double(index + 1) / Double(eventCount + 1)
            return max(sin(.pi * progress), 0.15) * random.double(in: 0.90...1.10)
        }
        let weightTotal = weights.reduce(0, +)
        weights = weights.map { $0 / weightTotal }

        var deltas = weights.map { max(Int(round(Double(magnitude) * $0)), 1) * direction }
        deltas[deltas.count - 1] += deltaY - deltas.reduce(0, +)
        var rawDelays = (0..<eventCount).map { _ in random.double(in: 0.82...1.18) }
        let delayScale = durationMs / rawDelays.reduce(0, +)
        rawDelays = rawDelays.map { $0 * delayScale }
        return WheelPlan(
            deltaY: deltaY,
            durationMs: durationMs,
            steps: zip(deltas, rawDelays).map { delta, delay in
                WheelStep(deltaY: delta, delayMs: delay)
            }
        )
    }
}

private enum HelperError: Error, CustomStringConvertible {
    case invalidArguments(String)
    case accessibilityPermissionMissing
    case frontmostApplicationIsNotChrome(String)
    case noChromeWindow
    case targetOutsideChromeWindow(Point, CGRect)
    case eventCreationFailed(String)
    case clipboardWriteFailed
    case chromeApplicationUnavailable
    case chromeLaunchFailed
    case chromeActivationFailed(String)
    case applicationActivationFailed(String, String)
    case urlOpenFailed
    case pointerDidNotConverge(Int, Double)

    var description: String {
        switch self {
        case .invalidArguments(let message):
            return message
        case .accessibilityPermissionMissing:
            return "macOS Accessibility permission is not granted. Enable it manually for the terminal or app launching this helper."
        case .frontmostApplicationIsNotChrome(let bundleIdentifier):
            return "Refusing input: the frontmost application '\(bundleIdentifier)' is not in the allowed browser bundle list."
        case .noChromeWindow:
            return "Refusing input: no visible frontmost Chrome window was found."
        case .targetOutsideChromeWindow(let point, let bounds):
            return "Refusing input: target (\(point.x), \(point.y)) is outside the frontmost Chrome window \(bounds)."
        case .eventCreationFailed(let eventName):
            return "Could not create the \(eventName) mouse event."
        case .clipboardWriteFailed:
            return "Could not place the requested text on the macOS clipboard."
        case .chromeApplicationUnavailable:
            return "Google Chrome is not installed as bundle 'com.google.Chrome'."
        case .chromeLaunchFailed:
            return "Google Chrome did not start within the allowed bootstrap interval."
        case .chromeActivationFailed(let bundleIdentifier):
            return "Google Chrome did not become the frontmost application; frontmost is '\(bundleIdentifier)'."
        case .applicationActivationFailed(let expected, let actual):
            return "The previous application '\(expected)' did not become frontmost; frontmost is '\(actual)'."
        case .urlOpenFailed:
            return "Could not open the requested HTTP(S) URL in the allowed browser."
        case .pointerDidNotConverge(let attempts, let distance):
            return "Pointer did not converge on the target after \(attempts) replans; final distance is \(String(format: "%.2f", distance)) px. No click was emitted."
        }
    }
}

private struct CommandOptions {
    let command: String
    let target: Point?
    let seed: UInt64
    let execute: Bool
    let deltaY: Int?
    let text: String?
    let bundleIdentifier: String?
    let processIdentifier: Int32?
    let url: URL?
}

private enum ArgumentParser {
    static func parse(_ arguments: [String]) throws -> CommandOptions {
        guard let command = arguments.first else {
            throw HelperError.invalidArguments(usage)
        }
        if ["status", "self-test", "activate-chrome"].contains(command) {
            return CommandOptions(
                command: command,
                target: nil,
                seed: 1,
                execute: false,
                deltaY: nil,
                text: nil,
                bundleIdentifier: command == "activate-chrome" ? "com.google.Chrome" : nil,
                processIdentifier: nil,
                url: nil
            )
        }
        if command == "activate-browser" {
            guard arguments.count == 3, arguments[1] == "--bundle-id" else {
                throw HelperError.invalidArguments("activate-browser requires --bundle-id <allowed-bundle-id>.")
            }
            return CommandOptions(
                command: command,
                target: nil,
                seed: 1,
                execute: false,
                deltaY: nil,
                text: nil,
                bundleIdentifier: arguments[2],
                processIdentifier: nil,
                url: nil
            )
        }
        if command == "open-url" {
            guard arguments.count == 5,
                  arguments[1] == "--bundle-id",
                  arguments[3] == "--url-base64",
                  let data = Data(base64Encoded: arguments[4]),
                  let decoded = String(data: data, encoding: .utf8),
                  let url = URL(string: decoded),
                  ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
                  url.user == nil,
                  url.password == nil else {
                throw HelperError.invalidArguments("open-url requires --bundle-id <allowed-bundle-id> --url-base64 <http(s)-url-base64>.")
            }
            return CommandOptions(
                command: command,
                target: nil,
                seed: 1,
                execute: false,
                deltaY: nil,
                text: nil,
                bundleIdentifier: arguments[2],
                processIdentifier: nil,
                url: url
            )
        }
        if command == "restore-application" {
            guard arguments.count == 3,
                  arguments[1] == "--process-id",
                  let processIdentifier = Int32(arguments[2]),
                  processIdentifier > 0 else {
                throw HelperError.invalidArguments("restore-application requires --process-id <positive-pid>.")
            }
            return CommandOptions(
                command: command,
                target: nil,
                seed: 1,
                execute: false,
                deltaY: nil,
                text: nil,
                bundleIdentifier: nil,
                processIdentifier: processIdentifier,
                url: nil
            )
        }
        guard ["plan", "move", "move-click", "scroll", "type-text"].contains(command) else {
            throw HelperError.invalidArguments("Unknown command: \(command)\n\n\(usage)")
        }

        var x: Double?
        var y: Double?
        var seed = UInt64(Date().timeIntervalSince1970 * 1_000_000)
        var execute = false
        var deltaY: Int?
        var text: String?
        var index = 1
        while index < arguments.count {
            switch arguments[index] {
            case "--x", "--y", "--seed", "--delta-y", "--text-base64":
                guard index + 1 < arguments.count else {
                    throw HelperError.invalidArguments("Missing value for \(arguments[index]).")
                }
                let value = arguments[index + 1]
                if arguments[index] == "--x" {
                    x = Double(value)
                } else if arguments[index] == "--y" {
                    y = Double(value)
                } else if arguments[index] == "--delta-y" {
                    deltaY = Int(value)
                } else if arguments[index] == "--text-base64" {
                    guard let data = Data(base64Encoded: value),
                          let decoded = String(data: data, encoding: .utf8) else {
                        throw HelperError.invalidArguments("--text-base64 is not valid UTF-8 base64.")
                    }
                    text = decoded
                } else {
                    seed = UInt64(value) ?? seed
                }
                index += 2
            case "--execute":
                execute = true
                index += 1
            default:
                throw HelperError.invalidArguments("Unknown option: \(arguments[index])")
            }
        }
        guard let x, let y else {
            throw HelperError.invalidArguments("Both --x and --y are required.")
        }
        if command != "plan" && !execute {
            throw HelperError.invalidArguments("Real input requires the explicit --execute flag.")
        }
        if command == "scroll" && !(80...2_400).contains(abs(deltaY ?? 0)) {
            throw HelperError.invalidArguments("scroll requires --delta-y with magnitude between 80 and 2400.")
        }
        if command == "type-text" && (text?.isEmpty != false || (text?.count ?? 0) > 240) {
            throw HelperError.invalidArguments("type-text requires 1 to 240 characters in --text-base64.")
        }
        return CommandOptions(
            command: command,
            target: Point(x: x, y: y),
            seed: seed,
            execute: execute,
            deltaY: deltaY,
            text: text,
            bundleIdentifier: nil,
            processIdentifier: nil,
            url: nil
        )
    }

    static let usage = """
    Usage:
      web-input-helper status
      web-input-helper self-test
      web-input-helper activate-chrome
      web-input-helper activate-browser --bundle-id <allowed-bundle-id>
      web-input-helper restore-application --process-id <existing-pid>
      web-input-helper open-url --bundle-id <allowed-bundle-id> --url-base64 <http(s)-url-base64>
      web-input-helper plan --x <screen-x> --y <screen-y> [--seed <uint64>]
      web-input-helper move --x <screen-x> --y <screen-y> [--seed <uint64>] --execute
      web-input-helper move-click --x <screen-x> --y <screen-y> [--seed <uint64>] --execute
      web-input-helper scroll --x <screen-x> --y <screen-y> --delta-y <-2400...-80|80...2400> [--seed <uint64>] --execute
      web-input-helper type-text --x <screen-x> --y <screen-y> --text-base64 <base64> [--seed <uint64>] --execute
    """
}

private enum BrowserBootstrap {
    static func run(bundleIdentifier: String, url: URL?) throws -> BrowserBootstrapResult {
        guard ChromeGuard.isAllowed(bundleIdentifier) else {
            throw HelperError.frontmostApplicationIsNotChrome(bundleIdentifier)
        }
        let workspace = NSWorkspace.shared
        guard let applicationURL = workspace.urlForApplication(
            withBundleIdentifier: bundleIdentifier
        ) else {
            throw HelperError.chromeApplicationUnavailable
        }

        let runningBefore = !NSRunningApplication.runningApplications(
            withBundleIdentifier: bundleIdentifier
        ).isEmpty

        if let url {
            try openApplication(
                workspace: workspace,
                applicationURL: applicationURL,
                [url],
                timeoutSeconds: 8
            )
        } else {
            try openApplication(
                workspace: workspace,
                applicationURL: applicationURL,
                [],
                timeoutSeconds: 8
            )
        }

        guard let chrome = waitForChromeProcess(bundleIdentifier: bundleIdentifier, timeoutSeconds: 8) else {
            throw HelperError.chromeLaunchFailed
        }
        let activationOptions: NSApplication.ActivationOptions = [.activateAllWindows]
        _ = chrome.activate(options: activationOptions)

        let activationDeadline = Date().addingTimeInterval(5)
        while Date() < activationDeadline {
            if workspace.frontmostApplication?.bundleIdentifier == bundleIdentifier {
                return BrowserBootstrapResult(
                    command: url != nil
                        ? "open-url"
                        : (bundleIdentifier == "com.google.Chrome" ? "activate-chrome" : "activate-browser"),
                    bundleIdentifier: bundleIdentifier,
                    runningBefore: runningBefore,
                    openedUrl: url != nil,
                    activated: true,
                    processIdentifier: chrome.processIdentifier,
                    frontmostBundleIdentifier: bundleIdentifier
                )
            }
            Thread.sleep(forTimeInterval: 0.1)
            _ = chrome.activate(options: activationOptions)
        }

        throw HelperError.chromeActivationFailed(
            workspace.frontmostApplication?.bundleIdentifier ?? "unknown"
        )
    }

    private static func waitForChromeProcess(
        bundleIdentifier: String,
        timeoutSeconds: TimeInterval
    ) -> NSRunningApplication? {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while Date() < deadline {
            if let application = NSRunningApplication.runningApplications(
                withBundleIdentifier: bundleIdentifier
            ).first(where: { !$0.isTerminated }) {
                return application
            }
            Thread.sleep(forTimeInterval: 0.1)
        }
        return nil
    }

    private static func openApplication(
        workspace: NSWorkspace,
        applicationURL: URL,
        _ urls: [URL],
        timeoutSeconds: TimeInterval
    ) throws {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        configuration.addsToRecentItems = false
        var completed = false
        var openError: Error?
        let completion: (NSRunningApplication?, Error?) -> Void = { _, error in
            openError = error
            completed = true
        }
        if urls.isEmpty {
            workspace.openApplication(
                at: applicationURL,
                configuration: configuration,
                completionHandler: completion
            )
        } else {
            workspace.open(
                urls,
                withApplicationAt: applicationURL,
                configuration: configuration,
                completionHandler: completion
            )
        }

        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while !completed && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        if let openError {
            throw openError
        }
        guard completed else {
            throw urls.isEmpty
                ? HelperError.chromeLaunchFailed
                : HelperError.urlOpenFailed
        }
    }
}

private enum ApplicationRestorer {
    static func restore(processIdentifier: pid_t) throws -> ApplicationActivationResult {
        guard let application = NSRunningApplication(processIdentifier: processIdentifier),
              !application.isTerminated else {
            throw HelperError.invalidArguments("The recorded application process is no longer running.")
        }
        let bundleIdentifier = application.bundleIdentifier ?? "unknown"
        if let applicationURL = application.bundleURL {
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = true
            configuration.addsToRecentItems = false
            var completed = false
            NSWorkspace.shared.openApplication(
                at: applicationURL,
                configuration: configuration
            ) { _, _ in
                completed = true
            }
            let openDeadline = Date().addingTimeInterval(2)
            while !completed && Date() < openDeadline {
                RunLoop.current.run(until: Date().addingTimeInterval(0.05))
            }
        }
        let activationOptions: NSApplication.ActivationOptions = [.activateAllWindows]
        _ = application.activate(options: activationOptions)
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline {
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == processIdentifier {
                return ApplicationActivationResult(
                    command: "restore-application",
                    processIdentifier: processIdentifier,
                    bundleIdentifier: bundleIdentifier,
                    activated: true,
                    frontmostBundleIdentifier: bundleIdentifier
                )
            }
            Thread.sleep(forTimeInterval: 0.05)
            _ = application.activate(options: activationOptions)
        }
        throw HelperError.applicationActivationFailed(
            bundleIdentifier,
            NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "unknown"
        )
    }
}

private enum ChromeGuard {
    private static var allowedBundleIdentifiers: Set<String> {
        let configured = ProcessInfo.processInfo.environment["WEB_AUTOMATION_ALLOWED_BUNDLE_IDS"]
            .map { value in
                value.split(separator: ",")
                    .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }
            } ?? []
        return Set(["com.google.Chrome"] + configured)
    }

    static func validate(target: Point) throws {
        guard CGPreflightPostEventAccess() else {
            throw HelperError.accessibilityPermissionMissing
        }
        let frontmost = NSWorkspace.shared.frontmostApplication
        let bundleIdentifier = frontmost?.bundleIdentifier ?? "unknown"
        guard allowedBundleIdentifiers.contains(bundleIdentifier) else {
            throw HelperError.frontmostApplicationIsNotChrome(bundleIdentifier)
        }
        guard let processIdentifier = frontmost?.processIdentifier,
              let windowBounds = frontmostWindowBounds(processIdentifier: processIdentifier) else {
            throw HelperError.noChromeWindow
        }
        guard windowBounds.contains(CGPoint(x: target.x, y: target.y)) else {
            throw HelperError.targetOutsideChromeWindow(target, windowBounds)
        }
    }

    static func isAllowed(_ bundleIdentifier: String) -> Bool {
        allowedBundleIdentifiers.contains(bundleIdentifier)
    }

    static func frontmostWindowBounds(processIdentifier: pid_t) -> CGRect? {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }
        var candidateBounds: [CGRect] = []
        for window in windows {
            guard let ownerPID = window[kCGWindowOwnerPID as String] as? pid_t,
                  ownerPID == processIdentifier,
                  let layer = window[kCGWindowLayer as String] as? Int,
                  layer == 0,
                  let boundsDictionary = window[kCGWindowBounds as String] as? NSDictionary,
                  let x = boundsDictionary["X"] as? NSNumber,
                  let y = boundsDictionary["Y"] as? NSNumber,
                  let width = boundsDictionary["Width"] as? NSNumber,
                  let height = boundsDictionary["Height"] as? NSNumber else {
                continue
            }
            let bounds = CGRect(
                x: x.doubleValue,
                y: y.doubleValue,
                width: width.doubleValue,
                height: height.doubleValue
            )
            guard bounds.width > 0, bounds.height > 0 else {
                continue
            }
            candidateBounds.append(bounds)
        }
        return preferredWindowBounds(candidateBounds)
    }

    static func preferredWindowBounds(_ candidates: [CGRect]) -> CGRect? {
        candidates.first(where: { bounds in
            bounds.width >= 320 && bounds.height >= 240
        })
    }
}

private enum MouseEmitter {
    private static let deviationTolerancePx = 8.0
    private static let arrivalTolerancePx = 3.0
    private static let maximumReplans = 32
    private static let maximumMovementSeconds = 4.0
    private static let stableArrivalSeconds = 0.055
    private static let motionSampleSeconds = 0.025
    private static let motionSampleCount = 4
    private static let motionSettledTolerancePx = 2.0

    static func execute(plan initialPlan: TrajectoryPlan, click: Bool) throws -> PointerMovementResult {
        try ChromeGuard.validate(target: initialPlan.target)
        let source = CGEventSource(stateID: .hidSystemState)
        let startedAt = Date()
        let deadline = startedAt.addingTimeInterval(maximumMovementSeconds)
        var plan = initialPlan
        var stepIndex = 1
        var expectedPointer = initialPlan.start
        var replanAttempts = 0
        var emittedMoveEvents = 0

        func distance(_ lhs: Point, _ rhs: Point) -> Double {
            hypot(lhs.x - rhs.x, lhs.y - rhs.y)
        }

        func failureDistance() -> Double {
            (try? currentPointer()).map { distance($0, initialPlan.target) } ?? .infinity
        }

        func latestPointerAfterMotion() throws -> Point {
            var latest = try currentPointer()
            for _ in 0..<motionSampleCount {
                Thread.sleep(forTimeInterval: motionSampleSeconds)
                let next = try currentPointer()
                if distance(next, latest) <= motionSettledTolerancePx {
                    return next
                }
                latest = next
            }
            return latest
        }

        func replan(from actual: Point) throws {
            guard replanAttempts < maximumReplans, Date() < deadline else {
                throw HelperError.pointerDidNotConverge(replanAttempts, distance(actual, initialPlan.target))
            }
            replanAttempts += 1
            let replanSeed = initialPlan.seed &+ UInt64(replanAttempts) &* 0x9E3779B97F4A7C15
            plan = TrajectoryPlanner.plan(start: actual, target: initialPlan.target, seed: replanSeed)
            expectedPointer = actual
            stepIndex = 1
        }

        while true {
            guard Date() < deadline else {
                throw HelperError.pointerDidNotConverge(replanAttempts, failureDistance())
            }
            if stepIndex >= plan.steps.count {
                let actual = try currentPointer()
                if distance(actual, initialPlan.target) > arrivalTolerancePx {
                    try replan(from: actual)
                    continue
                }
                Thread.sleep(forTimeInterval: stableArrivalSeconds)
                let stablePointer = try currentPointer()
                if distance(stablePointer, initialPlan.target) > arrivalTolerancePx {
                    try replan(from: stablePointer)
                    continue
                }
                try ChromeGuard.validate(target: initialPlan.target)
                break
            }

            let step = plan.steps[stepIndex]
            if step.delayMs > 0 {
                Thread.sleep(forTimeInterval: step.delayMs / 1_000)
            }
            let actual = try currentPointer()
            if distance(actual, expectedPointer) > deviationTolerancePx {
                try replan(from: latestPointerAfterMotion())
                continue
            }
            guard let event = CGEvent(
                mouseEventSource: source,
                mouseType: .mouseMoved,
                mouseCursorPosition: CGPoint(x: step.point.x, y: step.point.y),
                mouseButton: .left
            ) else {
                throw HelperError.eventCreationFailed("mouseMoved")
            }
            event.post(tap: .cghidEventTap)
            emittedMoveEvents += 1
            expectedPointer = step.point
            stepIndex += 1
        }

        guard click else {
            let finalPointer = try currentPointer()
            return PointerMovementResult(
                arrived: true,
                finalDistancePx: distance(finalPointer, initialPlan.target),
                replanAttempts: replanAttempts,
                emittedMoveEvents: emittedMoveEvents,
                elapsedMs: Date().timeIntervalSince(startedAt) * 1_000,
                clickEmitted: false
            )
        }
        guard let mouseDown = CGEvent(
            mouseEventSource: source,
            mouseType: .leftMouseDown,
            mouseCursorPosition: CGPoint(x: initialPlan.target.x, y: initialPlan.target.y),
            mouseButton: .left
        ) else {
            throw HelperError.eventCreationFailed("leftMouseDown")
        }
        mouseDown.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: plan.holdMs / 1_000)
        guard let mouseUp = CGEvent(
            mouseEventSource: source,
            mouseType: .leftMouseUp,
            mouseCursorPosition: CGPoint(x: initialPlan.target.x, y: initialPlan.target.y),
            mouseButton: .left
        ) else {
            throw HelperError.eventCreationFailed("leftMouseUp")
        }
        mouseUp.post(tap: .cghidEventTap)
        let finalPointer = try currentPointer()
        return PointerMovementResult(
            arrived: true,
            finalDistancePx: distance(finalPointer, initialPlan.target),
            replanAttempts: replanAttempts,
            emittedMoveEvents: emittedMoveEvents,
            elapsedMs: Date().timeIntervalSince(startedAt) * 1_000,
            clickEmitted: true
        )
    }

    static func scroll(plan: WheelPlan, at target: Point) throws {
        let source = CGEventSource(stateID: .hidSystemState)
        for step in plan.steps {
            if step.delayMs > 0 {
                Thread.sleep(forTimeInterval: step.delayMs / 1_000)
            }
            guard let event = CGEvent(
                scrollWheelEvent2Source: source,
                units: .pixel,
                wheelCount: 1,
                wheel1: Int32(-step.deltaY),
                wheel2: 0,
                wheel3: 0
            ) else {
                throw HelperError.eventCreationFailed("scrollWheel")
            }
            event.location = CGPoint(x: target.x, y: target.y)
            event.post(tap: .cghidEventTap)
        }
    }

    static func pasteText(_ text: String, at target: Point, seed: UInt64) throws -> Bool {
        var random = SplitMix64(seed: seed ^ 0x94D049BB133111EB)
        Thread.sleep(forTimeInterval: random.double(in: 0.20...0.34))
        try ChromeGuard.validate(target: target)

        let pasteboard = NSPasteboard.general
        let snapshot = PasteboardSnapshot(pasteboard: pasteboard)
        pasteboard.clearContents()
        guard pasteboard.setString(text, forType: .string) else {
            _ = snapshot.restore(to: pasteboard)
            throw HelperError.clipboardWriteFailed
        }
        let ownedChangeCount = pasteboard.changeCount
        let source = CGEventSource(stateID: .hidSystemState)
        do {
            try postKey(source: source, keyCode: 0, flags: .maskCommand)
            Thread.sleep(forTimeInterval: random.double(in: 0.30...0.52))
            try postKey(source: source, keyCode: 9, flags: .maskCommand)
        } catch {
            if pasteboard.changeCount == ownedChangeCount {
                _ = snapshot.restore(to: pasteboard)
            }
            throw error
        }

        Thread.sleep(forTimeInterval: random.double(in: 0.55...0.82))
        guard pasteboard.changeCount == ownedChangeCount else {
            return false
        }
        return snapshot.restore(to: pasteboard)
    }

    private static func postKey(
        source: CGEventSource?,
        keyCode: CGKeyCode,
        flags: CGEventFlags
    ) throws {
        guard let keyDown = CGEvent(
            keyboardEventSource: source,
            virtualKey: keyCode,
            keyDown: true
        ), let keyUp = CGEvent(
            keyboardEventSource: source,
            virtualKey: keyCode,
            keyDown: false
        ) else {
            throw HelperError.eventCreationFailed("keyboard")
        }
        keyDown.flags = flags
        keyUp.flags = flags
        keyDown.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.05)
        keyUp.post(tap: .cghidEventTap)
    }
}

private struct PasteboardSnapshot {
    private let items: [[NSPasteboard.PasteboardType: Data]]

    init(pasteboard: NSPasteboard) {
        items = (pasteboard.pasteboardItems ?? []).map { item in
            Dictionary(uniqueKeysWithValues: item.types.compactMap { type in
                item.data(forType: type).map { (type, $0) }
            })
        }
    }

    func restore(to pasteboard: NSPasteboard) -> Bool {
        pasteboard.clearContents()
        guard !items.isEmpty else {
            return true
        }
        let restoredItems = items.map { storedTypes -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, data) in storedTypes {
                item.setData(data, forType: type)
            }
            return item
        }
        return pasteboard.writeObjects(restoredItems)
    }
}

private func currentPointer() throws -> Point {
    guard let location = CGEvent(source: nil)?.location else {
        throw HelperError.eventCreationFailed("pointer location")
    }
    return Point(x: location.x, y: location.y)
}

private func printJSON<T: Encodable>(_ value: T) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    let data = try encoder.encode(value)
    print(String(decoding: data, as: UTF8.self))
}

private func runSelfTests() throws {
    let start = Point(x: 80, y: 120)
    let target = Point(x: 980, y: 650)
    let plan = TrajectoryPlanner.plan(start: start, target: target, seed: 42)
    let repeated = TrajectoryPlanner.plan(start: start, target: target, seed: 42)
    let different = TrajectoryPlanner.plan(start: start, target: target, seed: 43)
    var failures: [String] = []

    if plan != repeated { failures.append("same seed did not reproduce the plan") }
    if plan == different { failures.append("different seeds produced the same plan") }
    if plan.steps.first?.point != start { failures.append("path does not start at the pointer") }
    if plan.steps.last?.point != target { failures.append("path does not end at the target") }
    if !(260...920).contains(plan.durationMs) { failures.append("duration is outside bounds") }
    if !(62...128).contains(plan.holdMs) { failures.append("mouse hold is outside bounds") }
    if !(23...75).contains(plan.steps.count) { failures.append("event count is outside bounds") }

    let maximumSegment = zip(plan.steps, plan.steps.dropFirst()).map { pair in
        hypot(pair.1.point.x - pair.0.point.x, pair.1.point.y - pair.0.point.y)
    }.max() ?? .infinity
    if maximumSegment > max(80, plan.distance * 0.15) {
        failures.append("path contains an excessive position jump")
    }

    let lineLength = max(plan.distance, 1)
    let lineDeltaX = target.x - start.x
    let lineDeltaY = target.y - start.y
    let lineConstant = target.x * start.y - target.y * start.x
    let maximumCurve = plan.steps.map { step -> Double in
        let numerator = lineDeltaY * step.point.x - lineDeltaX * step.point.y + lineConstant
        return abs(numerator) / lineLength
    }.max() ?? 0
    if maximumCurve < 3 { failures.append("long path is effectively straight") }

    let closePointer = Point(x: target.x + 2, y: target.y - 1)
    let displacedPointer = Point(x: target.x + 12, y: target.y)
    if hypot(closePointer.x - target.x, closePointer.y - target.y) > 3 {
        failures.append("arrival tolerance rejects a close pointer")
    }
    if hypot(displacedPointer.x - target.x, displacedPointer.y - target.y) <= 8 {
        failures.append("displacement tolerance accepts an external pointer move")
    }

    let wheelPlan = WheelPlanner.plan(deltaY: 720, seed: 42)
    let repeatedWheelPlan = WheelPlanner.plan(deltaY: 720, seed: 42)
    let upwardWheelPlan = WheelPlanner.plan(deltaY: -720, seed: 42)
    if wheelPlan != repeatedWheelPlan { failures.append("same seed did not reproduce wheel events") }
    if wheelPlan.steps.reduce(0, { $0 + $1.deltaY }) != 720 {
        failures.append("wheel event deltas do not sum to the requested distance")
    }
    if upwardWheelPlan.steps.reduce(0, { $0 + $1.deltaY }) != -720 {
        failures.append("upward wheel event deltas do not sum to the requested distance")
    }
    if !(8...22).contains(wheelPlan.steps.count) {
        failures.append("wheel event count is outside bounds")
    }
    if !(210...460).contains(wheelPlan.durationMs) {
        failures.append("wheel duration is outside bounds")
    }

    let utilityWindow = CGRect(x: 59, y: 953, width: 75, height: 22)
    let browserWindow = CGRect(x: 52, y: 38, width: 1460, height: 944)
    if ChromeGuard.preferredWindowBounds([utilityWindow, browserWindow]) != browserWindow {
        failures.append("Chrome utility window was selected before the browser window")
    }
    if ChromeGuard.preferredWindowBounds([utilityWindow]) != nil {
        failures.append("utility-only Chrome windows should not authorize input")
    }

    if failures.isEmpty {
        print("PASS: trajectory planner checks completed")
        return
    }
    for failure in failures {
        fputs("FAIL: \(failure)\n", stderr)
    }
    exit(1)
}

private func clamp<T: Comparable>(_ value: T, lower: T, upper: T) -> T {
    min(max(value, lower), upper)
}

do {
    let options = try ArgumentParser.parse(Array(CommandLine.arguments.dropFirst()))
    switch options.command {
    case "status":
        let frontmostApplication = NSWorkspace.shared.frontmostApplication
        let frontmostBounds = frontmostApplication.flatMap { application in
            ChromeGuard.frontmostWindowBounds(processIdentifier: application.processIdentifier)
        }
        try printJSON(StatusResult(
            accessibilityPostEventAccess: CGPreflightPostEventAccess(),
            frontmostBundleIdentifier: frontmostApplication?.bundleIdentifier ?? "unknown",
            frontmostProcessIdentifier: frontmostApplication?.processIdentifier,
            frontmostWindowBounds: frontmostBounds.map(Rectangle.init)
        ))
    case "self-test":
        try runSelfTests()
    case "activate-chrome", "activate-browser", "open-url":
        guard let bundleIdentifier = options.bundleIdentifier else {
            throw HelperError.invalidArguments("An allowed browser bundle identifier is required.")
        }
        try printJSON(BrowserBootstrap.run(
            bundleIdentifier: bundleIdentifier,
            url: options.url
        ))
    case "restore-application":
        guard let processIdentifier = options.processIdentifier else {
            throw HelperError.invalidArguments("A recorded process identifier is required.")
        }
        try printJSON(ApplicationRestorer.restore(processIdentifier: processIdentifier))
    case "plan", "move", "move-click", "scroll", "type-text":
        guard let target = options.target else {
            throw HelperError.invalidArguments("A target is required.")
        }
        let plan = TrajectoryPlanner.plan(start: try currentPointer(), target: target, seed: options.seed)
        if options.command == "plan" {
            try printJSON(plan)
        } else {
            let shouldClick = options.command == "move-click" || options.command == "type-text"
            let movement = try MouseEmitter.execute(plan: plan, click: shouldClick)
            let wheelPlan = options.command == "scroll"
                ? WheelPlanner.plan(deltaY: options.deltaY ?? 0, seed: options.seed)
                : nil
            if let wheelPlan {
                try MouseEmitter.scroll(plan: wheelPlan, at: target)
            }
            let clipboardRestored = options.command == "type-text" && options.text != nil
                ? try MouseEmitter.pasteText(options.text!, at: target, seed: options.seed)
                : nil
            try printJSON(ExecutionResult(
                command: options.command,
                seed: options.seed,
                steps: plan.steps.count,
                durationMs: plan.durationMs,
                holdMs: plan.holdMs,
                deltaY: wheelPlan?.deltaY,
                wheelEvents: wheelPlan?.steps.count,
                wheelDurationMs: wheelPlan?.durationMs,
                typedCharacterCount: options.command == "type-text" ? options.text?.count : nil,
                inputMethod: options.command == "type-text" ? "clipboard-paste" : nil,
                clipboardRestored: clipboardRestored,
                arrived: movement.arrived,
                finalDistancePx: movement.finalDistancePx,
                replanAttempts: movement.replanAttempts,
                emittedMoveEvents: movement.emittedMoveEvents,
                movementElapsedMs: movement.elapsedMs,
                clickEmitted: movement.clickEmitted
            ))
        }
    default:
        throw HelperError.invalidArguments(ArgumentParser.usage)
    }
} catch {
    fputs("Error: \(error)\n", stderr)
    exit(1)
}
