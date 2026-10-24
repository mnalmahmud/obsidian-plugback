import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { Files, deferred } from "./helpers.ts";
import type { Snapshot } from "../src/data.ts";
import { PLUGINS_REGISTRY_URL, THEMES_REGISTRY_URL } from "../src/registry.ts";

interface Runtime {
	onload(): void;
	onunload(): void;
	check(): Promise<void>;
	onExternalSettingsChange(): void;
	core: {
		snapshot: Snapshot;
		subscribe(listener: (snapshot: Snapshot) => void): () => void;
		consolidate(): Promise<void>;
	};
}
function pluginFixture(installed = true) {
	const files = new Files();
	const calls: string[] = [];
	let cancellations = 0;
	let ready = () => {
	};
	const local = new Map<string, unknown>();
	files.content.set(".custom/plugins/plugback/data.json", JSON.stringify({
		schemaVersion: 1, plugins: ["one"], themes: []
	}));
	files.content.set(".custom/plugins/plugback-seed/manifest.json", readFileSync("seed/manifest.json", "utf8"));
	files.content.set(".custom/plugins/plugback-seed/main.js", readFileSync("seed/main.js", "utf8"));
	files.content.set(".custom/community-plugins.json", '["plugback", "plugback-seed", "one"]');
	files.content.set(".custom/plugins/one/data.json", '{"user":"settings"}');
	if (installed) {
		files.put("plugin", "one", ".custom");
	}
	const loaded: Record<string, unknown> = { "plugback-seed": {} };
	const manager = {
		plugins: loaded,
		manifests: {},
		installPlugin: async (_repo: string, _version: string, manifest: {
			id: string;
		}) => {
			calls.push(`install:${manifest.id}`);
			files.put("plugin", manifest.id, ".custom");
		},
		uninstallPlugin: async (id: string) => {
			calls.push(`remove:${id}`);
			files.content.delete(`.custom/plugins/${id}/main.js`);
		},
		enablePlugin: async (id: string) => {
			calls.push(`enable:${id}`);
			loaded[id] = {};
		},
		enablePluginAndSave: async () => {
		},
		loadManifests: async () => {
		},
	};
	const app = {
		vault: { configDir: ".custom", adapter: files },
		plugins: manager,
		customCss: {
			installTheme: async () => {
			}, removeTheme: async () => {
			}
		},
		workspace: {
			onLayoutReady(callback: () => void) {
				ready = callback;
			}
		},
		loadLocalStorage: (key: string) => local.get(key),
		saveLocalStorage: (key: string, value: unknown) => {
			local.set(key, value);
		}
	};
	class Plugin {
		app: unknown;
		manifest: unknown;
		constructor(a: unknown, m: unknown) {
			this.app = a;
			this.manifest = m;
		}
		registerDomEvent(): void {
		}
		addSettingTab(): void {}
	}
	const manifest = {
		id: "one", name: "One", version: "1.0.0", minAppVersion: "1.0.0"
	};
	const network = new Map<string, unknown>([
		[PLUGINS_REGISTRY_URL, [{ id: "one", repo: "owner/one" }]], [THEMES_REGISTRY_URL, [{ name: "Minimal", repo: "owner/theme" }]],
		["https://raw.githubusercontent.com/owner/one/HEAD/manifest.json", manifest], ["https://github.com/owner/one/releases/download/1.0.0/manifest.json", manifest],
	]);
	const mod: {
		exports: unknown;
	} = { exports: {} };
	runInNewContext(readFileSync("main.js", "utf8"), {
		module: mod,
		exports: mod.exports,
		window: {},
		document: { visibilityState: "visible" },
		console: {
			error: () => {
			}, warn: () => {
			}
		},
		require: () => ({
			Plugin,
			PluginSettingTab: class {
			},
			Notice: class {
			},
			Platform: { isMobile: false },
			normalizePath: (path: string) => path,
			requireApiVersion: () => true,
			requestUrl: ({ url }: {
				url: string;
			}) => Promise.resolve({ status: network.has(url) ? 200 : 404, json: network.get(url) }),
			debounce: (fn: () => void) => Object.assign(fn, {
				cancel: () => {
					cancellations++;
				}
			}),
		}),
	});
	const Constructor = (mod.exports as {
		default: new (app: unknown, manifest: unknown) => Runtime;
	}).default;
	const plugin = new Constructor(app, {
		id: "plugback", name: "Plugback", dir: ".custom/plugins/plugback"
	});
	return {
		plugin,
		files,
		calls,
		ready: () => ready(),
		manager,
		get cancellations() {
			return cancellations;
		}
	};
}
void test("production bundle starts, installs missing bytes, preserves settings, and restores activation", async () => {
	const f = pluginFixture(false);
	const originalInstall = f.manager.installPlugin;
	f.plugin.onload();
	assert.notEqual(f.manager.installPlugin, originalInstall);
	f.ready();
	await f.plugin.check();
	assert.equal(f.plugin.core.snapshot.phase, "idle");
	const seedCode = f.files.content.get(".custom/plugins/plugback-seed/main.js")!;
	assert.ok(seedCode.length < readFileSync("seed/main.js", "utf8").length);
	assert.equal(seedCode.trim().split("\n").length, 1);
	assert.ok(f.calls.includes("install:one"));
	assert.ok(f.calls.includes("enable:one"));
	assert.equal(f.files.content.get(".custom/plugins/one/data.json"), '{"user":"settings"}');
	const originalData = f.files.content.get(".custom/plugins/plugback/data.json");
	await f.plugin.check();
	assert.equal(f.files.content.get(".custom/plugins/plugback/data.json"), originalData);
	f.plugin.onunload();
	assert.equal(f.plugin.core.snapshot.phase, "stopped");
	assert.equal(f.manager.installPlugin, originalInstall);
	assert.equal(f.cancellations, 1);
});
void test("unloading before layout readiness prevents late startup and extension mutation", async () => {
	const f = pluginFixture(false);
	f.plugin.onload();
	f.plugin.onunload();
	f.ready();
	await f.plugin.check();
	assert.equal(f.calls.length, 0);
});

void test("native removal is observed and automatically reconciled by the assembled core", async () => {
	const f = pluginFixture(true);
	f.plugin.onload();
	f.ready();
	await f.plugin.check();
	const completed = deferred<void>();
	const off = f.plugin.core.subscribe(snapshot => {
		if (snapshot.phase === "idle" && snapshot.data?.plugins.length === 0) {
			completed.resolve();
		}
	});
	await f.manager.uninstallPlugin("one");
	await completed.promise;
	off();
	assert.deepEqual((JSON.parse(f.files.content.get(".custom/plugins/plugback/data.json")!) as { plugins: string[] }).plugins, []);
	f.plugin.onunload();
});

void test("production bundle repairs empty plugin code without replacing its settings", async () => {
	const f = pluginFixture();
	f.files.content.set(".custom/plugins/one/main.js", "");
	f.plugin.onload();
	f.ready();
	await f.plugin.check();
	assert.ok(f.calls.includes("install:one"));
	assert.ok(f.calls.includes("enable:one"));
	assert.ok(f.files.content.get(".custom/plugins/one/main.js"));
	assert.equal(f.files.content.get(".custom/plugins/one/data.json"), '{"user":"settings"}');
	f.plugin.onunload();
});
