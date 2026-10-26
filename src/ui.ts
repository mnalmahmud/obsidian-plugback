import type { Snapshot } from "./data.ts";
import {
	PluginSettingTab,
	Setting,
	type App,
	type ButtonComponent,
	type SettingDefinitionItem,
} from "obsidian";
import type { Core } from "./core.ts";

export function statusText(snapshot: Snapshot): {
	title: string;
	description: string;
} {
	switch (snapshot.phase) {
		case "checking":
			return { title: "Checking…", description: "" };
		case "waiting":
			return {
				title: "Waiting for changes to finish.",
				description: "",
			};
		case "stopped":
			return { title: "", description: "" };
		case "error": {
			let guidance = "";
			if (snapshot.error?.code === "invalid-data") {
				guidance = "Check your vault’s sync for errors, then check again.";
			}
			return {
				title: "Unable to sync.",
				description: [
					snapshot.error?.message ?? "Something went wrong. Try checking again.",
					guidance,
				]
					.filter(Boolean)
					.join(" "),
			};
		}
		case "idle":
			if (!snapshot.initialized || snapshot.lastChecked === null) {
				return { title: "", description: "" };
			}
			if (snapshot.issues.length) {
				return {
					title: "Sync finished with errors.",
					description: "",
				};
			}
			return { title: "Up to date.", description: "" };
	}
}
export function counts(wanted: readonly string[], installed: ReadonlyMap<string, string>): string {
	const missing = wanted.filter((id) => !installed.has(id)).length;
	return `${wanted.length - missing} installed${missing ? ` · ${missing} missing` : ""}`;
}

