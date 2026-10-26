import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "obsidian";
import type { LifecycleObserver, RawPluginManager } from "../src/host.ts";
import { registerHooks } from "node:module";
import { Registry, PLUGINS_REGISTRY_URL, THEMES_REGISTRY_URL } from "../src/registry.ts";
import { Files, deferred } from "./helpers.ts";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";

// Manager behavior runs without Obsidian; actual host wiring is exercised by main.test.ts.
const runtimeStub = `
export class Notice {}
export const Platform = { isMobile: false };
export const normalizePath = path => path;
export function requestUrl() { throw new Error("Unexpected network request in manager tests"); }
export const requireApiVersion = () => true;
`;
const moduleHooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "obsidian") {
			return { url: `data:text/javascript,${encodeURIComponent(runtimeStub)}`, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});
const { ObsidianExtensions, Inspector, createLifecycleHook, SeedMaintenance } =
	await import("../src/host.ts").finally(() => moduleHooks.deregister());

const seedCode = transformSync(readFileSync("seed/main.js", "utf8"), {
	format: "cjs",
	minify: true,
	target: ["safari15", "chrome120"],
	legalComments: "none",
}).code;

const pluginManifest = {
	id: "one",
	name: "One",
	version: "1.0.0",
	minAppVersion: "1.0.0",
	author: "",
	description: "",
};

function hostFixture() {
	const files = new Files();
	const calls: string[] = [];
	const manager: RawPluginManager = {
		installPlugin: async (_repo, _version, manifest) => {
			calls.push(`install:${manifest.id}`);
			files.put("plugin", manifest.id);
		},
		uninstallPlugin: async (id) => {
			calls.push(`remove:${id}`);
			files.content.delete(`.config/plugins/${id}/main.js`);
		},
		enablePlugin: async (id) => {
			calls.push(`enable:${id}`);
		},
		enablePluginAndSave: async () => {},
		manifests: {},
		plugins: {},
		loadManifests: async () => {
			calls.push("reload");
		},
	};
	const themeManager = {
		requestReadThemes: () => {
			calls.push("refresh-themes");
		},
		installTheme: async (opts: { name: string }) => {
			calls.push(`install-theme:${opts.name}`);
			files.put("theme", opts.name);
		},
		removeTheme: async (name: string) => {
			calls.push(`remove-theme:${name}`);
			files.content.delete(`.config/themes/${name}/theme.css`);
		},
		setTheme: (name: string) => {
			calls.push(`theme:${name}`);
		},
	};
	const app = {
		plugins: manager,
		customCss: themeManager,
		vault: { adapter: files, configDir: ".config" },
	} as unknown as App;
	const pluginHook = createLifecycleHook("plugin", manager);
	const themeHook = createLifecycleHook("theme", themeManager);
	const replies = new Map<string, unknown>([
		[PLUGINS_REGISTRY_URL, [{ id: "one", repo: "owner/one" }]],
		[THEMES_REGISTRY_URL, [{ name: "Minimal", repo: "owner/theme" }]],
		["https://raw.githubusercontent.com/owner/one/HEAD/manifest.json", pluginManifest],
		["https://github.com/owner/one/releases/download/1.0.0/manifest.json", pluginManifest],
		[
			"https://raw.githubusercontent.com/owner/theme/HEAD/manifest.json",
			{
				name: "Minimal",
				author: "A",
				version: "1.0.0",
				minAppVersion: "1.0.0",
			},
		],
	]);
	const registry = new Registry({
		now: () => 0,
		isMobile: false,
		supportsVersion: () => true,
		fetchJson: (url) =>
			replies.has(url) ? Promise.resolve(replies.get(url)) : Promise.reject(new Error("404")),
	});
	const inspector = new Inspector(files, ".config", "plugback");
	const extensions = new ObsidianExtensions(
		app,
		manager,
		themeManager,
		inspector,
		registry,
		pluginHook,
		themeHook,
	);
	return {
		files,
		calls,
		manager,
		themeManager,
		app,
		pluginHook,
		themeHook,
		extensions,
		inspector,
	};
}

