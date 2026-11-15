// Every request the app makes: HTTPS to the workspace's own domain, the
// document API under `/api/agent/` (cloud-worker/src/agentApi.ts), with the
// token a login left in the Keychain as the bearer. Nothing else is contacted.
//
// The phone is to a workspace what the `doklin` command is (cli/src/http.rs):
// an agent of its person's, with no copy of the folder. A refusal from the
// worker is a sentence written to be acted on, so it is passed through word
// for word; what this file adds is what kind of refusal it was.

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Why a call did not do what was asked, in a sentence a person can act on.
public struct DoklinError: Error, LocalizedError, Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        /// The domain did not answer: offline, or the address is wrong.
        case unreachable
        /// This device's login no longer works — the agent was removed, or
        /// the device was logged out from a Mac.
        case loggedOut
        /// The agent may not do that: its person has not ticked the permission.
        case notPermitted
        /// There is nothing at that path.
        case notFound
        /// It changed after it was read, or something is in the way.
        case conflict
        /// The request as made cannot be done; the sentence says why.
        case refused
        /// The worker on the domain is older than this app needs.
        case workerTooOld
        /// The domain answered that it cannot say right now.
        case busy
        case other
    }

    public let kind: Kind
    public let message: String
    public let status: Int?
    /// The worker's own word for the refusal (`needs_rev`, `comments`, …).
    public let code: String?
    /// The revision a conflict says the thing is at now.
    public let rev: Int?

    public init(_ kind: Kind, _ message: String, status: Int? = nil, code: String? = nil, rev: Int? = nil) {
        self.kind = kind
        self.message = message
        self.status = status
        self.code = code
        self.rev = rev
    }

    public var errorDescription: String? { message }
}

/// What the worker sent back for a 2xx.
public struct Reply: Sendable {
    public let status: Int
    /// The `x-doklin-*` headers, by lowercased name, percent-decoded.
    public let headers: [String: String]
    public let contentType: String?
    public let data: Data

    public func decode<T: Decodable>(_ type: T.Type) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw DoklinError(.other, "The domain's answer was not what a Doklin worker sends.", status: status)
        }
    }
}

public enum RequestBody: Sendable {
    case json(Data)
    case bytes(Data)
}

/// A worker's address, as a login line names it.
public enum Endpoint {
    /// `notes.example.com`, `https://Notes.Example.com/` and the like, as the
    /// one spelling everything else uses: scheme and host, lowercased, no
    /// trailing slash. No scheme means https. Plain http is only for a worker
    /// on this machine — iOS refuses it anywhere else.
    public static func normalize(_ raw: String) throws -> String {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while text.hasSuffix("/") { text.removeLast() }
        var scheme = "https"
        if let range = text.range(of: "://") {
            scheme = text[..<range.lowerBound].lowercased()
            text = String(text[range.upperBound...])
        }
        let host = (text.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? "").lowercased()
        let wellFormed = !host.isEmpty && !host.contains(where: { $0.isWhitespace }) && (scheme == "https" || scheme == "http")
        guard wellFormed else {
            throw DoklinError(.refused, "\"\(raw.trimmingCharacters(in: .whitespacesAndNewlines))\" is not a workspace's address — it looks like notes.example.com.")
        }
        if scheme == "http" && !isLocal(host) {
            throw DoklinError(.refused, "A workspace's address starts with https:// — \(host) was given with http://.")
        }
        return "\(scheme)://\(host)"
    }

    /// The host of an endpoint, port included — what a person calls the workspace's address.
    public static func domain(of endpoint: String) -> String {
        let rest = endpoint.range(of: "://").map { String(endpoint[$0.upperBound...]) } ?? endpoint
        return rest.split(separator: "/", maxSplits: 1).first.map(String.init) ?? rest
    }

    private static func isLocal(_ host: String) -> Bool {
        let name = host.split(separator: ":").first.map(String.init) ?? host
        return name == "localhost" || name == "127.0.0.1" || name.hasSuffix(".local")
    }
}

public struct DoklinClient: Sendable {
    public let endpoint: String
    public let token: String?
    /// What `x-doklin-client` says: `ios/<version>`.
    public let clientName: String
    private let session: URLSession

    /// The largest answer worth holding: a file is capped at 25 MB by the worker.
    static let maxAnswerBytes = 32 * 1024 * 1024

    public init(endpoint: String, token: String?, clientName: String = "ios/dev", session: URLSession? = nil) {
        self.endpoint = endpoint
        self.token = token
        self.clientName = clientName
        self.session = session ?? DoklinClient.makeSession()
    }

    public var domain: String { Endpoint.domain(of: endpoint) }

