import type { Snapshot } from "./data.ts";
import { PluginSettingTab, Setting, type App, type ButtonComponent } from "obsidian";
import type { Core } from "./core.ts";

export function statusText(snapshot: Snapshot): {
	title: string;
	description: string;
} {
	switch (snapshot.phase) {
		case "checking": return { title: "Checking…", description: "" };
		case "waiting": return {
			title: "Waiting to retry",
			description: "The extension list is changing. Check again shortly."
		};
		case "stopped": return { title: "Stopped", description: "Plugback is no longer running." };
		case "error": {
			let guidance = "";
			if (snapshot.error?.code === "invalid-data") {
				guidance = "Fix data.json or resolve its sync conflict, then check again.";
			}
			return {
				title: "Unable to sync",
				description: [snapshot.error?.message ?? "Unknown error.", guidance].filter(Boolean).join(" ")
			};
		}
		case "idle":
			if (!snapshot.initialized || snapshot.lastChecked === null) {
				return { title: "Not checked", description: "" };
			}
			if (snapshot.issues.length) {
				return {
					title: "Check incomplete",
					description: `${snapshot.issues.length} ${snapshot.issues.length === 1 ? "change failed" : "changes failed"}.`
				};
			}
			return { title: "Up to date", description: "" };
	}
}
export function counts(wanted: readonly string[], installed: ReadonlyMap<string, string>): string {
	const missing = wanted.filter(id => !installed.has(id)).length;
	return `${wanted.length - missing} installed${missing ? ` · ${missing} missing` : ""}`;
}

export class PlugbackSettingTab extends PluginSettingTab {
	private unsubscribe: (() => void) | null = null;
	private expanded = new Set<string>();
	private readonly core: Core | null;
	private readonly unavailable: string | null;
	constructor(app: App, plugin: import("obsidian").Plugin, core: Core | null, unavailable: string | null) {
		super(app, plugin);
		this.core = core;
		this.unavailable = unavailable;
	}
	override display(): void {
		this.unsubscribe?.();
		if (!this.core) {
			this.containerEl.empty();
			new Setting(this.containerEl).setName("Unable to sync").setDesc(this.unavailable ?? "Plugback is not running.");
			return;
		}
		const render = this.buildView();
		render(this.core.snapshot);
		this.unsubscribe = this.core.subscribe(render);
	}
	override hide(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}
	private buildView(): (snapshot: Snapshot) => void {
		const el = this.containerEl;
		el.empty();
		const root = el.createDiv({ cls: "plugback-settings" });
		const statusPanel = root.createDiv({ cls: "plugback-status" });
		const status = new Setting(statusPanel).setName("Sync");
		status.descEl.setAttribute("role", "status");
		status.descEl.setAttribute("aria-live", "polite");
		const buttons: ButtonComponent[] = [];
		status.addButton(button => {
			button.setButtonText("Check now").setCta().onClick(() => { void this.core?.check(); });
			buttons.push(button);
		});
		const issues = root.createEl("section", { cls: "plugback-issues" });
		issues.setAttribute("aria-label", "Failed changes");
		const inventories = root.createDiv({ cls: "plugback-inventories" });
		const updateInventories = (["plugins", "themes"] as const).map(kind => {
			const details = inventories.createEl("details", { cls: "plugback-inventory" });
			details.open = this.expanded.has(kind);
			details.addEventListener("toggle", () => {
				if (details.open) this.expanded.add(kind);
				else this.expanded.delete(kind);
			});
			const summary = details.createEl("summary");
			summary.createSpan({ cls: "plugback-inventory-title", text: kind === "plugins" ? "Plugins" : "Themes" });
			const count = summary.createSpan({ cls: "plugback-inventory-count" });
			const list = details.createDiv({ cls: "plugback-inventory-list" });
			return (snapshot: Snapshot): void => {
				const wanted = snapshot.data?.[kind] ?? [];
				const local = snapshot.installed?.[kind] ?? new Map<string, string>();
				count.setText(!snapshot.installed ? "Not checked yet" : !snapshot.data ? "Sync data unavailable" : counts(wanted, local));
				list.empty();
				if (!snapshot.installed) {
					list.createEl("p", { cls: "plugback-empty", text: "Run a check to load the list." });
					return;
				}
				if (!snapshot.data) {
					list.createEl("p", { cls: "plugback-empty", text: "Sync data unavailable." });
					return;
				}
				const ids = [...wanted].sort((a, b) => (local.get(a) ?? a).localeCompare(local.get(b) ?? b));
				if (!ids.length) list.createEl("p", { cls: "plugback-empty", text: `No synced ${kind}.` });
				for (const id of ids) {
					const row = list.createDiv({ cls: "plugback-extension" });
					const label = row.createDiv({ cls: "plugback-extension-label" });
					label.createSpan({ text: local.get(id) ?? id });
					if (local.get(id) && local.get(id) !== id) label.createEl("small", { text: id });
					const state = local.has(id) ? "Installed" : "Missing";
					row.createSpan({ cls: "plugback-extension-state", text: state });
				}
			};
		});
		const consolidation = root.createDiv({ cls: "plugback-consolidation" });
		new Setting(consolidation).setName("Add local extensions")
			.setDesc("Include plugins and themes already installed on this device.")
			.addButton(button => {
				button.setButtonText("Add").onClick(() => { void this.core?.consolidate(); });
				buttons.push(button);
			});
		return snapshot => {
			const text = statusText(snapshot);
			const lastChecked = snapshot.lastChecked === null ? "" : `Last checked: ${new Date(snapshot.lastChecked).toLocaleString()}`;
			status.setDesc([text.title, text.description, lastChecked].filter(Boolean).join("\n"));
			const busy = snapshot.phase === "checking" || snapshot.phase === "stopped";
			for (const button of buttons) button.setDisabled(busy);
			issues.empty();
			issues.hidden = snapshot.issues.length === 0;
			if (snapshot.issues.length) new Setting(issues).setName("Failed changes").setHeading();
			for (const issue of snapshot.issues) {
				const action = issue.action;
				new Setting(issues).setName(`Could not ${action.present ? "install" : "remove"} ${action.kind} ${action.id}`).setDesc(issue.message);
			}
			for (const update of updateInventories) update(snapshot);
		};
	}
}