const assets = {
	manifest: JSON.stringify({ id: "plugback-seed", version: "1.0.0" }),
	mainJs: "/* bundled seed */",
};
function seedMaintenanceFixture() {
	const files = new Files();
	let enabled = false;
	const events: string[] = [];
	const seed = new SeedMaintenance(files, ".config/plugins", assets, {
		enabled: () => Promise.resolve(enabled),
		reload: async () => {
			events.push("reload");
		},
		enable: async () => {
			enabled = true;
			events.push("enable");
		},
	});
	return {
		files,
		events,
		seed,
	};
}
interface SeedRuntime {
	onload(): void;
	onunload(): void;
	check(): Promise<void>;
}
function seedFixture() {
	const files = new Files();
	const calls: string[] = [];
	const versions: string[] = [];
	const events = new Map<string, () => void>();
	const release = {
		id: "plugback",
		name: "Plugback",
		version: "1.0.0",
		minAppVersion: "1.8.7",
	};
	let fetch: () => Promise<{
		json: unknown;
	}> = () => Promise.resolve({ json: release });
	const app = {
		vault: { adapter: files, configDir: ".config" },
		workspace: {
			onLayoutReady: () => {},
		},
		plugins: {
			installPlugin: async (_repo: string, version: string, manifest: typeof release) => {
				calls.push("install");
				versions.push(version);
				files.put("plugin", "plugback");
				files.content.set(".config/plugins/plugback/manifest.json", JSON.stringify(manifest));
			},
			enablePluginAndSave: async () => {
				calls.push("enable");
			},
		},
	};
	class Plugin {
		app: unknown;
		constructor(value: unknown) {
			this.app = value;
		}
		registerDomEvent(_target: unknown, name: string, callback: () => void): void {
			events.set(name, callback);
		}
	}
	const mod: {
		exports: unknown;
	} = { exports: {} };
	runInNewContext(seedCode, {
		module: mod,
		window: {},
		console: {
			error: () => {},
		},
		require: () => ({
			Plugin,
			Notice: class {},
			normalizePath: (p: string) => p,
			requestUrl: () => fetch(),
			requireApiVersion: (version: string) => version === "1.8.7",
		}),
	});
	const Seed = mod.exports as new (app: unknown) => SeedRuntime;
	const seed = new Seed(app);
	seed.onload();
	return {
		seed,
		files,
		calls,
		versions,
		release,
		manager: app.plugins,
		fire: (name: string) => events.get(name)?.(),
		setFetch: (next: typeof fetch) => {
			fetch = next;
		},
	};
}

void test("native adapter prepares without mutation and delegates runnable install/remove actions", async () => {
	const f = hostFixture();
	for (const [kind, id] of [
		["plugin", "one"],
		["theme", "Minimal"],
	] as const) {
		const action = {
			kind,
			id,
			present: true,
		};
		const prepared = await f.extensions.prepare(action);
		assert.equal(
			f.calls.some((call) => call.startsWith("install")),
			kind === "theme",
		);
		assert.ok("run" in prepared);
		await prepared.run();
		assert.equal(await f.extensions.has(action), true);
		const remove = await f.extensions.prepare({ ...action, present: false });
		assert.ok("run" in remove);
		await remove.run();
		assert.equal(await f.extensions.has(action), false);
	}
	assert.deepEqual(f.calls, [
		"install:one",
		"reload",
		"remove:one",
		"install-theme:Minimal",
		"refresh-themes",
		"remove-theme:Minimal",
		"refresh-themes",
	]);
});

void test("repair classification includes leftover installation files but excludes settings-only folders", async () => {
	for (const [kind, id] of [
		["plugin", "one"],
		["theme", "Minimal"],
	] as const) {
		const f = hostFixture();
		const folder = `.config/${kind === "plugin" ? "plugins" : "themes"}/${id}`;
		f.files.content.set(`${folder}/data.json`, "{}");
		const fresh = await f.extensions.prepare({ kind, id, present: true });
		assert.ok("run" in fresh);
		assert.equal(fresh.repair, false);
		f.files.put(kind, id);
		f.files.content.set(`${folder}/${kind === "plugin" ? "main.js" : "theme.css"}`, "");
		const repair = await f.extensions.prepare({ kind, id, present: true });
		assert.ok("run" in repair);
		assert.equal(repair.repair, true);
	}
});

