import {
	Notice,
	Platform,
	normalizePath,
	requestUrl,
	requireApiVersion,
	type App,
	type Plugin,
	type PluginManifest,
} from "obsidian";
import {
	SEED_ID,
	LocalDevice,
	SharedFile,
	SyncError,
	isValidPluginId,
	isValidThemeName,
	type Kind,
	type Action,
	type Extensions,
	type Installed,
	type Intent,
	type Guard,
	type NativeEvent,
} from "./data.ts";
import { Registry, compareSemver, parseSemver } from "./registry.ts";

export interface LifecycleObserver {
	emit(event: NativeEvent): void;
	hasValidInstallation(target: string): Promise<boolean>;
	isIgnored?(id: string): boolean;
}

export interface RawPluginManager {
	installPlugin: (repo: string, version: string, manifest: PluginManifest) => Promise<void>;
	uninstallPlugin: (id: string) => Promise<void>;
	enablePlugin: (id: string) => Promise<unknown>;
	enablePluginAndSave: (id: string) => Promise<unknown>;
	plugins?: Record<string, unknown>;
	manifests?: Record<string, unknown>;
	loadManifests?: () => Promise<void>;
}

export function rawPluginManager(app: App): RawPluginManager | null {
	const candidate = (app as unknown as { plugins?: unknown }).plugins;
	if (!candidate || typeof candidate !== "object") {
		return null;
	}
	const m = candidate as Record<string, unknown>;
	if (
		typeof m.installPlugin !== "function" ||
		typeof m.uninstallPlugin !== "function" ||
		typeof m.enablePlugin !== "function" ||
		typeof m.enablePluginAndSave !== "function"
	) {
		return null;
	}
	return candidate as RawPluginManager;
}

export interface ThemeInstallOpts {
	name: string;
	repo?: string;
	author?: string;
	branch?: string;
	[key: string]: unknown;
}

export interface RawThemeManager {
	installTheme: (opts: ThemeInstallOpts, version?: string) => Promise<void>;
	removeTheme: (name: string) => Promise<void>;
	setTheme?: (name: string) => void;
	requestReadThemes?: () => void;
	readThemes?: () => void;
	requestLoadTheme?: () => void;
}

export function rawThemeManager(app: App): RawThemeManager | null {
	const candidate = (app as unknown as { customCss?: unknown }).customCss;
	if (!candidate || typeof candidate !== "object") {
		return null;
	}
	const m = candidate as Record<string, unknown>;
	if (typeof m.installTheme !== "function" || typeof m.removeTheme !== "function") {
		return null;
	}
	return candidate as RawThemeManager;
}

export interface LifecycleHook {
	observe(observer: LifecycleObserver): () => void;
	runManaged<T>(id: string, operation: () => Promise<T>): Promise<T>;
}

function stringProperty(value: unknown, property: "id" | "name"): string | null {
	if (!value || typeof value !== "object") {
		return null;
	}
	const result = (value as Record<string, unknown>)[property];
	return typeof result === "string" ? result : null;
}

