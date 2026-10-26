import { isValidPluginId, isValidThemeName, SyncError } from "./data.ts";

export const PLUGINS_REGISTRY_URL =
	"https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD/community-plugins.json";
export const THEMES_REGISTRY_URL =
	"https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD/community-css-themes.json";
const TTL = 30 * 60 * 1000;
interface RegistryDeps {
	fetchJson(url: string): Promise<unknown>;
	isMobile: boolean;
	supportsVersion(version: string): boolean;
	now(): number;
}
interface Semver {
	major: number;
	minor: number;
	patch: number;
	prerelease: (number | string)[] | null;
}
export function parseSemver(input: string): Semver | null {
	if (typeof input !== "string" || input.length > 64) {
		return null;
	}
	const match =
		/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
			input,
		);
	if (!match) {
		return null;
	}
	const numbers = [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
	if (!numbers.every(Number.isSafeInteger)) {
		return null;
	}
	return {
		major: numbers[0]!,
		minor: numbers[1]!,
		patch: numbers[2]!,
		prerelease: match[4] ? match[4].split(".").map((v) => (/^\d+$/.test(v) ? Number(v) : v)) : null,
	};
}
export function compareSemver(a: Semver, b: Semver): number {
	for (const part of ["major", "minor", "patch"] as const) {
		if (a[part] !== b[part]) {
			return a[part] - b[part];
		}
	}
	if (!a.prerelease) {
		return b.prerelease ? 1 : 0;
	}
	if (!b.prerelease) {
		return -1;
	}
	for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
		const left = a.prerelease[i];
		const right = b.prerelease[i];
		if (left === undefined) {
			return -1;
		}
		if (right === undefined) {
			return 1;
		}
		if (left === right) {
			continue;
		}
		if (typeof left === "number" && typeof right === "number") {
			return left - right;
		}
		if (typeof left === "number") {
			return -1;
		}
		if (typeof right === "number") {
			return 1;
		}
		return left < right ? -1 : 1;
	}
	return 0;
}
function isValidRepo(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) &&
		value.split("/").every((part) => part !== "." && part !== "..")
	);
}
function branch(value: unknown): string | undefined {
	return typeof value === "string" &&
		/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(value) &&
		value.split("/").every((p) => p !== "." && p !== "..")
		? value
		: undefined;
}
interface Manifest {
	version: string;
	minAppVersion: string;
	name: string;
	author?: string;
	description?: string;
	id?: string;
	isDesktopOnly?: boolean;
}
interface ThemeEntry {
	repo: string;
	author: string;
	branch?: string;
	legacy: boolean;
}
type PluginResolution =
	| {
			ok: true;
			repo: string;
			manifest: Manifest & {
				id: string;
			};
			installVersion: string;
	  }
	| {
			ok: false;
			reason: string;
	  };
type ThemeResolution =
	| {
			ok: true;
			name: string;
			repo: string;
			author: string;
			branch?: string;
			version: string;
	  }
	| {
			ok: false;
			reason: string;
	  };
