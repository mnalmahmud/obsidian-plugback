export const PLUGIN_ID = "plugback";
export const SEED_ID = "plugback-seed";

export const SCHEMA_VERSION = 1;

export interface Data {
	schemaVersion: typeof SCHEMA_VERSION;
	plugins: string[];
	themes: string[];
}

export class DataError extends Error {
	constructor(message: string, cause?: unknown) {
		super(message, { cause });
		this.name = "DataError";
	}
}

const PLUGIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const CONFLICT_MARKER_RE = /^(<{7}|={7}|>{7})(?:\s|$)/m;
// eslint-disable-next-line no-control-regex -- Theme names must reject ASCII control characters and DEL.
const INVALID_THEME_CHAR_RE = /[/\\:*?"<>|\x00-\x1f\x7f]/;

export function isValidPluginId(value: unknown): value is string {
	return typeof value === "string" && !value.includes("..") && PLUGIN_ID_RE.test(value);
}

export function isValidThemeName(value: unknown): value is string {
	if (typeof value !== "string") {
		return false;
	}
	const trimmed = value.trim();
	if (trimmed !== value || trimmed.length === 0 || trimmed.length > 160) {
		return false;
	}
	if (trimmed === "." || trimmed === ".." || trimmed.includes("..")) {
		return false;
	}
	return !INVALID_THEME_CHAR_RE.test(trimmed);
}

function normalizeNames(names: Iterable<string>): string[] {
	return [...new Set(names)].sort();
}

function validateUniqueArray(
	items: unknown,
	isValid: (value: unknown) => value is string,
	kind: Kind,
	selfId?: string,
): string[] {
	const kindLabel = kind === "plugin" ? "plugin ID" : "theme name";
	if (!Array.isArray(items)) {
		throw new DataError("Your sync list is damaged.", `Data has no ${kindLabel}s array.`);
	}
	const seen = new Set<string>();
	for (const item of items) {
		if (!isValid(item)) {
			throw new DataError(`Invalid ${kindLabel} in your sync list: ${JSON.stringify(item)}.`);
		}
		if (selfId !== undefined && (item === selfId || item === SEED_ID)) {
			throw new DataError("Your sync list can’t include Plugback or Plugback Seed.");
		}
		if (seen.has(item)) {
			throw new DataError(`Duplicate ${kind} in your sync list: ${item}.`);
		}
		seen.add(item);
	}
	return [...seen].sort();
}

export function parseData(raw: unknown, selfId = PLUGIN_ID): Data {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new DataError("Your sync list is damaged.", "Data is not a JSON object.");
	}
	const obj = raw as Record<string, unknown>;
	if (obj.schemaVersion !== SCHEMA_VERSION) {
		throw new DataError(
			"Your sync list uses an unsupported format.",
			`Unsupported data schemaVersion: ${String(obj.schemaVersion)}.`,
		);
	}

	return {
		schemaVersion: SCHEMA_VERSION,
		plugins: validateUniqueArray(obj.plugins, isValidPluginId, "plugin", selfId),
		themes: validateUniqueArray(obj.themes, isValidThemeName, "theme"),
	};
}

export function parseDataText(text: string, selfId = PLUGIN_ID): Data {
	if (CONFLICT_MARKER_RE.test(text)) {
		throw new DataError(
			"Your sync list has an unresolved conflict.",
			"Data file contains unresolved sync conflict markers.",
		);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new DataError("Your sync list is damaged.", error);
	}
	return parseData(raw, selfId);
}

export function createData(
	plugins: Iterable<string>,
	themes: Iterable<string>,
	selfId: string,
): Data {
	const normalizedPlugins = normalizeNames(plugins).filter((id) => id !== selfId && id !== SEED_ID);
	for (const id of normalizedPlugins) {
		if (!isValidPluginId(id)) {
			throw new DataError(`Can’t save an invalid plugin ID: ${JSON.stringify(id)}.`);
		}
	}
	const normalizedThemes = normalizeNames(themes);
	for (const name of normalizedThemes) {
		if (!isValidThemeName(name)) {
			throw new DataError(`Can’t save an invalid theme name: ${JSON.stringify(name)}.`);
		}
	}
	return {
		schemaVersion: SCHEMA_VERSION,
		plugins: normalizedPlugins,
		themes: normalizedThemes,
	};
}