void test("native adapter refuses unlisted and protected removals", async () => {
	const f = hostFixture();
	for (const id of ["plugback", "plugback-seed", "custom", "../bad"]) {
		assert.ok(
			"skip" in
				(await f.extensions.prepare({
					kind: "plugin",
					id,
					present: false,
				})),
		);
	}
	assert.equal(f.calls.length, 0);
});

void test("activation preserves disabled plugins and honors lifetime after inspection", async () => {
	const f = hostFixture();
	f.files.put("plugin", "one");
	f.files.put("plugin", "disabled");
	f.files.put("plugin", "custom");
	f.files.put("theme", "Minimal");
	f.files.content.set(".config/community-plugins.json", '["one","custom"]');
	f.files.content.set(".config/appearance.json", '{"cssTheme":"Minimal"}');
	await f.extensions.restoreActivation(() => true);
	assert.deepEqual(f.calls, ["enable:one", "theme:Minimal"]);
	f.calls.length = 0;
	await f.extensions.restoreActivation(() => false);
	assert.equal(f.calls.length, 0);
});

void test("inspection distinguishes runnable extensions from settings-only folders", async () => {
	const files = new Files();
	files.put("plugin", "good");
	files.put("theme", "Minimal");
	files.content.set(".config/plugins/settings-only/data.json", "{}");
	const inspector = new Inspector(files, ".config", "plugback");
	assert.deepEqual([...(await inspector.list("plugin"))], [["good", "good"]]);
	assert.equal(await inspector.has("theme", "Minimal"), true);
	assert.equal(await inspector.has("plugin", "settings-only"), false);
});

void test("inspection rejects traversal, protected IDs, wrong identity, null, and malformed manifests", async () => {
	const files = new Files();
	const inspector = new Inspector(files, ".config", "plugback");
	for (const id of ["plugback", "plugback-seed", "../escape", "/absolute"]) {
		files.put("plugin", id);
		assert.equal(await inspector.has("plugin", id), false);
	}
	for (const text of [
		"null",
		"{bad",
		'{"id":"different","version":"1"}',
		'{"id":"broken","version":""}',
	]) {
		files.put("plugin", "broken");
		files.content.set(".config/plugins/broken/manifest.json", text);
		assert.equal(await inspector.has("plugin", "broken"), false);
	}
});

void test("storage access errors are propagated and never mistaken for confirmed absence", async () => {
	const files = new Files();
	files.put("plugin", "one");
	files.beforeRead = () => {
		throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
	};
	await assert.rejects(
		new Inspector(files, ".config", "plugback").list("plugin"),
		/Permission denied/,
	);
});

void test("zero-byte plugin and theme files are incomplete installations", async () => {
	const files = new Files();
	const inspector = new Inspector(files, ".config", "plugback");
	for (const kind of ["plugin", "theme"] as const) {
		const id = kind === "plugin" ? "one" : "Minimal";
		files.put(kind, id);
		files.content.set(
			`.config/${kind === "plugin" ? "plugins" : "themes"}/${id}/${kind === "plugin" ? "main.js" : "theme.css"}`,
			"",
		);
		assert.equal(await inspector.has(kind, id), false);
		assert.equal((await inspector.list(kind)).size, 0);
	}
});

void test("native failures and inspection failures finish their event sequence without reporting a change", async (t) => {
	t.mock.method(console, "error", () => {});
	for (const failure of ["native", "inspection"] as const) {
		const f = hostFixture();
		const events: string[] = [];
		if (failure === "native") {
			f.manager.uninstallPlugin = async () => {
				throw new Error("Native removal failed");
			};
		}
		const detach = f.pluginHook.observe({
			emit: (event) => {
				events.push(event.type);
			},
			hasValidInstallation: async () => {
				throw new Error("Inspection failed");
			},
		});
		if (failure === "native") {
			await assert.rejects(f.manager.uninstallPlugin("one"), /Native removal failed/);
		} else {
			await f.manager.uninstallPlugin("one");
		}
		assert.deepEqual(events, ["started", "finished"]);
		detach();
	}
});

