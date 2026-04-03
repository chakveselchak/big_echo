// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SystemAudioBridge",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "SystemAudioBridge", type: .static, targets: ["SystemAudioBridge"]),
    ],
    dependencies: [
        .package(url: "https://github.com/Brendonovich/swift-rs", from: "1.0.7"),
    ],
    targets: [
        .target(
            name: "SystemAudioBridge",
            dependencies: [
                .product(name: "SwiftRs", package: "swift-rs"),
            ]
        ),
    ]
)