export type Kind = "plugin" | "theme";
export interface Action {
	kind: Kind;
	id: string;
	present: boolean;
}
export interface Intent extends Action {
	sequence: number;
}
export interface Installed {
	plugins: ReadonlyMap<string, string>;
	themes: ReadonlyMap<string, string>;
	managedPlugins: ReadonlySet<string>;
	managedThemes: ReadonlySet<string>;
}
export interface DeviceState {
	initialized: boolean;
	sequence: number;
	pending: Intent[];
}
export type ProblemCode = "invalid-data" | "missing-data" | "storage" | "directory" | "operation";
export interface Problem {
	code: ProblemCode;
	message: string;
}
export interface Issue extends Problem {
	action: Action;
}
export interface Snapshot {
	phase: "idle" | "checking" | "waiting" | "error" | "stopped";
	initialized: boolean;
	data: Data | null;
	installed: Installed | null;
	issues: readonly Issue[];
	error: Problem | null;
	lastChecked: number | null;
}
export type Guard = () => boolean;
export interface SharedStore {
	read(): Promise<Data | null>;
	/** Transform the latest contents within the adapter's read-modify-write transaction. */
	update(transform: (current: Data | null) => Data, guard: Guard): Promise<Data>;
}
export interface DeviceStore {
	/** Return a validated copy of local state. */
	read(): DeviceState;
	/** Validate and copy the new state before saving; throw if saving fails. */
	write(state: DeviceState): void;
}
export interface Extensions {
	scan(pending: readonly Intent[]): Promise<Installed>;
	prepare(action: Action): Promise<
		| {
				repair?: boolean;
				run: () => Promise<void>;
		  }
		| {
				skip: string;
		  }
	>;
	has(action: Action): Promise<boolean>;
}
export type NativeEvent =
	{ type: "started" } | { type: "changed"; action: Action } | { type: "finished" };

export interface Services {
	selfId: string;
	shared: SharedStore;
	device: DeviceStore;
	extensions: Extensions;
	observe(listener: (event: NativeEvent) => void): () => void;
	activate?(guard: Guard): Promise<void>;
	notify(message: string): void;
	now(): number;
}
export class SyncError extends Error {
	readonly code: ProblemCode;
	constructor(code: ProblemCode, message: string, cause?: unknown) {
		super(message, { cause });
		this.code = code;
		this.name = "SyncError";
	}
}
export class Interrupted extends Error {}
export function problem(error: unknown, fallback: ProblemCode): Problem {
	return {
		code: error instanceof SyncError ? error.code : fallback,
		message: error instanceof Error ? error.message : String(error),
	};
}
export function noticeMessage(error: unknown): string {
	const message = problem(error, "operation").message;
	if (!(error instanceof DataError || error instanceof SyncError)) return message;
	if (error.cause !== undefined && message === problem(error.cause, "operation").message)
		return noticeMessage(error.cause);
	if (/^(Plugback|Obsidian)\b/.test(message)) return message;
	return message.charAt(0).toLowerCase() + message.slice(1);
}
export function key(value: Action): string {
	return `${value.kind}:${value.id}`;
}
export function eligible(intent: Intent, installed: Installed): boolean {
	return (intent.kind === "plugin" ? installed.managedPlugins : installed.managedThemes).has(
		intent.id,
	);
}
export function mergeIntents(data: Data, intents: readonly Intent[], selfId: string): Data {
	const plugins = new Set(data.plugins);
	const themes = new Set(data.themes);
	for (const intent of intents) {
		if (intent.kind === "plugin" && (intent.id === selfId || intent.id === SEED_ID)) {
			continue;
		}
		const targets = intent.kind === "plugin" ? plugins : themes;
		if (intent.present) {
			targets.add(intent.id);
		} else {
			targets.delete(intent.id);
		}
	}
	return createData(plugins, themes, selfId);
}
export function plan(data: Data, installed: Installed): Action[] {
	const actions: Action[] = [];
	for (const kind of ["plugin", "theme"] as const) {
		const local = kind === "plugin" ? installed.plugins : installed.themes;
		const managed = kind === "plugin" ? installed.managedPlugins : installed.managedThemes;
		const wanted = new Set(kind === "plugin" ? data.plugins : data.themes);
		for (const id of [...local.keys()].sort()) {
			if (managed.has(id) && !wanted.has(id)) {
				actions.push({
					kind,
					id,
					present: false,
				});
			}
		}
		for (const id of [...wanted].sort()) {
			if (!local.has(id)) {
				actions.push({
					kind,
					id,
					present: true,
				});
			}
		}
	}
	return actions;
}
export function emptyDevice(): DeviceState {
	return {
		initialized: false,
		sequence: 0,
		pending: [],
	};
}
export function parseDevice(raw: unknown): DeviceState {
	if (!raw || typeof raw !== "object") {
		throw new SyncError("storage", "Plugback’s saved data on this device is damaged.");
	}
	const value = raw as Record<string, unknown>;
	if (
		typeof value.initialized !== "boolean" ||
		!Number.isSafeInteger(value.sequence) ||
		(value.sequence as number) < 0 ||
		!Array.isArray(value.pending)
	) {
		throw new SyncError("storage", "Plugback’s saved data on this device is damaged.");
	}
	const seen = new Set<string>();
	for (const rawIntent of value.pending as unknown[]) {
		if (!rawIntent || typeof rawIntent !== "object") {
			throw new SyncError("storage", "Plugback couldn’t read your unsynced changes.");
		}
		const i = rawIntent as Intent;
		const validTarget =
			i.kind === "plugin" ? isValidPluginId(i.id) : i.kind === "theme" && isValidThemeName(i.id);
		const validSequence =
			Number.isSafeInteger(i.sequence) &&
			i.sequence > 0 &&
			i.sequence <= (value.sequence as number);
		if (!validTarget || typeof i.present !== "boolean" || !validSequence || seen.has(key(i))) {
			throw new SyncError("storage", "Plugback couldn’t read your unsynced changes.");
		}
		seen.add(key(i));
	}
	return {
		initialized: value.initialized,
		sequence: value.sequence as number,
		pending: (value.pending as Intent[]).map((i) => ({
			kind: i.kind,
			id: i.id,
			present: i.present,
			sequence: i.sequence,
		})),
	};
}

