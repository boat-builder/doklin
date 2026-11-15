// swift-tools-version: 5.9
// Everything in the iOS app that is not a view: the document API client, the
// markdown reader and the models the views watch. It has no dependency and
// imports nothing Apple-only, so `swift test` runs on a Mac or on Linux.
import PackageDescription

let package = Package(
    name: "DoklinKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "DoklinKit", targets: ["DoklinKit"])],
    targets: [
        .target(name: "DoklinKit"),
        .testTarget(name: "DoklinKitTests", dependencies: ["DoklinKit"]),
    ]
)
