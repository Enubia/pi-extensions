import AppKit
import Foundation

struct AttentionRecord: Decodable {
    let pid: Int32
    let state: String
    let token: String
    let label: String
    let question: String?
    let cwd: String
    let weztermPane: Int?
    let updatedAt: Double
}

struct AttentionItem: Identifiable {
    let url: URL
    let record: AttentionRecord

    var id: String { url.lastPathComponent }
    var needsInput: Bool { record.state == "input" }

    var menuTitle: String {
        let icon = needsInput ? "?" : "✓"
        guard let question = record.question else { return "\(icon)  \(record.label)" }
        return "\(icon)  \(record.label) — \(question)"
    }
}

final class AttentionStore: ObservableObject {
    @Published private(set) var items: [AttentionItem] = []

    let directory: URL
    private var source: DispatchSourceFileSystemObject?
    private var timer: Timer?

    init() {
        let override = ProcessInfo.processInfo.environment["PI_ATTENTION_DIR"]?.trimmingCharacters(in: .whitespaces)
        if let override, !override.isEmpty {
            directory = URL(fileURLWithPath: override, isDirectory: true)
        } else {
            directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".pi/agent/attention", isDirectory: true)
        }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        watch()
        reload()
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.reload() }
    }

    var inputCount: Int { items.filter(\.needsInput).count }
    var doneCount: Int { items.count - inputCount }

    var title: String {
        var parts = ["π"]
        if inputCount > 0 { parts.append("?\(inputCount)") }
        if doneCount > 0 { parts.append("✓\(doneCount)") }
        return parts.joined(separator: " ")
    }

    func focus(_ item: AttentionItem) {
        if let pane = item.record.weztermPane {
            try? String(pane).write(to: directory.appendingPathComponent("focus-request"), atomically: true, encoding: .utf8)
        }
        if !item.needsInput { remove(item) }
        activateWezTerm()
    }

    func clearDone() {
        items.filter { !$0.needsInput }.forEach(remove)
    }

    private func remove(_ item: AttentionItem) {
        try? FileManager.default.removeItem(at: item.url)
        reload()
    }

    private func activateWezTerm() {
        guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.github.wez.wezterm") else { return }
        NSWorkspace.shared.openApplication(at: app, configuration: NSWorkspace.OpenConfiguration())
    }

    private func watch() {
        let descriptor = open(directory.path, O_EVTONLY)
        guard descriptor >= 0 else { return }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: descriptor, eventMask: .write, queue: .main)
        source.setEventHandler { [weak self] in self?.reload() }
        source.setCancelHandler { close(descriptor) }
        source.resume()
        self.source = source
    }

    private func reload() {
        let urls = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        var next: [AttentionItem] = []
        for url in urls where url.pathExtension == "json" {
            guard let data = try? Data(contentsOf: url),
                  let record = try? JSONDecoder().decode(AttentionRecord.self, from: data) else { continue }
            if kill(record.pid, 0) != 0 && errno == ESRCH {
                try? FileManager.default.removeItem(at: url)
                continue
            }
            next.append(AttentionItem(url: url, record: record))
        }
        items = next.sorted { left, right in
            if left.needsInput != right.needsInput { return left.needsInput }
            return left.record.updatedAt > right.record.updatedAt
        }
    }
}