// Do not record Plugback's own installs and removals as user changes.
export function createLifecycleHook(kind: Kind, manager: RawPluginManager | RawThemeManager): LifecycleHook {
	const target = manager as unknown as Record<string, unknown>;
	const managed = new Map<string, number>();
	let detach = () => { };
	return {
		async runManaged<T>(id: string, operation: () => Promise<T>): Promise<T> {
			managed.set(id, (managed.get(id) ?? 0) + 1);
			try {
				return await operation();
			} finally {
				const remaining = (managed.get(id) ?? 1) - 1;
				if (remaining) {
					managed.set(id, remaining);
				} else {
					managed.delete(id);
				}
			}
		},
		observe(observer: LifecycleObserver): () => void {
			detach();
			const restores: (() => void)[] = [];
			const confirmed = new Map<string, number>();
			let sequence = 0;
			let active = true;
			detach = () => {
				active = false;
				for (const restore of restores) {
					restore();
				}
				restores.length = 0;
			};
			const emit = (event: NativeEvent) => {
				if (!active) {
					return;
				}
				try {
					observer.emit(event);
				}
				catch (error) {
					console.error("[Plugback] Native lifecycle observation failed", error);
				}
			};
			const wrap = (method: string, present: boolean, idFromArgs: (args: unknown[]) => string | null) => {
				if (typeof target[method] !== "function") {
					return;
				}
				const original = target[method] as (...args: unknown[]) => Promise<unknown>;
				const hadOwn = Object.prototype.hasOwnProperty.call(target, method);
				const wrapper = async (...args: unknown[]): Promise<unknown> => {
					const id = idFromArgs(args);
					if (!active || id !== null && managed.has(id)) {
						return original.apply(manager, args);
					}
					const operation = ++sequence;
					emit({ type: "started" });
					try {
						const result = await original.apply(manager, args);
						try {
							if (active && id !== null && !observer.isIgnored?.(id)) {
								const installed = await observer.hasValidInstallation(id);
								// A slow inspection must not replace a newer confirmed action.
								if (active && installed === present && operation > (confirmed.get(id) ?? 0)) {
									confirmed.set(id, operation);
									emit({ type: "changed", action: { kind, id, present } });
								}
							}
						} catch (error) {
							console.error("[Plugback] Native lifecycle observation failed", error);
						}
						return result;
					} finally {
						emit({ type: "finished" });
					}
				};
				target[method] = wrapper;
				restores.push(() => {
					if (target[method] !== wrapper) {
						return;
					}
					if (hadOwn) {
						target[method] = original;
					} else {
						delete target[method];
					}
				});
			};
			const firstArg = (args: unknown[]) => typeof args[0] === "string" ? args[0] : null;
			try {
				if (kind === "plugin") {
					wrap("installPlugin", true, args => stringProperty(args[2], "id"));
					wrap("uninstallPlugin", false, firstArg);
				} else {
					wrap("installTheme", true, args => stringProperty(args[0], "name"));
					wrap("removeTheme", false, firstArg);
					wrap("uninstallTheme", false, firstArg);
				}
			} catch (error) {
				detach();
				throw error;
			}
			return detach;
		},
	};
}

export interface InstallationFiles {
	exists(path: string): Promise<boolean>;
	stat(path: string): Promise<{ type: "file" | "folder"; size: number } | null>;
	read(path: string): Promise<string>;
	list(path: string): Promise<{
		folders: string[];
	}>;
}
function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
export class Inspector {
	private readonly files: InstallationFiles;
	private readonly configDir: string;
	private readonly selfId: string;
	constructor(files: InstallationFiles, configDir: string, selfId: string) {
		this.files = files;
		this.configDir = configDir;
		this.selfId = selfId;
	}
	private directory(kind: Kind): string {
		return `${this.configDir}/${kind === "plugin" ? "plugins" : "themes"}`;
	}
	valid(kind: Kind, id: string): boolean {
		return kind === "plugin" ? isValidPluginId(id) && id !== this.selfId && id !== SEED_ID : isValidThemeName(id);
	}
	async manifest(kind: Kind, id: string): Promise<Record<string, unknown> | null> {
		if (!this.valid(kind, id)) {
			return null;
		}
		const folder = `${this.directory(kind)}/${id}`;
		try {
			if (!await this.files.exists(`${folder}/manifest.json`)) {
				return null;
			}
			const code = await this.files.stat(`${folder}/${kind === "plugin" ? "main.js" : "theme.css"}`);
			if (code?.type !== "file" || code.size === 0) {
				return null;
			}
			const text = await this.files.read(`${folder}/manifest.json`);
			let value: unknown;
			try {
				value = JSON.parse(text);
			}
			catch {
				return null;
			}
			if (!value || typeof value !== "object") {
				return null;
			}
			const manifest = value as Record<string, unknown>;
			if (manifest[kind === "plugin" ? "id" : "name"] !== id || typeof manifest.version !== "string" ||
				!manifest.version.trim()) {
				return null;
			}
			return manifest;
		}
		catch (error) {
			if (missing(error)) {
				return null;
			}
			throw error;
		}
	}
	async has(kind: Kind, id: string): Promise<boolean> {
		return await this.manifest(kind, id) !== null;
	}
	async hasFiles(kind: Kind, id: string): Promise<boolean> {
		if (!this.valid(kind, id)) return false;
		const folder = `${this.directory(kind)}/${id}`;
		return await this.files.exists(`${folder}/manifest.json`) ||
			await this.files.exists(`${folder}/${kind === "plugin" ? "main.js" : "theme.css"}`);
	}
	async list(kind: Kind): Promise<Map<string, string>> {
		const dir = this.directory(kind);
		if (!await this.files.exists(dir)) {
			return new Map();
		}
		const entries = await this.files.list(dir);
		const installed = new Map<string, string>();
		for (const folder of entries.folders.sort()) {
			if (!folder.startsWith(`${dir}/`)) {
				continue;
			}
			const id = folder.slice(dir.length + 1);
			const manifest = await this.manifest(kind, id);
			if (manifest) {
				installed.set(id, typeof manifest.name === "string" ? manifest.name : id);
			}
		}
		return installed;
	}
}

