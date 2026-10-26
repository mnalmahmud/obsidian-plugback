import {
	SEED_ID,
	createData,
	isValidPluginId,
	isValidThemeName,
	type Data,
	eligible,
	emptyDevice,
	Interrupted,
	key,
	mergeIntents,
	plan,
	problem,
	SyncError,
	type Action,
	type DeviceState,
	type Guard,
	type Installed,
	type Intent,
	type Services,
	type Snapshot,
	type NativeEvent,
} from "./data.ts";

export class Core {
	private stopped = false;
	private readonly listeners = new Set<(snapshot: Snapshot) => void>();
	private device: DeviceState = emptyDevice();
	private deviceDirty = false;
	private loadFailed = false;
	private generation = 0;
	private nativeOperations = 0;
	private ready = false;
	private readonly detachNative: () => void;
	private dirty = false;
	private mergeRequested = false;
	private job: Promise<void> | null = null;
	private lastNotice = "";
	private view: Omit<Snapshot, "initialized"> = {
		phase: "idle",
		data: null,
		installed: null,
		issues: [],
		error: null,
		lastChecked: null,
	};
	private readonly services: Services;
	constructor(services: Services) {
		this.services = services;
		try {
			this.device = services.device.read();
		} catch (error) {
			this.loadFailed = true;
			this.fail(error);
		}
		this.detachNative = services.observe((event) => this.onNativeEvent(event));
	}
	get snapshot(): Snapshot {
		const view = this.view;
		return {
			...view,
			initialized: this.device.initialized,
			data: view.data
				? createData(view.data.plugins, view.data.themes, this.services.selfId)
				: null,
			installed: view.installed
				? {
						plugins: new Map(view.installed.plugins),
						themes: new Map(view.installed.themes),
						managedPlugins: new Set(view.installed.managedPlugins),
						managedThemes: new Set(view.installed.managedThemes),
					}
				: null,
			issues: view.issues.map((issue) => ({ ...issue, action: { ...issue.action } })),
			error: view.error ? { ...view.error } : null,
		};
	}
	subscribe(listener: (snapshot: Snapshot) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	stop(): void {
		if (this.stopped) {
			return;
		}
		this.stopped = true;
		this.detachNative();
		this.nativeOperations = 0;
		this.generation++;
		this.dirty = false;
		this.publish({ phase: "stopped" });
		this.listeners.clear();
	}
	invalidate(): void {
		this.generation++;
	}
	record(kind: Action["kind"], id: string, present: boolean): void {
		if (this.stopped || (kind === "plugin" && (id === this.services.selfId || id === SEED_ID))) {
			return;
		}
		if (!(kind === "plugin" ? isValidPluginId(id) : isValidThemeName(id))) {
			return;
		}
		this.generation++;
		const intent: Intent = {
			kind,
			id,
			present,
			sequence: ++this.device.sequence,
		};
		this.device.pending = [...this.device.pending.filter((i) => key(i) !== key(intent)), intent];
		this.deviceDirty = true;
		try {
			this.persist();
		} catch (error) {
			this.fail(error);
		}
		if (this.job) {
			this.dirty = true;
		}
	}
	check(): Promise<void> {
		if (this.stopped) {
			return Promise.resolve();
		}
		this.ready = true;
		this.dirty = true;
		if (!this.job) {
			this.publish({ phase: "checking" });
			this.job = Promise.resolve()
				.then(() => this.drain())
				.finally(() => {
					this.job = null;
				});
		}
		return this.job;
	}

	/** Include this device's installed community extensions in sync. */
	consolidate(): Promise<void> {
		if (this.stopped) {
			return Promise.resolve();
		}
		this.invalidate();
		this.mergeRequested = true;
		return this.check();
	}
	private onNativeEvent(event: NativeEvent): void {
		if (this.stopped) {
			return;
		}
		switch (event.type) {
			case "started":
				this.nativeOperations++;
				this.invalidate();
				break;
			case "changed":
				this.record(event.action.kind, event.action.id, event.action.present);
				break;
			case "finished":
				this.nativeOperations = Math.max(0, this.nativeOperations - 1);
				if (this.ready && this.nativeOperations === 0) {
					void this.check();
				}
				break;
		}
	}

	private async drain(): Promise<void> {
		for (let pass = 0; this.dirty && pass < 4 && !this.stopped; pass++) {
			this.dirty = false;
			if (this.nativeOperations > 0) {
				this.publish({ phase: "waiting" });
				break;
			}
			try {
				if (this.loadFailed) {
					const buffered = this.device.pending;
					this.device = this.services.device.read();
					this.loadFailed = false;
					this.deviceDirty = false;
					// Reassign buffered changes after the saved journal's sequence.
					for (const intent of buffered) this.record(intent.kind, intent.id, intent.present);
				}
				this.persist();
				this.publish({ phase: "checking", error: null });
				await this.pass();
			} catch (error) {
				if (error instanceof Interrupted) {
					continue;
				}
				if (!this.stopped) {
					this.fail(error);
				}
				this.dirty = false;
				this.mergeRequested = false;
				break;
			}
		}
		if (!this.stopped && this.dirty) {
			this.publish({ phase: "waiting" });
		} else if (!this.stopped && this.view.phase === "checking") {
			this.publish({ phase: "idle" });
		}
	}
	private guard(epoch = this.generation): Guard {
		return () => !this.stopped && epoch === this.generation && this.nativeOperations === 0;
	}
	private require(guard: Guard): void {
		if (!guard()) {
			if (!this.stopped) {
				this.dirty = true;
			}
			throw new Interrupted();
		}
	}
	private persist(): void {
		if (!this.deviceDirty || this.loadFailed) {
			return;
		}
		this.services.device.write(this.device);
		this.deviceDirty = false;
	}
	private async scan(guard: Guard): Promise<Installed> {
		const installed = await this.services.extensions.scan(this.device.pending);
		this.require(guard);
		return installed;
	}
	private async pass(): Promise<void> {
		const { services } = this;
		const guard = this.guard();
		let data = await services.shared.read();
		this.require(guard);
		if (!data && this.device.initialized) {
			throw new SyncError(
				"missing-data",
				"data.json is missing. Restore it from Git or another device.",
			);
		}
		let installed = await this.scan(guard);
		if (!data && !this.device.initialized && !this.mergeRequested) {
			data = await services.shared.update(
				(current) => current ?? this.captureInstalled(installed),
				guard,
			);
			this.require(guard);
		}
		const pending = [...this.device.pending];
		const accepted = pending.filter((intent) => eligible(intent, installed));
		const consolidating = this.mergeRequested;
		const hadData = data !== null;
		if (accepted.length || consolidating) {
			const additions = consolidating ? this.captureInstalled(installed) : null;
			data = await services.shared.update((current) => {
				if (!current && (hadData || this.device.initialized || !consolidating)) {
					throw new SyncError("missing-data", "data.json disappeared while saving local changes.");
				}
				const next = mergeIntents(
					current ?? createData([], [], services.selfId),
					accepted,
					services.selfId,
				);
				return additions
					? createData(
							[...next.plugins, ...additions.plugins],
							[...next.themes, ...additions.themes],
							services.selfId,
						)
					: next;
			}, guard);
			this.require(guard);
		}
		const remaining = this.device.pending.filter(
			(i) => !pending.some((p) => key(p) === key(i) && p.sequence === i.sequence),
		);
		if (!this.device.initialized || remaining.length !== this.device.pending.length) {
			const next = { ...this.device, initialized: true, pending: remaining };
			services.device.write(next);
			this.device = next;
			this.deviceDirty = false;
		}
		if (consolidating) {
			this.mergeRequested = false;
		}
		if (!data) {
			throw new SyncError(
				"missing-data",
				"data.json is missing. Restore it from Git or another device.",
			);
		}
		this.require(guard);
		const actions = plan(data, installed);
		const issues = new Map(
			this.view.issues
				.filter((i) => actions.some((a) => key(a) === key(i.action)))
				.map((i) => [key(i.action), i]),
		);
		this.publish({
			data,
			installed,
			issues: [...issues.values()],
		});
		let changed = 0;
		let repaired = 0;
		for (const action of actions) {
			this.require(guard);
			try {
				const prepared = await services.extensions.prepare(action);
				this.require(guard);
				if ("skip" in prepared) {
					throw new SyncError("operation", prepared.skip);
				}
				const alreadyPresent = await services.extensions.has(action);
				this.require(guard);
				if (alreadyPresent === action.present) {
					issues.delete(key(action));
					continue;
				}
				const latest = await services.shared.read();
				this.require(guard);
				if (!latest) {
					throw new SyncError("missing-data", "data.json disappeared during sync.");
				}
				const wanted = (action.kind === "plugin" ? latest.plugins : latest.themes).includes(
					action.id,
				);
				if (wanted !== action.present) {
					this.dirty = true;
					continue;
				}
				await prepared.run();
				this.require(guard);
				const present = await services.extensions.has(action);
				this.require(guard);
				if (present !== action.present) {
					throw new SyncError(
						"operation",
						action.present
							? "Installation is incomplete."
							: "Extension is still installed after removal.",
					);
				}
				issues.delete(key(action));
				if (action.present && prepared.repair) repaired++;
				else changed++;
			} catch (error) {
				if (
					error instanceof Interrupted ||
					(error instanceof SyncError &&
						(error.code === "missing-data" || error.code === "invalid-data"))
				) {
					throw error;
				}
				issues.set(key(action), { action, ...problem(error, "operation") });
			}
		}
		installed = await this.scan(guard);
		this.publish({ installed, issues: [...issues.values()] });
		if (services.activate) {
			try {
				await services.activate(guard);
			} catch (error) {
				throw new SyncError(
					"operation",
					`Could not restore enabled plugins or the active theme: ${problem(error, "operation").message}`,
				);
			}
			this.require(guard);
		}
		this.publish({
			phase: "idle",
			data,
			installed,
			issues: [...issues.values()],
			error: null,
			lastChecked: services.now(),
		});
		if (changed) {
			services.notify(
				`Plugback synchronized ${changed} ${changed === 1 ? "extension" : "extensions"}.`,
			);
		}
		if (repaired) {
			services.notify(
				`Plugback repaired ${repaired} ${repaired === 1 ? "installation" : "installations"}.`,
			);
		}
	}
	private captureInstalled(installed: Installed): Data {
		return createData(
			[...installed.plugins.keys()].filter((id) => installed.managedPlugins.has(id)),
			[...installed.themes.keys()].filter((id) => installed.managedThemes.has(id)),
			this.services.selfId,
		);
	}
	private fail(error: unknown): void {
		const failure = problem(error, "storage");
		this.publish({ phase: "error", error: failure });
		if (failure.message !== this.lastNotice) {
			this.lastNotice = failure.message;
			this.services.notify(`Plugback: ${failure.message}`);
		}
	}
	private publish(change: Partial<Omit<Snapshot, "initialized">>): void {
		if (this.stopped && change.phase !== "stopped") {
			return;
		}
		this.view = { ...this.view, ...change };
		if (change.error === null && change.phase === "idle") {
			this.lastNotice = "";
		}
		for (const listener of this.listeners) {
			try {
				listener(this.snapshot);
			} catch (error) {
				console.error("[Plugback] Status listener failed", error);
			}
		}
	}
}
