// The engine itself, linked into this process, against the real worker —
// the harness worker over the seed workspace, started by
// verify-harness/drive-ios.mjs, which also mints the device code this joins
// with. Skipped when run without it.
//
// One journey, because the engine is one per process and a device code
// works once: join as a device, hold the whole workspace locally, sync a
// change up, and leave.

import XCTest
@testable import DoklinKit

final class EngineLiveTests: XCTestCase {
    private struct Pasted: Decodable {
        let endpoint: String?
        let code: String?
    }

    private struct Redeemed: Decodable {
        let endpoint: String
        let token: String
        let name: String
    }

    private struct Status: Decodable {
        let root: String
        let phase: String
        let lastSyncMs: Int?
        let error: String?
    }

    /// The line a person would paste: `doklin-invite <address> <code>`.
    private func line() throws -> String {
        guard let line = ProcessInfo.processInfo.environment["DOKLIN_TEST_DEVICE_LINE"], !line.isEmpty else {
            throw XCTSkip("no worker to talk to — run verify-harness/drive-ios.mjs")
        }
        return line
    }

    /// Wait until the workspace at `root` has synced after `after`, and is idle.
    private func synced(_ root: String, after: Int = 0, within seconds: Double = 60) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        var last: Status?
        while Date() < deadline {
            let all: [Status] = try await Engine.shared.call("cloud_status")
            last = all.first { $0.root == root }
            if let status = last, status.phase == "idle", (status.lastSyncMs ?? 0) > after { return }
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        XCTFail("the workspace did not finish syncing: \(String(describing: last))")
    }

    func testJoinAsADeviceHoldTheWorkspaceSyncAndLeave() async throws {
        let line = try line()
        let fm = FileManager.default
        // The app's container, as iOS would hand it over.
        let container = fm.temporaryDirectory.appendingPathComponent("doklin-engine-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: container) }
        let data = container.appendingPathComponent("Library/Application Support/Doklin")
        try Engine.shared.start(EngineSetup(
            dataDirectory: data,
            workspacesDirectory: container.appendingPathComponent("Documents"),
            anchor: container,
            client: "ios/drive",
            deviceName: "iPhone (engine drive)"
        ))

        // Nothing is connected on a device that has never joined.
        let before: [Status] = try await Engine.shared.call("cloud_status")
        XCTAssertTrue(before.isEmpty)

        // The pasted line is read by the engine, not by Swift.
        let pasted: Pasted = try await Engine.shared.call("cloud_parse_invite", ["text": .string("Here you go:\n\(line)\n")])
        let endpoint = try XCTUnwrap(pasted.endpoint)
        let code = try XCTUnwrap(pasted.code)

        // A code that is no code is refused in a sentence.
        do {
            let _: Redeemed = try await Engine.shared.call("cloud_redeem", ["endpoint": .string(endpoint), "code": "nonsense"])
            XCTFail("a code that is no code was taken")
        } catch let error as DoklinError {
            XCTAssertTrue(error.message.contains("isn't a Doklin code"), error.message)
        }

        // Join: the code becomes this device's own sign-in, and the whole
        // workspace comes down.
        let redeemed: Redeemed = try await Engine.shared.call("cloud_redeem", ["endpoint": .string(endpoint), "code": .string(code)])
        XCTAssertEqual(redeemed.name, "Ada (drive)")
        let events = Engine.shared.events()
        let root: String = try await Engine.shared.call("cloud_join", ["endpoint": .string(redeemed.endpoint), "token": .string(redeemed.token)])
        XCTAssertTrue(root.hasPrefix(container.appendingPathComponent("Documents").path), root)
        try await Engine.shared.run("versions_reconcile")

        let home = try String(contentsOfFile: root + "/Home.md", encoding: .utf8)
        XCTAssertTrue(home.hasPrefix("# Home"), home)
        XCTAssertTrue(fm.fileExists(atPath: root + "/Projects/Roadmap/Ship the boat.md"))
        XCTAssertTrue(fm.fileExists(atPath: root + "/Projects/assets/pic.png"))
        try await synced(root)

        // What is written down holds no absolute path: iOS moves the container.
        let cloud = try String(contentsOf: data.appendingPathComponent("cloud.json"), encoding: .utf8)
        XCTAssertFalse(cloud.contains(container.path), cloud)
        XCTAssertTrue(cloud.contains("\"Documents/"), cloud)

        // The engine said so as it went: the screens are fed by events.
        let heard = Task { () -> Bool in
            for await event in events where event.name == "cloud-status" { _ = event; return true }
            return false
        }
        // An edit made here reaches the domain: write, ring the bus, sync.
        let all: [Status] = try await Engine.shared.call("cloud_status")
        let synced = try XCTUnwrap(all.first { $0.root == root }?.lastSyncMs)
        let note = root + "/From the phone.md"
        try "# From the phone\n\nWritten on a device.\n".write(toFile: note, atomically: true, encoding: .utf8)
        try await Engine.shared.run("touched", ["path": .string(note)])
        try await Engine.shared.run("cloud_sync_now", ["root": .string(root)])
        try await self.synced(root, after: synced)
        let said = await heard.value
        XCTAssertTrue(said)

        // This device is one of its person's, and can add another.
        struct People: Decodable {
            struct Device: Decodable { let id: String; let deviceName: String }
            let role: String
            let can: [String]
            let tokenId: String?
            let devices: [Device]
        }
        let people: People = try await Engine.shared.call("cloud_people", ["root": .string(root)])
        XCTAssertEqual(people.role, "owner")
        XCTAssertTrue(people.can.contains("devices.own"))
        XCTAssertTrue(people.devices.contains { $0.deviceName == "iPhone (engine drive)" }, "\(people.devices.map(\.deviceName))")
        struct DeviceCode: Decodable { let blob: String }
        let another: DeviceCode = try await Engine.shared.call("cloud_device_code", ["root": .string(root)])
        XCTAssertTrue(another.blob.hasPrefix("doklin-invite \(endpoint) dkln-"), another.blob)

        // The folder has a history of its own.
        struct Versions: Decodable { let root: String; let snapshots: Int }
        let stores: [Versions] = try await Engine.shared.call("versions_status")
        XCTAssertTrue(stores.contains { $0.root == root && $0.snapshots >= 1 }, "\(stores.map(\.root))")

        // Leaving ends the sign-in and takes the copy with it.
        let gone: Bool = try await Engine.shared.call("cloud_leave", ["root": .string(root)])
        XCTAssertTrue(gone)
        XCTAssertFalse(fm.fileExists(atPath: root))
        let after: [Status] = try await Engine.shared.call("cloud_status")
        XCTAssertTrue(after.isEmpty)
    }
}
