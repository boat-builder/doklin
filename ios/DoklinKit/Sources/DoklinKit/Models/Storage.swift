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

    public var errorDescription: String? { message }
}

/// Where sign-ins are kept. The app uses the Keychain; tests use memory.
public protocol SecretStore: Sendable {
    func secret(for key: String) -> String?
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
            throw DoklinError("This iPhone's Keychain would not keep the sign-in (error \(status)).")
        }
    }
}
#endif