export class ObsidianExtensions implements Extensions {
	private readonly app: App;
	private readonly plugins: RawPluginManager;
	private readonly themes: RawThemeManager;
	private readonly inspector: Inspector;
	private readonly registry: Registry;
	private readonly pluginHook: LifecycleHook;
	private readonly themeHook: LifecycleHook;
	constructor(
		app: App,
		plugins: RawPluginManager,
		themes: RawThemeManager,
		inspector: Inspector,
		registry: Registry,
		pluginHook: LifecycleHook,
		themeHook: LifecycleHook) {
		this.app = app;
		this.plugins = plugins;
		this.themes = themes;
		this.inspector = inspector;
		this.registry = registry;
		this.pluginHook = pluginHook;
		this.themeHook = themeHook;
	}
	async scan(pending: readonly Intent[]): Promise<Installed> {
		let [managedPlugins, managedThemes] = await Promise.all([this.registry.getOfficialPluginIds(), this.registry.getOfficialThemeNames()]);
		if (pending.some(i => i.kind === "plugin" && i.present && !managedPlugins.has(i.id))) {
			managedPlugins = await this.registry.getOfficialPluginIds({ refresh: true });
		}
		if (pending.some(i => i.kind === "theme" && i.present && !managedThemes.has(i.id))) {
			managedThemes = await this.registry.getOfficialThemeNames({ refresh: true });
		}
		const [plugins, themes] = await Promise.all([this.inspector.list("plugin"), this.inspector.list("theme")]);
		return {
			plugins, themes, managedPlugins, managedThemes
		};
	}
	has(action: Action): Promise<boolean> {
		return this.inspector.has(action.kind, action.id);
	}
	async prepare(action: Action): ReturnType<Extensions["prepare"]> {
		if (!this.inspector.valid(action.kind, action.id)) {
			return { skip: "Invalid or protected extension." };
		}
		if (action.kind === "plugin") {
			if (!await this.registry.isOfficialPlugin(action.id)) {
				return { skip: "Not listed in the official community plugin directory." };
			}
			if (!action.present) {
				if (!this.plugins.manifests?.[action.id] && this.plugins.loadManifests) {
					await this.plugins.loadManifests();
				}
				return { run: () => this.pluginHook.runManaged(action.id, () => this.plugins.uninstallPlugin(action.id)) };
			}
			const release = await this.registry.resolvePlugin(action.id);
			if (!release.ok) {
				return { skip: release.reason };
			}
			return {
				repair: await this.inspector.hasFiles(action.kind, action.id),
				run: async () => {
					await this.pluginHook.runManaged(
						action.id,
						() => this.plugins.installPlugin(
							release.repo,
							release.installVersion,
							{
								...release.manifest,
								author: typeof release.manifest.author === "string" ? release.manifest.author : "",
								description: typeof release.manifest.description === "string" ? release.manifest.description : ""
							}
						)
					);
				}
			};
		}
		if (!await this.registry.isOfficialTheme(action.id)) {
			return { skip: "Not listed in the official community theme directory." };
		}
		if (!action.present) {
			return { run: () => this.themeHook.runManaged(action.id, () => this.themes.removeTheme(action.id)).finally(() => this.refreshThemes()) };
		}
		const release = await this.registry.resolveTheme(action.id);
		if (!release.ok) {
			return { skip: release.reason };
		}
		return {
			repair: await this.inspector.hasFiles(action.kind, action.id),
			run: () => this.themeHook.runManaged(
				action.id,
				() => this.themes.installTheme({
					name: release.name,
					repo: release.repo,
					author: release.author,
					branch: release.branch
				}, release.version)
			).finally(() => this.refreshThemes())
		};
	}
	private refreshThemes(): void {
		try {
			const refresh = this.themes.requestReadThemes ?? this.themes.readThemes ?? this.themes.requestLoadTheme;
			refresh?.call(this.themes);
		} catch (error) {
			console.warn("[Plugback] Could not refresh theme metadata", error);
		}
	}
	// Reapply enabled plugins and the selected theme after installing their files.
	async restoreActivation(alive: () => boolean): Promise<void> {
		const adapter = this.app.vault.adapter;
		const dir = this.app.vault.configDir;
		if (await adapter.exists(`${dir}/community-plugins.json`)) {
			const raw: unknown = JSON.parse(await adapter.read(`${dir}/community-plugins.json`));
			if (Array.isArray(raw)) {
				for (const id of raw as unknown[]) {
					if (typeof id === "string" && this.inspector.valid("plugin", id) && await this.registry.isOfficialPlugin(id) &&
						!this.plugins.plugins?.[id] &&
						await this.inspector.has("plugin", id)) {
						if (!alive()) {
							return;
						}
						await this.plugins.enablePlugin(id);
					}
				}
			}
		}
		if (await adapter.exists(`${dir}/appearance.json`)) {
			const raw: unknown = JSON.parse(await adapter.read(`${dir}/appearance.json`));
			const name = raw && typeof raw === "object" ? (raw as {
				cssTheme?: unknown;
			}).cssTheme : null;
			if (typeof name === "string" && await this.registry.isOfficialTheme(name) &&
				await this.inspector.has("theme", name) &&
				alive()) {
				this.themes.setTheme?.(name);
			}
		}
	}
}