void test("detaching during inspection suppresses the remaining native events", async () => {
	const f = hostFixture();
	const entered = deferred<void>();
	const release = deferred<boolean>();
	const events: string[] = [];
	const detach = f.pluginHook.observe({
		emit: (event) => {
			events.push(event.type);
		},
		hasValidInstallation: () => {
			entered.resolve();
			return release.promise;
		},
	});
	const job = f.manager.uninstallPlugin("one");
	await entered.promise;
	detach();
	release.resolve(false);
	await job;
	assert.deepEqual(events, ["started"]);
});

void test("lifecycle records successful native actions, suppresses managed actions, and restores methods", async () => {
	const f = hostFixture();
	const events: string[] = [];
	const observer: LifecycleObserver = {
		emit: (event) => {
			events.push(
				event.type === "changed"
					? `${event.action.present ? "add" : "delete"}:${event.action.id}`
					: event.type,
			);
		},
		hasValidInstallation: (id) => f.inspector.has("plugin", id),
	};
	const original = f.manager.installPlugin;
	f.pluginHook.observe(observer);
	const detach = f.pluginHook.observe(observer);
	await f.manager.installPlugin("owner/one", "1.0.0", pluginManifest);
	assert.deepEqual(events, ["started", "add:one", "finished"]);
	events.length = 0;
	await f.pluginHook.runManaged("one", () =>
		f.manager.installPlugin("owner/one", "1.0.0", pluginManifest),
	);
	assert.equal(events.length, 0);
	await f.manager.uninstallPlugin("one");
	assert.deepEqual(events, ["started", "delete:one", "finished"]);
	detach();
	assert.equal(f.manager.installPlugin, original);
});

void test("detaching while a native action is pending suppresses its late lifecycle callback", async () => {
	const f = hostFixture();
	const waiting = deferred<void>();
	let callbacks = 0;
	f.manager.uninstallPlugin = () => waiting.promise;
	const detach = f.pluginHook.observe({
		emit: (event) => {
			if (event.type !== "started") {
				callbacks++;
			}
		},
		hasValidInstallation: async () => false,
	});
	const job = f.manager.uninstallPlugin("one");
	detach();
	waiting.resolve();
	await job;
	assert.equal(callbacks, 0);
});

void test("nested managed calls stay suppressed until the outer call finishes and failures release suppression", async () => {
	const f = hostFixture();
	const events: string[] = [];
	const detach = f.pluginHook.observe({
		emit: (event) => {
			events.push(event.type);
		},
		hasValidInstallation: (id) => f.inspector.has("plugin", id),
	});
	await f.pluginHook.runManaged("one", async () => {
		await f.pluginHook.runManaged("one", () =>
			f.manager.installPlugin("owner/one", "1.0.0", pluginManifest),
		);
		await f.manager.uninstallPlugin("one");
	});
	assert.equal(events.length, 0);
	await assert.rejects(
		f.pluginHook.runManaged("one", async () => {
			throw new Error("Installer failed");
		}),
		/Installer failed/,
	);
	await f.manager.installPlugin("owner/one", "1.0.0", pluginManifest);
	assert.deepEqual(events, ["started", "changed", "finished"]);
	detach();
});

void test("theme observations use theme names and restore both removal methods", async () => {
	const f = hostFixture();
	const changes: string[] = [];
	const originalRemove = f.themeManager.removeTheme;
	const themes = Object.assign(f.themeManager, { uninstallTheme: originalRemove });
	const detach = f.themeHook.observe({
		emit: (event) => {
			if (event.type === "changed") {
				changes.push(`${event.action.kind}:${event.action.id}:${event.action.present}`);
			}
		},
		hasValidInstallation: (id) => f.inspector.has("theme", id),
	});
	await themes.installTheme({ name: "Minimal" });
	await themes.uninstallTheme("Minimal");
	await themes.installTheme({ name: "Minimal" });
	await themes.removeTheme("Minimal");
	assert.deepEqual(changes, [
		"theme:Minimal:true",
		"theme:Minimal:false",
		"theme:Minimal:true",
		"theme:Minimal:false",
	]);
	detach();
	assert.equal(themes.removeTheme, originalRemove);
	assert.equal(themes.uninstallTheme, originalRemove);
});

