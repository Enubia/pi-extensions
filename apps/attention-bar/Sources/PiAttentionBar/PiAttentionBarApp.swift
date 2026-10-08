import AppKit
import SwiftUI

@main
struct PiAttentionBarApp: App {
    @StateObject private var store = AttentionStore()

    init() {
        NSApplication.shared.setActivationPolicy(.accessory)
    }

    var body: some Scene {
        MenuBarExtra {
            AttentionMenu(store: store)
        } label: {
            Text(store.title)
        }
    }
}

struct AttentionMenu: View {
    @ObservedObject var store: AttentionStore

    var body: some View {
        if store.items.isEmpty {
            Text("No sessions need attention")
        }
        ForEach(store.items) { item in
            Button(item.menuTitle) { store.focus(item) }
        }
        Divider()
        Button("Clear done") { store.clearDone() }
            .disabled(store.doneCount == 0)
        Button("Quit") { NSApplication.shared.terminate(nil) }
            .keyboardShortcut("q")
    }
}