function manifest(raw: unknown, kind: "plugin" | "theme", id?: string): Manifest | null {
	if (!raw || typeof raw !== "object") {
		return null;
	}
	const value = raw as Record<string, unknown>;
	if (
		typeof value.version !== "string" ||
		!parseSemver(value.version) ||
		!/^[0-9A-Za-z.+-]{1,64}$/.test(value.version)
	) {
		return null;
	}
	if (
		typeof value.minAppVersion !== "string" ||
		!/^\d+(?:\.\d+){0,3}$/.test(value.minAppVersion) ||
		typeof value.name !== "string"
	) {
		return null;
	}
	if (kind === "plugin" ? !isValidPluginId(value.id) : !isValidThemeName(value.name)) {
		return null;
	}
	if (id !== undefined && (kind === "plugin" ? value.id !== id : value.name !== id)) {
		return null;
	}
	if (value.isDesktopOnly !== undefined && typeof value.isDesktopOnly !== "boolean") {
		return null;
	}
	if (kind === "theme" && typeof value.author !== "string") {
		return null;
	}
	return value as unknown as Manifest;
}
function tags(version: string): string[] {
	return [...new Set([version, version.startsWith("v") ? version.slice(1) : `v${version}`])];
}
function clean(version: string): string {
	return version.replace(/^v/, "");
}
interface Cached {
	at: number;
	entries: Map<string, Record<string, unknown>>;
}
interface Release {
	manifest: Manifest;
	tag: string;
}
export class Registry {
	private readonly cache = new Map<string, Cached>();
	private readonly inflight = new Map<string, Promise<Map<string, Record<string, unknown>>>>();
	private epoch = 0;
	private readonly deps: RegistryDeps;
	constructor(deps: RegistryDeps) {
		this.deps = deps;
	}
	clearCache(): void {
		this.epoch++;
		this.cache.clear();
		this.inflight.clear();
	}
	private directory(
		url: string,
		valid: (entry: Record<string, unknown>) => string | null,
		refresh = false,
	): Promise<Map<string, Record<string, unknown>>> {
		const cache = this.cache.get(url);
		if (!refresh && cache && this.deps.now() - cache.at < TTL) {
			return Promise.resolve(cache.entries);
		}
		const active = this.inflight.get(url);
		if (active) {
			return active;
		}
		const epoch = this.epoch;
		const kind = url === PLUGINS_REGISTRY_URL ? "plugin" : "theme";
		const job = this.deps
			.fetchJson(url)
			.then((raw) => {
				if (!Array.isArray(raw)) {
					throw new SyncError("directory", `Couldn’t read the community ${kind} directory.`);
				}
				const entries = new Map<string, Record<string, unknown>>();
				for (const item of raw as unknown[]) {
					if (!item || typeof item !== "object") {
						continue;
					}
					const entry = item as Record<string, unknown>;
					const id = valid(entry);
					if (id) {
						entries.set(id, entry);
					}
				}
				if (!entries.size) {
					throw new SyncError("directory", `The community ${kind} directory has no valid entries.`);
				}
				if (this.epoch === epoch) {
					this.cache.set(url, { at: this.deps.now(), entries });
				}
				return entries;
			})
			.finally(() => {
				if (this.inflight.get(url) === job) {
					this.inflight.delete(url);
				}
			});
		this.inflight.set(url, job);
		return job;
	}
	private async plugins(refresh = false): Promise<Map<string, string>> {
		const entries = await this.directory(
			PLUGINS_REGISTRY_URL,
			(e) => (isValidPluginId(e.id) && isValidRepo(e.repo) ? e.id : null),
			refresh,
		);
		return new Map([...entries].map(([id, e]) => [id, e.repo as string]));
	}
	private async themes(refresh = false): Promise<Map<string, ThemeEntry>> {
		const entries = await this.directory(
			THEMES_REGISTRY_URL,
			(e) => (isValidThemeName(e.name) && isValidRepo(e.repo) ? e.name : null),
			refresh,
		);
		return new Map(
			[...entries].map(([name, e]) => [
				name,
				{
					repo: e.repo as string,
					author: typeof e.author === "string" ? e.author : "",
					branch: branch(e.branch),
					legacy: e.legacy === true,
				},
			]),
		);
	}
	async getOfficialPluginIds(options?: { refresh?: boolean }): Promise<Set<string>> {
		return new Set((await this.plugins(options?.refresh)).keys());
	}
	async getOfficialThemeNames(options?: { refresh?: boolean }): Promise<Set<string>> {
		return new Set((await this.themes(options?.refresh)).keys());
	}
	async isOfficialPlugin(id: string): Promise<boolean> {
		return (await this.plugins()).has(id);
	}
	async isOfficialTheme(id: string): Promise<boolean> {
		return (await this.themes()).has(id);
	}
	private compatible(value: Manifest): boolean {
		return (
			this.deps.supportsVersion(value.minAppVersion) && !(this.deps.isMobile && value.isDesktopOnly)
		);
	}
	private async release(
		repo: string,
		version: string,
		kind: "plugin" | "theme",
		id: string,
	): Promise<Release | null> {
		for (const tag of tags(version)) {
			const urls = [`https://github.com/${repo}/releases/download/${tag}/manifest.json`];
			if (kind === "theme")
				urls.push(`https://raw.githubusercontent.com/${repo}/${tag}/manifest.json`);
			for (const url of urls) {
				try {
					const value = manifest(await this.deps.fetchJson(url), kind, id);
					if (value && clean(value.version) === clean(version)) {
						return { manifest: value, tag };
					}
				} catch {
					// Try the alternate tag or distribution URL.
				}
			}
		}
		return null;
	}
	private async older(
		repo: string,
		ref: string,
		kind: "plugin" | "theme",
		id: string,
	): Promise<Release | null> {
		let raw: unknown;
		try {
			raw = await this.deps.fetchJson(
				`https://raw.githubusercontent.com/${repo}/${ref}/versions.json`,
			);
		} catch {
			return null;
		}
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			return null;
		}
		const versions: { version: string; parsed: Semver }[] = [];
		for (const [version, min] of Object.entries(raw)) {
			const parsed = parseSemver(version);
			if (
				parsed &&
				typeof min === "string" &&
				/^\d+(?:\.\d+){0,3}$/.test(min) &&
				this.deps.supportsVersion(min)
			) {
				versions.push({ version, parsed });
			}
		}
		versions.sort((a, b) => compareSemver(b.parsed, a.parsed));
		for (const { version } of versions) {
			const result = await this.release(repo, version, kind, id);
			if (result && this.compatible(result.manifest)) {
				return result;
			}
		}
		return null;
	}
	async resolvePlugin(id: string): Promise<PluginResolution> {
		if (!isValidPluginId(id)) {
			return { ok: false, reason: "Invalid plugin ID." };
		}
		const repo = (await this.plugins()).get(id);
		if (!repo) {
			return { ok: false, reason: "This plugin isn’t in the community plugin directory." };
		}
		const latest = manifest(
			await this.deps.fetchJson(`https://raw.githubusercontent.com/${repo}/HEAD/manifest.json`),
			"plugin",
		);
		if (!latest) {
			return { ok: false, reason: "The plugin’s information is invalid." };
		}
		if (latest.id !== id) {
			return { ok: false, reason: "The plugin’s information identifies a different plugin." };
		}
		let selected = await this.release(repo, latest.version, "plugin", id);
		if (!selected || !this.compatible(selected.manifest)) {
			selected = await this.older(repo, "HEAD", "plugin", id);
		}
		if (!selected) {
			return {
				ok: false,
				reason: "No compatible version of this plugin is available for this device.",
			};
		}
		return {
			ok: true,
			repo,
			manifest: selected.manifest as Manifest & {
				id: string;
			},
			installVersion: selected.tag,
		};
	}
	async resolveTheme(name: string): Promise<ThemeResolution> {
		if (!isValidThemeName(name)) {
			return { ok: false, reason: "Invalid theme name." };
		}
		const entry = (await this.themes()).get(name);
		if (!entry) {
			return { ok: false, reason: "This theme isn’t in the community theme directory." };
		}
		if (entry.legacy) {
			return {
				ok: false,
				reason: "This theme is marked as incompatible with current versions of Obsidian.",
			};
		}
		const ref = entry.branch ?? "HEAD";
		const latest = manifest(
			await this.deps.fetchJson(
				`https://raw.githubusercontent.com/${entry.repo}/${ref}/manifest.json`,
			),
			"theme",
		);
		if (!latest) {
			return { ok: false, reason: "The theme’s information is invalid." };
		}
		if (latest.name !== name) {
			return { ok: false, reason: "The theme’s information identifies a different theme." };
		}
		let selected = await this.release(entry.repo, latest.version, "theme", name);
		if (!selected && this.compatible(latest)) {
			selected = { manifest: latest, tag: latest.version };
		}
		if (!selected || !this.compatible(selected.manifest)) {
			selected = await this.older(entry.repo, ref, "theme", name);
		}
		if (!selected) {
			return {
				ok: false,
				reason: "No compatible version of this theme is available for this device.",
			};
		}
		return {
			ok: true,
			name,
			repo: entry.repo,
			author: entry.author,
			branch: entry.branch,
			version: selected.tag,
		};
	}
}