    private static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 120
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.httpCookieStorage = nil
        config.urlCache = nil
        return URLSession(configuration: config)
    }

    /// One request to `/api/agent/<route>`. A 2xx is the reply; anything else
    /// is thrown as a `DoklinError` carrying the worker's own sentence.
    public func send(
        _ method: String,
        _ route: String,
        query: [(String, String)] = [],
        headers: [(String, String)] = [],
        body: RequestBody? = nil
    ) async throws -> Reply {
        var text = "\(endpoint)/api/agent/\(route)"
        for (i, pair) in query.enumerated() {
            text += i == 0 ? "?" : "&"
            text += "\(pair.0)=\(DoklinClient.encode(pair.1))"
        }
        guard let url = URL(string: text) else {
            throw DoklinError(.refused, "\"\(domain)\" is not a workspace's address — it looks like notes.example.com.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(clientName, forHTTPHeaderField: "x-doklin-client")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        }
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
        }
        switch body {
        case .json(let data):
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = data
        case .bytes(let data):
            request.setValue("application/octet-stream", forHTTPHeaderField: "content-type")
            request.httpBody = data
        case nil:
            break
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw unreachable(error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw DoklinError(.other, "\(domain) did not answer the way a web server does.")
        }
        if data.count > DoklinClient.maxAnswerBytes {
            throw DoklinError(.other, "The answer from \(domain) was larger than a document can be.", status: http.statusCode)
        }
        var doklin: [String: String] = [:]
        for (name, value) in http.allHeaderFields {
            guard let name = (name as? String)?.lowercased(), name.hasPrefix("x-doklin-"), let value = value as? String else { continue }
            doklin[name] = DoklinClient.decode(value)
        }
        let reply = Reply(
            status: http.statusCode,
            headers: doklin,
            contentType: http.value(forHTTPHeaderField: "content-type"),
            data: data
        )
        guard (200..<300).contains(http.statusCode) else { throw refusal(reply) }
        return reply
    }

    private func unreachable(_ error: Error) -> DoklinError {
        if let url = error as? URLError {
            switch url.code {
            case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed, .internationalRoamingOff:
                return DoklinError(.unreachable, "You are offline — \(domain) cannot be reached right now.")
            case .timedOut:
                return DoklinError(.unreachable, "\(domain) took too long to answer. Try again in a moment.")
            case .cannotFindHost, .dnsLookupFailed:
                return DoklinError(.unreachable, "There is no server at \(domain) — check the address.")
            default:
                break
            }
        }
        return DoklinError(.unreachable, "Could not reach \(domain): \(error.localizedDescription)")
    }

    private struct Said: Decodable {
        let error: String?
        let code: String?
        let rev: Int?
    }

    /// What a non-2xx answer means, in a kind and the worker's words.
    private func refusal(_ reply: Reply) -> DoklinError {
        let detail = try? JSONDecoder().decode(Said.self, from: reply.data)
        let said = detail?.error ?? ""
        let tooOld = "The worker on \(domain) is too old for this — the workspace's owner can update it from Doklin's Cloud panel on a Mac."
        let kind: DoklinError.Kind
        var message = said
        switch reply.status {
        case 401 where said == "unauthorized" && token != nil:
            // The gate's own bare word: the token is not one the domain knows.
            kind = .loggedOut
            message = "This device's login to \(domain) no longer works — it was removed, or logged out from a Mac. Add it again from Doklin on your Mac, under Cloud → Agents."
        case 401 where said == "unauthorized":
            // No bearer was sent, so the gate can only mean the login route
            // above it is not there: a worker from before agents.
            kind = .workerTooOld
            message = tooOld
        case 401:
            kind = .refused
        case 403:
            kind = .notPermitted
        case 404 where said == "not found" || said.isEmpty:
            // A route the worker has never heard of, as opposed to a document it cannot find.
            kind = .workerTooOld
            message = tooOld
        case 405:
            kind = .workerTooOld
            message = tooOld
        case 404:
            kind = .notFound
        case 409, 412, 428:
            kind = .conflict
        case 400, 413:
            kind = .refused
        case 503:
            kind = .busy
        default:
            kind = .other
        }
        if message.isEmpty { message = "\(domain) answered \(reply.status)." }
        return DoklinError(kind, DoklinClient.sentence(message), status: reply.status, code: detail?.code, rev: detail?.rev)
    }

    /// A worker's refusal as a sentence: capital first, full stop last.
    static func sentence(_ text: String) -> String {
        var out = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = out.first else { return out }
        if first.isLowercase { out = first.uppercased() + out.dropFirst() }
        if let last = out.last, !".!?…`".contains(last) { out += "." }
        return out
    }

    /// Percent-encode a query value: everything but the unreserved characters.
    public static func encode(_ text: String) -> String {
        var out = ""
        for byte in text.utf8 {
            switch byte {
            case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"),
                 UInt8(ascii: "0")...UInt8(ascii: "9"), UInt8(ascii: "-"), UInt8(ascii: "_"),
                 UInt8(ascii: "."), UInt8(ascii: "~"):
                out.unicodeScalars.append(Unicode.Scalar(byte))
            default:
                out += "%" + (byte < 16 ? "0" : "") + String(byte, radix: 16, uppercase: true)
            }
        }
        return out
    }

    /// Undo percent-encoding — how the worker sends a path in a header.
    public static func decode(_ text: String) -> String {
        text.removingPercentEncoding ?? text
    }
}