export class PlugbackSettingTab extends PluginSettingTab {
	private readonly cleanups = new Set<() => void>();
	private expanded = new Set<string>();
	private readonly core: Core | null;
	private readonly unavailable: string | null;
	constructor(
		app: App,
		plugin: import("obsidian").Plugin,
		core: Core | null,
		unavailable: string | null,
	) {
		super(app, plugin);
		this.core = core;
		this.unavailable = unavailable;
	}
	override getSettingDefinitions(): SettingDefinitionItem[] {
		if (!this.core)
			return [{ name: "Unable to sync.", desc: this.unavailable ?? "Plugback couldn’t start." }];
		const { sync, issues, inventories, add } = this.definitions();
		return [
			{ type: "group", cls: "plugback-settings", items: [sync, issues] },
			{ type: "group", cls: "plugback-settings", items: inventories },
			{ type: "group", cls: "plugback-settings", items: [add] },
		];
	}
	override display(): void {
		this.hide();
		this.containerEl.empty();
		if (!this.core) {
			new Setting(this.containerEl)
				.setName("Unable to sync.")
				.setDesc(this.unavailable ?? "Plugback couldn’t start.");
			return;
		}
		const root = this.containerEl.createDiv({ cls: "plugback-settings" });
		const { sync, issues, inventories, add } = this.definitions();
		for (const definition of [sync, issues, ...inventories, add]) {
			const setting = new Setting(root).setName(definition.name);
			if ("desc" in definition && typeof definition.desc === "string")
				setting.setDesc(definition.desc);
			definition.render(setting);
		}
	}
	override hide(): void {
		for (const cleanup of this.cleanups) cleanup();
	}
	private watch(render: (snapshot: Snapshot) => void): () => void {
		if (!this.core) return () => {};
		render(this.core.snapshot);
		const unsubscribe = this.core.subscribe(render);
		const cleanup = () => {
			unsubscribe();
			this.cleanups.delete(cleanup);
		};
		this.cleanups.add(cleanup);
		return cleanup;
	}
	private definitions() {
		const sync = {
			name: "Sync",
			aliases: ["Check now"],
			render: (setting: Setting) => {
				setting.settingEl.addClass("plugback-status");
				setting.descEl.setAttribute("role", "status");
				setting.descEl.setAttribute("aria-live", "polite");
				let button: ButtonComponent;
				setting.addButton((control) => {
					button = control
						.setButtonText("Check now")
						.setCta()
						.onClick(() => {
							void this.core?.check();
						});
				});
				return this.watch((snapshot) => {
					const text = statusText(snapshot);
					const lastChecked =
						snapshot.lastChecked === null
							? ""
							: `Last checked: ${new Date(snapshot.lastChecked).toLocaleString()}.`;
					setting.setDesc([text.title, text.description, lastChecked].filter(Boolean).join("\n"));
					button.setDisabled(snapshot.phase === "checking" || snapshot.phase === "stopped");
				});
			},
		};
		const issues = {
			name: "Couldn’t sync",
			searchable: false,
			render: (setting: Setting) => {
				setting.settingEl.addClass("plugback-issues");
				return this.watch((snapshot) => {
					setting.settingEl.hidden = snapshot.issues.length === 0;
					setting.descEl.empty();
					for (const issue of snapshot.issues) {
						const action = issue.action;
						const item = setting.descEl.createDiv({ cls: "plugback-issue" });
						item.createDiv({
							cls: "plugback-issue-title",
							text: `Couldn’t ${action.present ? "install" : "remove"} ${action.kind} ${action.id}.`,
						});
						item.createDiv({ text: issue.message });
					}
				});
			},
		};
		const inventories = (["plugins", "themes"] as const).map((kind) => ({
			name: kind === "plugins" ? "Plugins" : "Themes",
			render: (setting: Setting) => {
				setting.settingEl.empty();
				setting.settingEl.addClass("plugback-inventory-row");
				const details = setting.settingEl.createEl("details", { cls: "plugback-inventory" });
				details.open = this.expanded.has(kind);
				details.addEventListener("toggle", () => {
					if (details.open) this.expanded.add(kind);
					else this.expanded.delete(kind);
				});
				const summary = details.createEl("summary");
				const heading = summary.createSpan({ cls: "plugback-inventory-heading" });
				heading.createSpan({
					cls: "plugback-inventory-title",
					text: kind === "plugins" ? "Plugins" : "Themes",
				});
				const count = heading.createSpan({ cls: "plugback-inventory-count" });
				const list = details.createDiv({ cls: "plugback-inventory-list" });
				return this.watch((snapshot) => {
					const wanted = snapshot.data?.[kind] ?? [];
					const local = snapshot.installed?.[kind] ?? new Map<string, string>();
					const unavailable =
						kind === "plugins" ? "Plugin list unavailable." : "Theme list unavailable.";
					count.setText(
						!snapshot.installed ? "" : !snapshot.data ? unavailable : counts(wanted, local),
					);
					const scrollTop = list.scrollTop;
					list.empty();
					if (!snapshot.installed || !snapshot.data) {
						if (snapshot.installed)
							list.createEl("p", {
								cls: "plugback-empty",
								text: unavailable,
							});
						return;
					}
					const ids = [...wanted].sort((a, b) =>
						(local.get(a) ?? a).localeCompare(local.get(b) ?? b),
					);
					if (!ids.length)
						list.createEl("p", { cls: "plugback-empty", text: `No ${kind} to sync.` });
					for (const id of ids) {
						const row = list.createDiv({ cls: "plugback-extension" });
						const label = row.createDiv({ cls: "plugback-extension-label" });
						label.createSpan({ text: local.get(id) ?? id });
						if (local.get(id) && local.get(id) !== id) label.createEl("small", { text: id });
						row.createSpan({
							cls: "plugback-extension-state",
							text: local.has(id) ? "Installed" : "Missing",
						});
					}
					list.scrollTop = scrollTop;
				});
			},
		}));
		const add = {
			name: "Add from this device",
			desc: "Include installed plugins and themes in sync.",
			render: (setting: Setting) => {
				let button: ButtonComponent;
				setting.addButton((control) => {
					button = control.setButtonText("Add").onClick(() => {
						void this.core?.consolidate();
					});
				});
				return this.watch((snapshot) => {
					button.setDisabled(snapshot.phase === "checking" || snapshot.phase === "stopped");
				});
			},
		};
		return { sync, issues, inventories, add };
	}
}