export interface FileStorage {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, text: string): Promise<void>;
	process(path: string, transform: (text: string) => string): Promise<string>;
}
export class SharedFile implements SharedStore {
	private readonly files: FileStorage;
	private readonly path: string;
	private readonly selfId: string;
	constructor(files: FileStorage, path: string, selfId: string) {
		this.files = files;
		this.path = path;
		this.selfId = selfId;
	}
	private parse(text: string): Data {
		try {
			return parseDataText(text, this.selfId);
		} catch (error) {
			throw new SyncError(
				"invalid-data",
				error instanceof Error ? error.message : String(error),
				error,
			);
		}
	}
	async read(): Promise<Data | null> {
		if (!(await this.files.exists(this.path))) {
			return null;
		}
		return this.parse(await this.files.read(this.path));
	}
	async update(transform: (current: Data | null) => Data, guard: Guard): Promise<Data> {
		const modify = (text: string | null): string => {
			if (!guard()) {
				throw new Interrupted();
			}
			const next = transform(text === null ? null : this.parse(text));
			return `${JSON.stringify(next, null, 2)}\n`;
		};
		if (await this.files.exists(this.path)) {
			const result = await this.files.process(this.path, (text) => modify(text));
			return this.parse(result);
		}
		// Sync the vault before first setup: creating a missing file isn’t transactional.
		const text = modify(null);
		await this.files.write(this.path, text);
		return this.parse(text);
	}
}
export interface LocalStorage {
	loadLocalStorage(key: string): unknown;
	saveLocalStorage(key: string, value: unknown): void;
}
const DEVICE_KEY = "plugback";
export class LocalDevice implements DeviceStore {
	private readonly storage: LocalStorage;
	constructor(storage: LocalStorage) {
		this.storage = storage;
	}
	read(): DeviceState {
		const raw = this.storage.loadLocalStorage(DEVICE_KEY);
		return raw === null || raw === undefined ? emptyDevice() : parseDevice(raw);
	}
	write(state: DeviceState): void {
		this.storage.saveLocalStorage(DEVICE_KEY, parseDevice(state));
	}
}
