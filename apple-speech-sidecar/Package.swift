// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "AppleSpeech",
    platforms: [.macOS(.v26)],
    targets: [
        .executableTarget(
            name: "AppleSpeech",
            path: "Sources/AppleSpeech"
        )
    ]
)
