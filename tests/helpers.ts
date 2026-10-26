import { Buffer } from "node:buffer";
import { Core } from "../src/core.ts";
import {
	createData,
	type Data,
	emptyDevice,
	Interrupted,
	type Action,
	type Guard,
	type Installed,
	type Services,
	type NativeEvent,
} from "../src/data.ts";

export function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
export function fixture(initialized = true) {
	const state = {
		data: createData(["p1"], [], "plugback") as Data | null,
		device: { ...emptyDevice(), initialized },
		sharedWriteError: false,
		deviceWriteError: false,
		deviceReadError: false,
		updates: 0,
		scans: 0,
		deviceWrites: 0,
	};
	const plugins = new Map([["p1", "Plugin One"]]);
	const themes = new Map<string, string>();
	const officialPlugins = new Set(["p1", "p2", "remote"]);
	const officialThemes = new Set(["Minimal", "Things"]);
	const operations: Action[] = [];
	const notifications: string[] = [];
	const hooks = {
		read: null as (() => Promise<void> | void) | null,
		update: null as (() => Promise<void> | void) | null,
		scan: null as (() => Promise<void> | void) | null,
		prepare: null as ((action: Action) => Promise<void> | void) | null,
		run: null as ((action: Action) => Promise<void> | void) | null,
	};
	let listener: ((event: NativeEvent) => void) | null = null;
	const installed = (): Installed => ({
		plugins: new Map(plugins),
		themes: new Map(themes),
		managedPlugins: new Set(officialPlugins),
		managedThemes: new Set(officialThemes),
	});
	const services: Services = {
		selfId: "plugback",
		now: () => 1000,
		notify: (message) => {
			notifications.push(message);
		},
		observe: (callback) => {
			listener = callback;
			return () => {
				listener = null;
			};
		},
		device: {
			read: () => {
				if (state.deviceReadError) throw new Error("Local storage unavailable");
				return structuredClone(state.device);
			},
			write: (next) => {
				if (state.deviceWriteError) {
					throw new Error("Local storage unavailable");
				}
				state.device = structuredClone(next);
				state.deviceWrites++;
			},
		},
		shared: {
			read: async () => {
				await hooks.read?.();
				return structuredClone(state.data);
			},
			update: async (transform: (value: Data | null) => Data, guard: Guard) => {
				await hooks.update?.();
				if (!guard()) {
					throw new Interrupted();
				}
				if (state.sharedWriteError) {
					throw new Error("Disk full");
				}
				state.data = transform(structuredClone(state.data));
				state.updates++;
				return structuredClone(state.data);
			},
		},
		extensions: {
			scan: async () => {
				state.scans++;
				await hooks.scan?.();
				return installed();
			},
			prepare: async (action) => {
				await hooks.prepare?.(action);
				if (!(action.kind === "plugin" ? officialPlugins : officialThemes).has(action.id)) {
					return { skip: "Unlisted extension" };
				}
				return {
					run: async () => {
						operations.push(action);
						await hooks.run?.(action);
						const targets = action.kind === "plugin" ? plugins : themes;
						if (action.present) {
							targets.set(action.id, action.id);
						} else {
							targets.delete(action.id);
						}
					},
				};
			},
			has: (action) =>
				Promise.resolve((action.kind === "plugin" ? plugins : themes).has(action.id)),
		},
	};
	return Object.assign(state, {
		services,
		hooks,
		plugins,
		themes,
		officialPlugins,
		officialThemes,
		operations,
		notifications,
		core: () => new Core(services),
		emit: (event: NativeEvent) => listener?.(event),
	});
}

export class Files {
	readonly content = new Map<string, string>();
	readonly folders = new Set<string>();
	writes: string[] = [];
	beforeProcess: (() => void) | null = null;
	beforeRead: ((path: string) => void) | null = null;
	beforeWrite: ((path: string) => void) | null = null;
	exists(path: string): Promise<boolean> {
		return Promise.resolve(
			this.content.has(path) ||
				this.folders.has(path) ||
				[...this.content.keys()].some((p) => p.startsWith(`${path}/`)),
		);
	}
	stat(path: string): Promise<{ type: "file" | "folder"; size: number } | null> {
		const content = this.content.get(path);
		if (content !== undefined)
			return Promise.resolve({ type: "file", size: Buffer.byteLength(content) });
		const folder =
			this.folders.has(path) || [...this.content.keys()].some((p) => p.startsWith(`${path}/`));
		return Promise.resolve(folder ? { type: "folder", size: 0 } : null);
	}
	read(path: string): Promise<string> {
		this.beforeRead?.(path);
		const value = this.content.get(path);
		return value === undefined
			? Promise.reject(Object.assign(new Error("Missing file"), { code: "ENOENT" }))
			: Promise.resolve(value);
	}
	write(path: string, text: string): Promise<void> {
		this.beforeWrite?.(path);
		this.writes.push(path);
		this.content.set(path, text);
		return Promise.resolve();
	}
	process(path: string, transform: (text: string) => string): Promise<string> {
		this.beforeProcess?.();
		const current = this.content.get(path);
		if (current === undefined) {
			return Promise.reject(new Error("File disappeared"));
		}
		const next = transform(current);
		this.content.set(path, next);
		this.writes.push(path);
		return Promise.resolve(next);
	}
	mkdir(path: string): Promise<void> {
		this.folders.add(path);
		return Promise.resolve();
	}
	list(path: string): Promise<{
		folders: string[];
	}> {
		return Promise.resolve({
			folders: [
				...new Set(
					[...this.content.keys()]
						.filter((p) => p.startsWith(`${path}/`))
						.map((p) => `${path}/${p.slice(path.length + 1).split("/")[0]}`),
				),
			],
		});
	}
	put(kind: "plugin" | "theme", id: string, configDir = ".config"): void {
		const dir = `${configDir}/${kind === "plugin" ? "plugins" : "themes"}/${id}`;
		this.content.set(
			`${dir}/manifest.json`,
			JSON.stringify({
				[kind === "plugin" ? "id" : "name"]: id,
				version: "1.0.0",
				name: id,
			}),
		);
		this.content.set(`${dir}/${kind === "plugin" ? "main.js" : "theme.css"}`, "/* extension */");
	}
}