void test("unsubscribing restores inherited manager methods without leaving own properties", () => {
	const f = hostFixture();
	const manager = Object.create(f.manager) as RawPluginManager;
	const hook = createLifecycleHook("plugin", manager);
	const detach = hook.observe({ emit: () => {}, hasValidInstallation: async () => true });
	assert.equal(Object.hasOwn(manager, "installPlugin"), true);
	detach();
	assert.equal(Object.hasOwn(manager, "installPlugin"), false);
	assert.equal(manager.installPlugin, f.manager.installPlugin);
});

void test("a delayed installation observation cannot overwrite a newer confirmed removal", async () => {
	const f = hostFixture();
	const entered = deferred<void>();
	const inspection = deferred<boolean>();
	const changes: boolean[] = [];
	let first = true;
	const detach = f.pluginHook.observe({
		emit: (event) => {
			if (event.type === "changed") changes.push(event.action.present);
		},
		hasValidInstallation: (id) => {
			if (first) {
				first = false;
				entered.resolve();
				return inspection.promise;
			}
			return f.inspector.has("plugin", id);
		},
	});
	const installing = f.manager.installPlugin("owner/one", "1.0.0", pluginManifest);
	await entered.promise;
	await f.manager.uninstallPlugin("one");
	inspection.resolve(true);
	await installing;
	assert.deepEqual(changes, [false]);
	detach();
});

void test("a failed newer native operation does not discard an earlier confirmed change", async () => {
	const f = hostFixture();
	f.manager.uninstallPlugin = () => Promise.reject(new Error("Removal failed"));
	const entered = deferred<void>();
	const inspection = deferred<boolean>();
	const changes: boolean[] = [];
	const detach = f.pluginHook.observe({
		emit: (event) => {
			if (event.type === "changed") changes.push(event.action.present);
		},
		hasValidInstallation: () => {
			entered.resolve();
			return inspection.promise;
		},
	});
	const installing = f.manager.installPlugin("owner/one", "1.0.0", pluginManifest);
	await entered.promise;
	await assert.rejects(f.manager.uninstallPlugin("one"), /Removal failed/);
	inspection.resolve(true);
	await installing;
	assert.deepEqual(changes, [true]);
	detach();
});

void test("seed maintenance writes code before manifest and enables once", async () => {
	const f = seedMaintenanceFixture();
	await f.seed.check(() => true);
	await f.seed.check(() => true);
	assert.deepEqual(f.files.writes, [
		".config/plugins/plugback-seed/main.js",
		".config/plugins/plugback-seed/manifest.json",
	]);
	assert.deepEqual(f.events, ["reload", "enable"]);
});

void test("seed maintenance repairs interrupted upgrades and never overwrites invalid or newer manifests", async () => {
	const f = seedMaintenanceFixture();
	const path = ".config/plugins/plugback-seed/manifest.json";
	f.files.content.set(path, '{"id":"plugback-seed","version":"0.9.0"}');
	let fail = true;
	f.files.beforeWrite = (p) => {
		if (p === path && fail) {
			throw new Error("Disk full");
		}
	};
	await assert.rejects(f.seed.check(() => true));
	fail = false;
	await f.seed.check(() => true);
	assert.equal(
		(
			JSON.parse(f.files.content.get(path)!) as {
				version: string;
			}
		).version,
		"1.0.0",
	);
	for (const text of [
		'{"id":"other","version":"1.0.0"}',
		'{"id":"plugback-seed","version":"2.0.0"}',
	]) {
		const g = seedMaintenanceFixture();
		g.files.content.set(path, text);
		g.files.content.set(".config/plugins/plugback-seed/main.js", "/* newer */");
		if (text.includes("other")) {
			await assert.rejects(g.seed.check(() => true));
		} else {
			await g.seed.check(() => true);
		}
		assert.equal(g.files.writes.length, 0);
	}
});

void test("seed maintenance repairs changed code at the same version and keeps matching files", async () => {
	for (const mainJs of ["/* damaged seed */", assets.mainJs]) {
		const f = seedMaintenanceFixture();
		const dir = ".config/plugins/plugback-seed";
		f.files.content.set(`${dir}/manifest.json`, assets.manifest);
		f.files.content.set(`${dir}/main.js`, mainJs);
		await f.seed.check(() => true);
		assert.equal(f.files.content.get(`${dir}/main.js`), assets.mainJs);
		assert.equal(f.files.writes.length, mainJs === assets.mainJs ? 0 : 2);
	}
});

