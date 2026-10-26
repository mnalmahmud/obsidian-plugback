import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { build } from "esbuild";
import type { Snapshot } from "../src/data.ts";
import { fixture } from "./helpers.ts";

// Only the DOM and settings methods used by the view.
class Element {
	children: Element[] = [];
	controls: Button[] = [];
	get buttons(): Button[] {
		return [...this.controls, ...this.children.flatMap((child) => child.buttons)];
	}
	text = "";
	open = false;
	scrollTop = 0;
	hidden = false;
	cls = "";
	addClass(cls: string): void {
		this.cls = [...new Set([...this.cls.split(" "), cls])].filter(Boolean).join(" ");
	}
	setText(text: string): void {
		this.text = text;
	}
	setAttribute(_name: string, _value: string): void {}
	find(cls: string): Element | undefined {
		return this.cls.split(" ").includes(cls)
			? this
			: this.children.map((child) => child.find(cls)).find(Boolean);
	}
	get content(): string {
		return [this.text, ...this.children.map((child) => child.content)].join(" ");
	}
	empty(): void {
		this.children = [];
		this.scrollTop = 0;
		this.controls.length = 0;
	}
	private append(options?: { text?: string; cls?: string }): Element {
		const el = new Element();
		el.text = options?.text ?? "";
		el.cls = options?.cls ?? "";
		this.children.push(el);
		return el;
	}
	createEl(_tag: string, options?: { text?: string; cls?: string }): Element {
		return this.append(options);
	}
	createDiv(options?: { text?: string; cls?: string }): Element {
		return this.append(options);
	}
	createSpan(options?: { text?: string; cls?: string }): Element {
		return this.append(options);
	}
	addEventListener(): void {}
}
interface Button {
	text: string;
	disabled: boolean;
	click: () => void;
}
class Setting {
	settingEl: Element;
	private readonly controls: Button[];
	nameEl: Element;
	descEl: Element;
	constructor(el: Element) {
		this.settingEl = el.createDiv({ cls: "setting-item" });
		this.controls = this.settingEl.controls;
		this.nameEl = this.settingEl.createDiv({ cls: "setting-item-name" });
		this.descEl = this.settingEl.createDiv({ cls: "setting-item-description" });
	}
	setHeading(): this {
		return this;
	}
	setName(text: string): this {
		this.nameEl.setText(text);
		return this;
	}
	setDesc(text: string): this {
		this.descEl.setText(text);
		return this;
	}
	addButton(callback: (button: object) => void): this {
		const state: Button = { text: "", disabled: false, click: () => {} };
		this.controls.push(state);
		const button = {
			setButtonText(text: string) {
				state.text = text;
				return button;
			},
			setCta() {
				return button;
			},
			setDisabled(value: boolean) {
				state.disabled = value;
				return button;
			},
			onClick(fn: () => void) {
				state.click = fn;
				return button;
			},
		};
		callback(button);
		return this;
	}
}
class Tab {
	containerEl = new Element();
}
const output = await build({
	entryPoints: ["src/ui.ts"],
	bundle: true,
	write: false,
	format: "cjs",
	platform: "node",
	external: ["obsidian"],
});
const mod: { exports: unknown } = { exports: {} };
runInNewContext(output.outputFiles[0]!.text, {
	module: mod,
	exports: mod.exports,
	require: () => ({ PluginSettingTab: Tab, Setting }),
});
const ui = mod.exports as {
	statusText(snapshot: Snapshot): { title: string; description: string };
	counts(wanted: readonly string[], installed: ReadonlyMap<string, string>): string;
	PlugbackSettingTab: new (
		app: unknown,
		plugin: unknown,
		core: unknown,
		unavailable: null,
	) => {
		containerEl: Element;
		display(): void;
		hide(): void;
		getSettingDefinitions(): Array<{
			type: "group";
			cls: string;
			items: Array<{
				name: string;
				desc?: string;
				aliases?: string[];
				render(setting: Setting): () => void;
			}>;
		}>;
	};
};
function settingsFixture(snapshot: Snapshot) {
	const listeners = new Set<(snapshot: Snapshot) => void>();
	const tab = new ui.PlugbackSettingTab(
		{},
		{},
		{
			snapshot,
			subscribe(listener: (snapshot: Snapshot) => void) {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		},
		null,
	);
	return {
		tab,
		render: (next: Snapshot) => {
			for (const listener of listeners) listener(next);
		},
	};
}

function click(tab: { containerEl: Element }, text: string): void {
	const button = tab.containerEl.buttons.findLast((button) => button.text === text);
	assert.ok(button, `Missing ${text}`);
	assert.equal(button.disabled, false);
	button.click();
}
void test("settings subscribe only while visible and read snapshots without inspection", () => {
	const f = fixture();
	const core = f.core();
	let subscribed = 0;
	let unsubscribed = 0;
	const proxy = {
		get snapshot() {
			return core.snapshot;
		},
		subscribe: (_listener: (snapshot: Snapshot) => void) => {
			subscribed++;
			return () => {
				unsubscribed++;
			};
		},
	};
	const tab = new ui.PlugbackSettingTab({}, {}, proxy, null);
	tab.display();
	tab.hide();
	assert.ok(subscribed > 0);
	assert.equal(unsubscribed, subscribed);
	assert.equal(f.scans, 0);
});
void test("settings provide Check now and a single additive consolidation action", async () => {
	const f = fixture();
	const core = f.core();
	const tab = new ui.PlugbackSettingTab({}, {}, core, null);
	tab.display();
	assert.deepEqual(
		tab.containerEl.buttons.map((button) => button.text),
		["Check now", "Add"],
	);
	f.plugins.set("p2", "Two");
	click(tab, "Add");
	await core.check();
	assert.deepEqual(f.data?.plugins, ["p1", "p2"]);
	tab.hide();
});
void test("actions are disabled during a running check", () => {
	const f = fixture();
	const snapshot = f.core().snapshot;
	snapshot.phase = "checking";
	const tab = new ui.PlugbackSettingTab({}, {}, { snapshot, subscribe: () => () => {} }, null);
	tab.display();
	assert.equal(tab.containerEl.buttons.length, 2);
	assert.equal(
		tab.containerEl.buttons.every((button) => button.disabled),
		true,
	);
	tab.hide();
});

void test("status is derived from typed state and preserves actionable storage guidance", async () => {
	const f = fixture();
	const core = f.core();
	assert.equal(ui.statusText(core.snapshot).title, "Not checked.");
	await core.check();
	assert.equal(ui.statusText(core.snapshot).title, "Up to date.");
	const snapshot = core.snapshot;
	snapshot.phase = "error";
	snapshot.error = { code: "missing-data", message: "data.json is missing. Restore it from sync." };
	assert.equal(ui.statusText(snapshot).description, snapshot.error.message);
	snapshot.error = { code: "invalid-data", message: "Invalid" };
	assert.match(ui.statusText(snapshot).description, /conflict/);
});
void test("counts include only synced extensions and show missing only when needed", () => {
	assert.equal(
		ui.counts(
			["a", "b"],
			new Map([
				["a", "A"],
				["custom", "Custom"],
			]),
		),
		"1 installed · 1 missing",
	);
	assert.equal(
		ui.counts(
			["a"],
			new Map([
				["a", "A"],
				["custom", "Custom"],
			]),
		),
		"1 installed",
	);
	assert.equal(ui.counts([], new Map()), "0 installed");
});

void test("snapshot updates retain controls and open inventories while showing failures before inventory", async () => {
	const f = fixture();
	const core = f.core();
	await core.check();
	const snapshot = core.snapshot;
	const ids = Array.from({ length: 30 }, (_, i) => `p${i + 1}`);
	snapshot.data!.plugins = ids;
	snapshot.installed!.plugins = new Map(ids.map((id) => [id, id]));
	const { tab, render } = settingsFixture(snapshot);
	tab.display();
	const root = tab.containerEl.find("plugback-settings")!;
	const inventory = root.find("plugback-inventory")!;
	inventory.open = true;
	const list = inventory.find("plugback-inventory-list")!;
	list.scrollTop = 120;
	const check = tab.containerEl.buttons[0];
	snapshot.phase = "checking";
	render(snapshot);
	assert.equal(tab.containerEl.buttons.length, 2);
	assert.equal(tab.containerEl.buttons[0], check);
	assert.equal(check!.disabled, true);
	assert.equal(root.find("plugback-inventory"), inventory);
	assert.equal(inventory.open, true);
	assert.equal(list.scrollTop, 120);
	snapshot.phase = "idle";
	snapshot.issues = [
		{
			code: "operation",
			action: { kind: "plugin", id: "p2", present: true },
			message: "Download failed",
		},
	];
	render(snapshot);
	assert.equal(check!.disabled, false);
	const issues = root.find("plugback-issues")!;
	assert.equal(issues.hidden, false);
	assert.match(issues.content, /Could not install plugin p2.*Download failed/);
	assert.ok(
		root.children.indexOf(issues) < root.children.indexOf(root.find("plugback-inventory-row")!),
	);
	assert.match(root.find("plugback-status")!.content, /Check incomplete/);
	snapshot.issues = [];
	render(snapshot);
	assert.equal(issues.hidden, true);
	tab.hide();
});

void test("inventories show only synced plugins and themes, including missing entries", async () => {
	const f = fixture();
	const core = f.core();
	const { tab, render } = settingsFixture(core.snapshot);
	tab.display();
	assert.match(tab.containerEl.content, /Not checked yet/);
	assert.doesNotMatch(tab.containerEl.content, /0 installed/);
	await core.check();
	const snapshot = core.snapshot;
	snapshot.data = {
		schemaVersion: 1,
		plugins: ["p1", "missing"],
		themes: ["Synced Theme", "Missing Theme"],
	};
	snapshot.installed = {
		plugins: new Map([
			["p1", "One"],
			["p2", "Two"],
			["custom", "Custom"],
		]),
		themes: new Map([
			["Synced Theme", "Synced Theme"],
			["Local Theme", "Local Theme"],
			["Custom Theme", "Custom Theme"],
		]),
		managedPlugins: new Set(["p1", "p2"]),
		managedThemes: new Set(["Synced Theme", "Local Theme"]),
	};
	render(snapshot);
	assert.match(tab.containerEl.content, /1 installed · 1 missing/);
	assert.match(tab.containerEl.content, /One p1 Installed/);
	assert.match(tab.containerEl.content, /Synced Theme Installed/);
	assert.match(tab.containerEl.content, /Missing Theme Missing/);
	assert.doesNotMatch(tab.containerEl.content, /Custom|Two|Local Theme/);
	assert.match(tab.containerEl.content, /missing Missing/);
	snapshot.data = { schemaVersion: 1, plugins: [], themes: [] };
	render(snapshot);
	assert.match(tab.containerEl.content, /No synced plugins/);
	assert.match(tab.containerEl.content, /No synced themes/);
	assert.doesNotMatch(tab.containerEl.content, /One|Synced Theme|Custom|Two|Local Theme/);
	snapshot.data = null;
	render(snapshot);
	assert.match(tab.containerEl.content, /Sync data unavailable/);
	assert.doesNotMatch(tab.containerEl.content, /One|Synced Theme|Custom|Two|Local Theme/);
	tab.hide();
});

void test("declarative settings render independent searchable rows without nested settings", async () => {
	const f = fixture();
	const core = f.core();
	const tab = new ui.PlugbackSettingTab({}, {}, core, null);
	const groups = tab.getSettingDefinitions();
	assert.equal(groups.length, 3);
	assert.deepEqual(Array.from(groups.flatMap((group) => group.items.map((item) => item.name))), [
		"Sync",
		"Failed changes",
		"Plugins",
		"Themes",
		"Add local extensions",
	]);
	assert.deepEqual(Array.from(groups[0]!.items[0]!.aliases!), ["Check now"]);
	assert.equal(f.scans, 0);
	const root = new Element();
	const rows = groups.flatMap((group) => {
		const container = root.createDiv({ cls: group.cls });
		return group.items.map((definition) => {
			const setting = new Setting(container)
				.setName(definition.name)
				.setDesc(definition.desc ?? "");
			const cleanup = definition.render(setting);
			return { name: definition.name, setting, cleanup };
		});
	});
	assert.deepEqual(
		root.buttons.map((button) => button.text),
		["Check now", "Add"],
	);
	for (const { setting } of rows) {
		assert.equal(
			setting.settingEl.children.some((child) => child.find("setting-item")),
			false,
		);
	}
	await core.check();
	assert.match(root.content, /Up to date/);
	const plugins = rows.find((row) => row.name === "Plugins")!;
	const before = plugins.setting.settingEl.content;
	plugins.cleanup();
	core.stop();
	assert.equal(plugins.setting.settingEl.content, before);
	assert.match(rows[0]!.setting.settingEl.content, /Stopped/);
	for (const row of rows) row.cleanup();
	tab.hide();
});
