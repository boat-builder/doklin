// The engine itself, linked into this process, against the real worker —
// the harness worker over the seed workspace, started by
// verify-harness/drive-ios.mjs, which also mints the device code this joins
// with. Skipped when run without it.
//
// One journey, because the engine is one per process and a device code
// works once: join as a device through the models the screens use, hold the
// whole workspace locally, sync a change up, and leave.

import XCTest
@testable import DoklinKit

@MainActor
final class EngineLiveTests: XCTestCase {
    /// The line a person would paste: `doklin-invite <address> <code>`.
    private func line() throws -> String {
        guard let line = ProcessInfo.processInfo.environment["DOKLIN_TEST_DEVICE_LINE"], !line.isEmpty else {
            throw XCTSkip("no worker to talk to — run verify-harness/drive-ios.mjs")
        }
        return line
    }

    /// Wait until the workspace at `root` has synced after `after`, and is idle.
    private func synced(_ device: Workspaces, _ root: String, after: Int = 0, within seconds: Double = 60) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            await device.refresh()
            if let status = device.status(root), status.phase == .idle, (status.lastSyncMs ?? 0) > after { return }
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        XCTFail("the workspace did not finish syncing: \(String(describing: device.status(root)))")
    }

    func testJoinAsADeviceHoldTheWorkspaceSyncAndLeave() async throws {
        let line = try line()
        let fm = FileManager.default
        // The app's container, as iOS would hand it over.
        let container = fm.temporaryDirectory.appendingPathComponent("doklin-engine-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: container) }
        let data = container.appendingPathComponent("Library/Application Support/Doklin")
        let keychain = MemorySecretStore()
        let device = Workspaces(remembered: UserDefaults(suiteName: "doklin-test-\(UUID().uuidString)")!)
        device.start(EngineSetup(
            secrets: keychain,
            dataDirectory: data,
            workspacesDirectory: container.appendingPathComponent("Documents"),
            anchor: container,
            client: "ios/drive",
            deviceName: "iPhone (engine drive)"
        ))
        await device.refresh()
        XCTAssertNil(device.failure)

        // Nothing is connected on a device that has never joined.
        XCTAssertTrue(device.statuses.isEmpty)

        // What is not a line, and a line cut short, are refused in sentences.
        do {
            try await device.join(pasted: "hello there")
            XCTFail("a line that is no line was taken")
        } catch let error as DoklinError {
            XCTAssertTrue(error.message.hasPrefix("That is not a line from Doklin."), error.message)
        }
        let endpointOnly = line.split(separator: " ").dropLast().joined(separator: " ")
        do {
            try await device.join(pasted: endpointOnly)
            XCTFail("half a line was taken")
        } catch let error as DoklinError {
            XCTAssertTrue(error.message.contains("cut short"), error.message)
        }

        // Join, from the whole message the line came in: the code becomes
        // this device's own sign-in, and the whole workspace comes down.
        let root = try await device.join(pasted: "Here you go:\n\(line)\n")
        XCTAssertTrue(root.hasPrefix(container.appendingPathComponent("Documents").path), root)
        XCTAssertEqual(device.selected, root)
        let workspace = device.workspace(root)

        let home = try workspace.files.text("Home.md")
        XCTAssertTrue(home.hasPrefix("# Home"), home)
        XCTAssertTrue(workspace.files.exists("Projects/Roadmap/Ship the boat.md"))
        XCTAssertTrue(workspace.files.exists("Projects/assets/pic.png"))
        try await synced(device, root)

        // The sign-in is in the keeper, by workspace id, and nowhere on disk;
        // what is written down holds no absolute path, since iOS moves the
        // container.
        let status = try XCTUnwrap(device.status(root))
        XCTAssertEqual(keychain.keys, [status.wsId])
        let cloud = try String(contentsOf: data.appendingPathComponent("cloud.json"), encoding: .utf8)
        XCTAssertFalse(cloud.contains(container.path), cloud)
        XCTAssertTrue(cloud.contains("\"Documents/"), cloud)
        XCTAssertTrue(cloud.contains("\"token\": \"\""), cloud)
        XCTAssertFalse(cloud.contains(try XCTUnwrap(keychain.secret(for: status.wsId))), cloud)

        // A folder reads as the Mac's sidebar shows it: a page beside its
        // note is that note's, and comment files are nobody's row.
        let projects = try workspace.files.list("Projects")
        XCTAssertTrue(projects.contains(.folder("Projects/Roadmap")))
        let plan = projects.first { $0.path == "Projects/plan.md" }
        guard case .document(let row) = plan else { return XCTFail("the plan is not a document: \(projects)") }
        XCTAssertEqual(row.html, "Projects/plan.html")
        XCTAssertFalse(try workspace.files.list("").contains { $0.path.hasSuffix(".meta.jsonl") })

        // A note made here reaches the domain: write it, say so, sync.
        let before = try XCTUnwrap(device.status(root)?.lastSyncMs)
        let folder = FolderModel(workspace: workspace, dir: "")
        let made = try await folder.createNote(named: "From the phone")
        XCTAssertEqual(made, "From the phone.md")
        let note = DocumentModel(workspace: workspace, path: made)
        note.load()
        try await note.save("# From the phone\n\nWritten on a device.\n\n- [ ] a box to tick\n", over: "# From the phone\n\n")
        await note.toggleTask(line: 4)
        XCTAssertEqual(note.text, "# From the phone\n\nWritten on a device.\n\n- [x] a box to tick\n")
        await device.syncNow(root)
        try await synced(device, root, after: before)

        // Search reads this copy.
        let search = SearchModel(workspace: workspace)
        await search.run("written on a device")
        XCTAssertEqual(search.results.map(\.path), ["From the phone.md"])

        // This device is one of its person's, and can add another.
        let people: People = try await Engine.shared.call("cloud_people", ["root": .string(root)])
        XCTAssertEqual(people.role, "owner")
        XCTAssertTrue(people.can.contains("devices.own"))
        XCTAssertTrue(people.devices.contains { $0.deviceName == "iPhone (engine drive)" }, "\(people.devices.map(\.deviceName))")
        let another: DeviceCode = try await Engine.shared.call("cloud_device_code", ["root": .string(root)])
        XCTAssertTrue(another.blob.hasPrefix("doklin-invite "), another.blob)

        // The folder has a history of its own.
        XCTAssertTrue(device.versions.contains { $0.root == root && $0.snapshots >= 1 }, "\(device.versions.map(\.root))")

        // Leaving ends the sign-in and takes the copy, and the keeper's
        // sign-in, with it.
        try await device.leave(root)
        XCTAssertFalse(fm.fileExists(atPath: root))
        XCTAssertTrue(device.statuses.isEmpty)
        XCTAssertTrue(keychain.keys.isEmpty, "\(keychain.keys)")
    }
}