export interface SeedAssets {
	manifest: string;
	mainJs: string;
}
export interface SeedFiles {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	mkdir(path: string): Promise<void>;
}
export interface SeedManager {
	reload(): Promise<void>;
	enabled(): Promise<boolean>;
	enable(): Promise<void>;
}
export class SeedMaintenance {
	private complete = false;
	private job: Promise<void> | null = null;
	private readonly files: SeedFiles;
	private readonly pluginsDir: string;
	private readonly assets: SeedAssets;
	private readonly manager: SeedManager;
	constructor(files: SeedFiles, pluginsDir: string, assets: SeedAssets, manager: SeedManager) {
		this.files = files;
		this.pluginsDir = pluginsDir;
		this.assets = assets;
		this.manager = manager;
	}
	check(guard: Guard): Promise<void> {
		if (this.complete || !guard()) {
			return Promise.resolve();
		}
		if (!this.job) {
			this.job = this.maintain(guard).finally(() => {
				this.job = null;
			});
		}
		return this.job;
	}
	private parse(text: string): {
		version: string;
	} {
		const raw: unknown = JSON.parse(text);
		const manifest = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
		if (manifest?.id !== SEED_ID || typeof manifest.version !== "string") {
			throw new Error("Invalid Plugback Seed manifest; existing files were preserved.");
		}
		return { version: manifest.version };
	}
	private async maintain(guard: Guard): Promise<void> {
		const bundled = this.parse(this.assets.manifest);
		const nextVersion = parseSemver(bundled.version);
		if (!nextVersion || !this.assets.mainJs.trim()) {
			throw new Error("Invalid bundled Plugback Seed assets.");
		}
		const dir = `${this.pluginsDir}/${SEED_ID}`;
		const manifestPath = `${dir}/manifest.json`;
		const mainPath = `${dir}/main.js`;
		const exists = await this.files.exists(manifestPath);
		let replace = !exists;
		if (exists) {
			const current = parseSemver(this.parse(await this.files.read(manifestPath)).version);
			if (!current) {
				throw new Error("Invalid installed Plugback Seed version.");
			}
			const comparison = compareSemver(nextVersion, current);
			replace = comparison > 0 ||
				comparison === 0 && (!await this.files.exists(mainPath) || await this.files.read(mainPath) !== this.assets.mainJs);
		}
		if (!guard()) {
			return;
		}
		if (replace) {
			for (const folder of [this.pluginsDir, dir]) {
				if (!await this.files.exists(folder)) {
					if (!guard()) {
						return;
					}
					await this.files.mkdir(folder);
				}
			}
			if (!guard()) {
				return;
			}
			await this.files.write(mainPath, this.assets.mainJs);
			if (!guard()) {
				return;
			}
			await this.files.write(manifestPath, this.assets.manifest);
		}
		if (!guard()) {
			return;
		}
		if (!await this.manager.enabled()) {
			if (!guard()) {
				return;
			}
			await this.manager.reload();
			if (!guard()) {
				return;
			}
			await this.manager.enable();
		}
		if (guard()) {
			this.complete = true;
		}
	}
}