void test("stopping seed maintenance between writes prevents the next write and enable", async () => {
	const f = seedMaintenanceFixture();
	let alive = true;
	f.files.beforeWrite = () => {
		alive = false;
	};
	await f.seed.check(() => alive);
	assert.equal(f.files.writes.length, 1);
	assert.equal(f.events.length, 0);
});

void test("standalone seed bootstraps missing code, verifies assets, and avoids network when complete", async () => {
	const f = seedFixture();
	await f.seed.check();
	assert.deepEqual(f.calls, ["install", "enable"]);
	f.setFetch(() => {
		throw new Error("Must not request network");
	});
	await f.seed.check();
	assert.deepEqual(f.calls, ["install", "enable"]);
});

void test("standalone seed honors unload during network resolution and rejects incompatible releases", async () => {
	const f = seedFixture();
	const waiting = deferred<{
		json: unknown;
	}>();
	f.setFetch(() => waiting.promise);
	const job = f.seed.check();
	await new Promise<void>((resolve) => setImmediate(resolve));
	f.seed.onunload();
	waiting.resolve({ json: f.release });
	await job;
	assert.equal(f.calls.length, 0);
	const g = seedFixture();
	g.setFetch(() => Promise.resolve({ json: { ...g.release, minAppVersion: "99.0.0" } }));
	await g.seed.check();
	assert.equal(g.calls.length, 0);
});

void test("standalone seed retries enabling its own installation without reinstalling", async (t) => {
	const f = seedFixture();
	const enable = t.mock.method(f.manager, "enablePluginAndSave", () =>
		Promise.reject(new Error("Enable failed")),
	);
	await f.seed.check();
	assert.deepEqual(f.calls, ["install"]);
	enable.mock.restore();
	await f.seed.check();
	assert.deepEqual(f.calls, ["install", "enable"]);
});

void test("standalone seed can recover online after repeated offline attempts", async () => {
	const f = seedFixture();
	let requests = 0;
	f.setFetch(() => {
		requests++;
		return Promise.reject(new Error("Offline"));
	});
	for (let i = 0; i < 4; i++) {
		f.fire("focus");
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	assert.equal(f.calls.length, 0);
	f.setFetch(() => {
		requests++;
		return Promise.resolve({ json: f.release });
	});
	f.fire("online");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(f.calls, ["install", "enable"]);
	const completedRequests = requests;
	f.fire("focus");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(requests, completedRequests);
});

void test("standalone seed repairs the recorded version without fetching the latest release", async () => {
	const f = seedFixture();
	f.files.content.set(
		".config/plugins/plugback/manifest.json",
		JSON.stringify({ ...f.release, version: "2.0.0" }),
	);
	let requests = 0;
	f.setFetch(() => {
		requests++;
		return Promise.resolve({ json: f.release });
	});
	await f.seed.check();
	assert.deepEqual(f.calls, ["install", "enable"]);
	assert.deepEqual(f.versions, ["2.0.0"]);
	assert.equal(requests, 0);
});

void test("standalone seed retries the selected release after incompatible installation metadata", async (t) => {
	for (const invalid of [{ version: "9.0.0" }, { minAppVersion: "99.0.0" }]) {
		const f = seedFixture();
		const install = t.mock.method(f.manager, "installPlugin", async () => {
			f.files.put("plugin", "plugback");
			f.files.content.set(
				".config/plugins/plugback/manifest.json",
				JSON.stringify({ ...f.release, ...invalid }),
			);
		});
		await f.seed.check();
		assert.equal(f.calls.length, 0);
		install.mock.restore();
		await f.seed.check();
		assert.deepEqual(f.versions, ["1.0.0"]);
		assert.deepEqual(f.calls, ["install", "enable"]);
	}
});

void test("standalone seed leaves an existing complete installation disabled", async () => {
	const f = seedFixture();
	f.files.put("plugin", "plugback");
	f.files.content.set(".config/plugins/plugback/manifest.json", JSON.stringify(f.release));
	await f.seed.check();
	assert.equal(f.calls.length, 0);
});
