// swift-tools-version: 5.10
// doklin-stt — Doklin's dictation sidecar. One small executable owning the
// microphone (AVAudioEngine), on-device speech-to-text (WhisperKit → CoreML /
// Neural Engine), and the optional LLM "polish" pass (MLX → Metal). Speaks
// NDJSON over stdin/stdout to the Tauri Rust host; see Protocol notes in
// main.swift. Built by scripts/build-stt.sh into src-tauri/binaries/.
import PackageDescription

let package = Package(
    name: "doklin-stt",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/argmaxinc/WhisperKit.git", from: "1.0.0"),
        // mlx-swift-lm (successor of mlx-swift-examples for the LLM libraries).
        // 2.31.x, not 3.x: same ChatSession-era API, but pins swift-transformers
        // 1.2.x — 1.0.0's Hub downloader segfaults resuming URLSession tasks.
        .package(url: "https://github.com/ml-explore/mlx-swift-lm.git", from: "2.31.3"),
        // Already in the graph transitively; declared so we can `import Hub`
        // (HubApi routes MLX model downloads into the app data dir).
        .package(url: "https://github.com/huggingface/swift-transformers", from: "1.2.0"),
        // Also transitive (via mlx-swift-lm); declared so we can `import MLX`
        // for GPU.clearCache() when idle-unloading the polish model.
        .package(url: "https://github.com/ml-explore/mlx-swift", from: "0.31.4"),
    ],
    targets: [
        .executableTarget(
            name: "doklin-stt",
            dependencies: [
                .product(name: "WhisperKit", package: "WhisperKit"),
                .product(name: "MLXLLM", package: "mlx-swift-lm"),
                .product(name: "MLXLMCommon", package: "mlx-swift-lm"),
                .product(name: "Transformers", package: "swift-transformers"),
                .product(name: "MLX", package: "mlx-swift"),
            ],
            path: "Sources/doklin-stt"
        )
    ]
)
