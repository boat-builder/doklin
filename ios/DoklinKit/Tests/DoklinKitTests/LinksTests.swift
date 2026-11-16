// Which tapped links are links to a page — the ones the app follows itself
// rather than handing to a browser. What a link names is the engine's to
// read (engine/src/cloud/link.rs); these hold only its address and scheme.

import XCTest
@testable import DoklinKit

final class LinksTests: XCTestCase {
    private func url(_ text: String) throws -> URL {
        try XCTUnwrap(URL(string: text))
    }

    func testALinkToAPageIsTheAppsOwn() throws {
        let sent = "https://doklin.cc/open#d=notes.example.com&w=w-0a1b2c3d4e5f&f=f-9c8b7a6d5e4f"
        XCTAssertTrue(Workspaces.isPageLink(try url(sent)))
        XCTAssertTrue(Workspaces.isPageLink(try url(sent.replacingOccurrences(of: "/open#", with: "/open/#"))))
        XCTAssertTrue(Workspaces.isPageLink(try url(sent.replacingOccurrences(of: "https://doklin.cc", with: "http://DOKLIN.cc"))))
        XCTAssertTrue(Workspaces.isPageLink(try url("doklin://open#d=notes.example.com&w=w-0a1b2c3d4e5f&f=f-9c8b7a6d5e4f")))
    }

    func testEverythingElseGoesToTheBrowser() throws {
        for text in [
            "https://doklin.cc/",
            "https://doklin.cc/#agents",
            "https://doklin.cc/open",
            "https://doklin.cc/opener#d=x",
            "https://notes.example.com/open#d=x",
            "https://notes.example.com/roadmap",
            "mailto:team@example.com",
        ] {
            XCTAssertFalse(Workspaces.isPageLink(try url(text)), text)
        }
    }
}
