// What the app keeps on the device: the list of workspaces it is logged in
// to, each one's token, and copies of what was last read.
//
// A token lives in the Keychain and nowhere else — never in the accounts
// file, never in a cache, never in a log. That is the CLI's rule for
// `credentials.json` (docs/cloud-people-agents.md, "CLI"), kept here.

import Foundation
#if canImport(Security)
import Security
#endif

/// Where tokens are kept. The app uses the Keychain; tests use memory.
public protocol SecretStore: Sendable {
    func secret(for key: String) -> String?
    /// Store `value`, or remove what is there when it is nil.
    func setSecret(_ value: String?, for key: String) throws
}

public final class MemorySecretStore: SecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]

    public init() {}

    public func secret(for key: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return values[key]
    }

    public func setSecret(_ value: String?, for key: String) throws {
        lock.lock()
        defer { lock.unlock() }
        values[key] = value
    }
}

#if canImport(Security)
/// Tokens in the device's Keychain: readable once the device has been
/// unlocked, and never carried to another device by a backup or by iCloud.
public struct KeychainSecretStore: SecretStore {
    private let service: String

    public init(service: String) {
        self.service = service
    }

    private func query(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }

    public func secret(for key: String) -> String? {
        var search = query(key)
        search[kSecReturnData as String] = true
        search[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: CFTypeRef?
        guard SecItemCopyMatching(search as CFDictionary, &found) == errSecSuccess, let data = found as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func setSecret(_ value: String?, for key: String) throws {
        _ = SecItemDelete(query(key) as CFDictionary)
        guard let value else { return }
        var item = query(key)
        item[kSecValueData as String] = Data(value.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw DoklinError(.other, "This device's Keychain would not keep the login (error \(status)).")
        }
    }
}
#endif

/// Small files by key: what was last read, kept so it opens at once and
/// reads offline. Everything in one is a copy the domain can give again.
public struct DiskCache: Sendable {
    public let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    /// A file name for a key: no path of the workspace is spelled on disk.
    private func url(for key: String) -> URL {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in key.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01b3
        }
        return directory.appendingPathComponent(String(hash, radix: 16) + "-" + String(key.utf8.count, radix: 16))
    }

    public func load<T: Decodable>(_ type: T.Type, for key: String) -> T? {
        guard let data = try? Data(contentsOf: url(for: key)) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    public func store<T: Encodable>(_ value: T, for key: String) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? data.write(to: url(for: key), options: .atomic)
    }

    public func remove(_ key: String) {
        try? FileManager.default.removeItem(at: url(for: key))
    }

    public func removeAll() {
        try? FileManager.default.removeItem(at: directory)
    }
}

/// One workspace this device is logged in to. Never the token.
public struct Account: Codable, Hashable, Identifiable, Sendable {
    /// `https://notes.example.com` — also what the token is filed under.
    public let endpoint: String
    public var workspace: String
    /// The name this device goes by there: what its writes are signed with.
    public var agent: String
    public var scopes: [String]

    public var id: String { endpoint }
    public var domain: String { Endpoint.domain(of: endpoint) }

    /// A directory name for this workspace's files on the device.
    var folderName: String {
        String(domain.map { $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" ? $0 : "_" })
    }
}

/// `doklin login <address> <code>` — the line the Mac app hands over for a
/// new agent (`agent_login_line`, src-tauri/src/cloud/invite.rs).
public struct LoginLine: Equatable, Sendable {
    public let address: String
    public let code: String

    /// The line, wherever it is in what was pasted: on its own, or inside
    /// the whole prompt the Mac app copies.
    public static func find(in text: String) -> LoginLine? {
        let words = text.split(whereSeparator: { $0.isWhitespace }).map { word in
            String(word).trimmingCharacters(in: CharacterSet(charactersIn: "`'\"“”‘’"))
        }
        for (i, word) in words.enumerated() where word == "login" && i >= 1 && i + 2 < words.count && words[i - 1] == "doklin" {
            return LoginLine(address: words[i + 1], code: words[i + 2])
        }
        return nil
    }
}
