// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MinitrayBridge",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "MinitrayBridge", type: .static, targets: ["MinitrayBridge"]),
    ],
    dependencies: [
        .package(url: "https://github.com/Brendonovich/swift-rs", from: "1.0.7"),
    ],
    targets: [
        .target(
            name: "MinitrayBridge",
            dependencies: [
                .product(name: "SwiftRs", package: "swift-rs"),
            ]
        ),
    ]
)
