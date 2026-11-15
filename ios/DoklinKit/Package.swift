// swift-tools-version: 5.9
// Everything in the iOS app that is not a view: the engine (the Mac app's
// sync engine and version store, in Rust, behind `Engine`), the markdown
// reader, and the models the views watch. It imports nothing Apple-only, so
// `swift test` runs on a Mac or on Linux.
//
// The engine is a static library built by scripts/ios-engine.sh, and whoever
// links this package says where it is: Xcode through the app target's
// LIBRARY_SEARCH_PATHS, `swift test` with `-Xlinker -L<repo>/ios/Engine/host`.
import PackageDescription

let package = Package(
    name: "DoklinKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "DoklinKit", targets: ["DoklinKit"])],
    targets: [
        .systemLibrary(name: "CDoklinEngine"),
        .target(
            name: "DoklinKit",
            dependencies: ["CDoklinEngine"],
            linkerSettings: [
                .linkedLibrary("doklin_engine_ffi"),
                // What the engine's Rust asks of an Apple system: random bytes.
                .linkedFramework("Security", .when(platforms: [.iOS, .macOS])),
            ]
        ),
        .testTarget(name: "DoklinKitTests", dependencies: ["DoklinKit"]),
    ]
)
