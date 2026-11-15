// Where this device's sign-ins are kept: the Keychain, by workspace id, and
// nowhere else — never in the engine's cloud.json, never in a log. The
// engine asks for one through `Engine` whenever it reads cloud.json.

import Foundation
#if canImport(Security)
import Security
#endif

/// A sentence for a person: what went wrong, said the way it is shown.
public struct DoklinError: Error, LocalizedError, Equatable, Sendable {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    /// The engine's words as a sentence: it answers a refusal as a phrase —
    /// `that code doesn't work` — which the Mac's screens set in a sentence
    /// of their own. Here it is made one where it comes in.
    public static func sentence(_ words: String) -> String {
        let trimmed = words.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = trimmed.first else { return "" }
        let capital = first.uppercased() + trimmed.dropFirst()
        return ".?!".contains(capital.last ?? ".") ? capital : capital + "."
    }

    public var errorDescription: String? { message }
}

/// Where sign-ins are kept. The app uses the Keychain; tests use memory.
public protocol SecretStore: Sendable {
    /// What is kept under `key`, nil when nothing is — and an error when the
    /// store could not be read just now, which is never "nothing".
    func secret(for key: String) throws -> String?
    /// Keep `value`, or remove what is kept when it is nil.
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

    /// Every key kept, for a test to look at.
    public var keys: [String] {
        lock.lock()
        defer { lock.unlock() }
        return Array(values.keys)
    }
}

#if canImport(Security)
/// Sign-ins in this device's Keychain: readable once the phone has been
/// unlocked since it started — so sync can run while it is locked — and
/// never carried to another device by a backup or by iCloud. A phone
/// restored from a backup has none, and joins again as a new device.
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

    public func secret(for key: String) throws -> String? {
        var search = query(key)
        search[kSecReturnData as String] = true
        search[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: CFTypeRef?
        let status = SecItemCopyMatching(search as CFDictionary, &found)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = found as? Data else {
            throw DoklinError("This iPhone's Keychain could not be read (error \(status)).")
        }
        return String(data: data, encoding: .utf8)
    }

    /// Replace what is kept in place, so a failure leaves the old one there.
    public func setSecret(_ value: String?, for key: String) throws {
        guard let value else {
            let status = SecItemDelete(query(key) as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else {
                throw DoklinError("This iPhone's Keychain would not let go of the sign-in (error \(status)).")
            }
            return
        }
        var status = SecItemUpdate(query(key) as CFDictionary, [kSecValueData as String: Data(value.utf8)] as CFDictionary)
        if status == errSecItemNotFound {
            var item = query(key)
            item[kSecValueData as String] = Data(value.utf8)
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            throw DoklinError("This iPhone's Keychain would not keep the sign-in (error \(status)).")
        }
    }
}
#endif
