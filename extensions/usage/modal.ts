import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type SelectItem, SelectList, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { UsageStyles } from "./providers.ts";

export async function showUsageModal(
	ctx: ExtensionCommandContext,
	items: SelectItem[],
	renderContent: (styles: UsageStyles) => string,
): Promise<string> {
	return ctx.ui.custom<string>((tui, theme, _keybindings, done) => {
		const topBorder = new DynamicBorder((text: string) => theme.fg("accent", text));
		const bottomBorder = new DynamicBorder((text: string) => theme.fg("accent", text));
		const styledContent = renderContent({
			title: (text) => theme.fg("accent", theme.bold(text)),
			section: (text) => theme.fg("accent", theme.bold(text)),
			muted: (text) => theme.fg("dim", text),
			success: (text) => theme.fg("success", text),
			warning: (text) => theme.fg("warning", text),
			error: (text) => theme.fg("error", text),
		});
		const list = new SelectList(items, items.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		let scrollOffset = 0;
		let maxScroll = 0;
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done("close");
		return {
			render: (width: number) => {
				const innerWidth = Math.max(1, width - 2);
				const contentLines = styledContent.split("\n").flatMap((line) => line ? wrapTextWithAnsi(line, innerWidth) : [""]);
				const listLines = list.render(width);
				const borderLines = topBorder.render(width).length + bottomBorder.render(width).length;
				const maxHeight = Math.max(1, Math.floor(tui.terminal.rows * 0.85));
				const bodyHeight = Math.max(1, maxHeight - listLines.length - borderLines - 2);
				maxScroll = Math.max(0, contentLines.length - bodyHeight);
				scrollOffset = Math.min(scrollOffset, maxScroll);
				const body = contentLines.slice(scrollOffset, scrollOffset + bodyHeight).map((line) => ` ${line}`);
				const scroll = maxScroll > 0
					? theme.fg("dim", `Page Up/Down scroll · ${scrollOffset + 1}-${Math.min(contentLines.length, scrollOffset + bodyHeight)} of ${contentLines.length}`)
					: "";
				const help = theme.fg("dim", "↑↓ navigate · enter select · esc close");
				return [
					...topBorder.render(width),
					...body.map((line) => truncateToWidth(line, width)),
					truncateToWidth(` ${scroll}`, width),
					...listLines,
					truncateToWidth(` ${help}`, width),
					...bottomBorder.render(width),
				];
			},
			invalidate: () => {
				topBorder.invalidate();
				bottomBorder.invalidate();
				list.invalidate();
			},
			handleInput: (data: string) => {
				if (matchesKey(data, Key.pageUp)) scrollOffset = Math.max(0, scrollOffset - 5);
				else if (matchesKey(data, Key.pageDown)) scrollOffset = Math.min(maxScroll, scrollOffset + 5);
				else list.handleInput(data);
				tui.requestRender();
			},
		};
	}, {
		overlay: true,
		overlayOptions: { width: "75%", minWidth: 60, maxHeight: "85%", anchor: "center", margin: 1 },
	});
}