declare const __SEED_MANIFEST_TEXT__: string;
declare const __SEED_MAIN_JS_TEXT__: string;
export function connect(plugin: Plugin) {
	const app = plugin.app;
	const plugins = rawPluginManager(app);
	const themes = rawThemeManager(app);
	if (!plugins || !themes) {
		throw new Error("Obsidian's community plugin or theme manager is unavailable.");
	}
	const dir = normalizePath(app.vault.configDir);
	const registry = new Registry({
		fetchJson: async (url) => {
			const response = await requestUrl({ url, throw: false });
			if (response.status < 200 || response.status >= 300) {
				throw new SyncError("directory", `Network request failed (HTTP ${response.status}).`);
			}
			return response.json as unknown;
		},
		isMobile: Platform.isMobile,
		supportsVersion: requireApiVersion,
		now: Date.now,
	});
	const inspector = new Inspector(app.vault.adapter, dir, plugin.manifest.id);
	const pluginHook = createLifecycleHook("plugin", plugins);
	const themeHook = createLifecycleHook("theme", themes);
	const extensions = new ObsidianExtensions(app, plugins, themes, inspector, registry, pluginHook, themeHook);
	const device = new LocalDevice(app);
	const shared = new SharedFile(
		app.vault.adapter,
		normalizePath(`${plugin.manifest.dir ?? `${dir}/plugins/${plugin.manifest.id}`}/data.json`),
		plugin.manifest.id
	);
	const seed = new SeedMaintenance(
		app.vault.adapter,
		`${dir}/plugins`,
		{ manifest: __SEED_MANIFEST_TEXT__, mainJs: __SEED_MAIN_JS_TEXT__ },
		{
			reload: async () => {
				await plugins.loadManifests?.();
			},
			enabled: async () => {
				const path = `${dir}/community-plugins.json`;
				if (!await app.vault.adapter.exists(path)) {
					return false;
				}
				const value: unknown = JSON.parse(await app.vault.adapter.read(path));
				return Array.isArray(value) && value.includes(SEED_ID) && !!plugins.plugins?.[SEED_ID];
			},
			enable: async () => {
				await plugins.enablePluginAndSave(SEED_ID);
			},
		}
	);
	return {
		shared,
		device,
		extensions,
		seed,
		activate: (guard: () => boolean) => extensions.restoreActivation(guard),
		notify: (message: string) => {
			new Notice(message, 8000);
		},
		observe(emit: (event: NativeEvent) => void): () => void {
			const subscriptions: (() => void)[] = [];
			const detach = () => {
				for (const unsubscribe of subscriptions) {
					unsubscribe();
				}
			};
			try {
				for (const [kind, hook] of [["plugin", pluginHook], ["theme", themeHook]] as const) {
					subscriptions.push(hook.observe({
						emit,
						hasValidInstallation: id => inspector.has(kind, id),
						isIgnored: id => !inspector.valid(kind, id),
					}));
				}
			} catch (error) {
				detach();
				throw error;
			}
			return detach;
		},
	};
}
