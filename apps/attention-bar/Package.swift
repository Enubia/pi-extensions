// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "PiAttentionBar",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "PiAttentionBar", path: "Sources/PiAttentionBar"),
    ]
)
