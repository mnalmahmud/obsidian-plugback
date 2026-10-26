import assert from "node:assert/strict";
import test from "node:test";
import { createData, SyncError } from "../src/data.ts";
import { deferred, fixture } from "./helpers.ts";

void test("first startup captures managed installed extensions and preserves custom installations", async () => {
	const f = fixture(false);
	f.data = null;
	f.plugins.set("custom", "Custom");
	f.themes.set("Minimal", "Minimal");
	const core = f.core();
	await core.check();
	assert.deepEqual(f.data, createData(["p1"], ["Minimal"], "plugback"));
	assert.equal(f.device.initialized, true);
	assert.equal(core.snapshot.initialized, true);
	assert.equal(f.plugins.has("custom"), true);
	await core.check();
	assert.equal(f.deviceWrites, 1);
});
void test("joining an existing list follows it without importing local extras", async () => {
	const f = fixture(false);
	f.plugins.set("p2", "Two");
	f.themes.set("Things", "Things");
	f.data = createData(["p1", "remote"], ["Minimal"], "plugback");
	await f.core().check();
	assert.deepEqual(f.data, createData(["p1", "remote"], ["Minimal"], "plugback"));
	assert.equal(f.plugins.has("p2"), false);
	assert.equal(f.themes.has("Things"), false);
	assert.equal(f.plugins.has("remote"), true);
	assert.equal(f.themes.has("Minimal"), true);
	assert.equal(f.device.initialized, true);
	assert.equal(f.updates, 0);
});
void test("an existing valid empty list is authoritative on a new device", async () => {
	const f = fixture(false);
	f.data = createData([], [], "plugback");
	f.plugins.set("custom", "Custom");
	f.themes.set("Minimal", "Minimal");
	await f.core().check();
	assert.deepEqual([...f.plugins.keys()], ["custom"]);
	assert.equal(f.themes.size, 0);
	assert.equal(f.updates, 0);
});
void test("a shared list arriving during first creation wins over local inventory", async () => {
	const f = fixture(false);
	f.data = null;
	f.plugins.set("p2", "Two");
	f.hooks.update = () => {
		f.hooks.update = null;
		f.data = createData(["p1", "remote"], [], "plugback");
	};
	await f.core().check();
	assert.deepEqual(f.data, createData(["p1", "remote"], [], "plugback"));
	assert.equal(f.plugins.has("remote"), true);
	assert.equal(f.plugins.has("p2"), false);
});
for (const kind of ["plugin", "theme"] as const) {
	void test(`${kind}: local intent survives a failed shared write and restart`, async () => {
		const f = fixture();
		const id = kind === "plugin" ? "p2" : "Minimal";
		const local = kind === "plugin" ? f.plugins : f.themes;
		local.set(id, id);
		let core = f.core();
		core.record(kind, id, true);
		f.sharedWriteError = true;
		await core.check();
		assert.equal(core.snapshot.phase, "error");
		assert.equal(f.device.pending.length, 1);
		core.stop();
		f.sharedWriteError = false;
		core = f.core();
		await core.check();
		assert.equal(local.has(id), true);
		assert.equal(f.device.pending.length, 0);
		assert.equal((kind === "plugin" ? f.data?.plugins : f.data?.themes)?.includes(id), true);
	});
	void test(`${kind}: offline uninstall is replayed after restart`, async () => {
		const f = fixture();
		const id = kind === "plugin" ? "p1" : "Minimal";
		if (kind === "theme") {
			f.data = createData(["p1"], [id], "plugback");
		}
		(kind === "plugin" ? f.plugins : f.themes).delete(id);
		const old = f.core();
		old.record(kind, id, false);
		old.stop();
		await f.core().check();
		assert.equal((kind === "plugin" ? f.data?.plugins : f.data?.themes)?.includes(id), false);
	});
	void test(`${kind}: newer local install invalidates a stale uninstall`, async () => {
		const f = fixture();
		const id = kind === "plugin" ? "p2" : "Minimal";
		const local = kind === "plugin" ? f.plugins : f.themes;
		local.set(id, id);
		const core = f.core();
		f.hooks.prepare = (action) => {
			if (action.id === id) {
				f.hooks.prepare = null;
				core.record(kind, id, true);
			}
		};
		await core.check();
		assert.equal(local.has(id), true);
		assert.equal(f.operations.length, 0);
		assert.equal((kind === "plugin" ? f.data?.plugins : f.data?.themes)?.includes(id), true);
	});
}
void test("remote addition at the write boundary merges with local intent", async () => {
	const f = fixture();
	const core = f.core();
	f.plugins.set("p2", "Two");
	core.record("plugin", "p2", true);
	f.hooks.update = () => {
		f.data = createData(["p1", "remote"], [], "plugback");
	};
	await core.check();
	assert.deepEqual(f.data?.plugins, ["p1", "p2", "remote"]);
});
void test("stop at a transaction boundary prevents the write", async () => {
	const f = fixture();
	const core = f.core();
	core.record("plugin", "p2", true);
	f.hooks.update = () => core.stop();
	await core.check();
	assert.equal(f.updates, 0);
	assert.equal(f.device.pending.length, 1);
	assert.equal(core.snapshot.phase, "stopped");
});
void test("stop during metadata preparation prevents the native mutation", async () => {
	const f = fixture();
	f.plugins.set("p2", "Two");
	const core = f.core();
	f.hooks.prepare = () => core.stop();
	await core.check();
	assert.equal(f.operations.length, 0);
});
void test("stop during the final desired-state read prevents removal", async () => {
	const f = fixture();
	f.plugins.set("p2", "Two");
	const core = f.core();
	f.hooks.prepare = () => {
		f.hooks.read = () => core.stop();
	};
	await core.check();
	assert.equal(f.operations.length, 0);
	assert.equal(f.plugins.has("p2"), true);
});
void test("stop during a suspended resolution prevents removal", async () => {
	const f = fixture();
	f.plugins.set("p2", "Two");
	const core = f.core();
	const entered = deferred<void>();
	const release = deferred<void>();
	f.hooks.prepare = async () => {
		entered.resolve();
		await release.promise;
	};
	const job = core.check();
	await entered.promise;
	core.stop();
	release.resolve();
	await job;
	assert.equal(f.operations.length, 0);
	assert.equal(f.plugins.has("p2"), true);
});
void test("remote changes during metadata preparation invalidate obsolete actions", async () => {
	const f = fixture();
	f.plugins.set("p2", "Two");
	f.hooks.prepare = () => {
		f.data = createData(["p1", "p2"], [], "plugback");
	};
	await f.core().check();
	assert.equal(f.operations.length, 0);
	assert.equal(f.plugins.has("p2"), true);
});
void test("missing, invalid, and failed inspection never cause mutations", async () => {
	for (const mode of ["missing", "invalid", "inspection"] as const) {
		const f = fixture();
		f.plugins.set("p2", "Two");
		if (mode === "missing") {
			f.data = null;
		}
		if (mode === "invalid") {
			f.hooks.read = () => {
				throw new SyncError("invalid-data", "Merge conflict");
			};
		}
		if (mode === "inspection") {
			f.hooks.scan = () => {
				throw new Error("EIO");
			};
		}
		const core = f.core();
		await core.check();
		assert.equal(core.snapshot.phase, "error");
		assert.equal(f.operations.length, 0);
	}
});
void test("a new event at a write boundary is not acknowledged by the older transaction", async () => {
	const f = fixture();
	const core = f.core();
	f.plugins.set("p2", "Two");
	core.record("plugin", "p2", true);
	f.hooks.update = () => {
		f.hooks.update = null;
		f.plugins.delete("p2");
		core.record("plugin", "p2", false);
	};
	await core.check();
	assert.deepEqual(f.data?.plugins, ["p1"]);
	assert.equal(f.plugins.has("p2"), false);
});
void test("failed operations remain issues and recover without losing desired state", async () => {
	const f = fixture();
	f.data = createData(["p1", "p2"], [], "plugback");
	f.hooks.run = () => {
		throw new Error("Download failed");
	};
	const core = f.core();
	await core.check();
	assert.equal(core.snapshot.issues.length, 1);
	assert.deepEqual(f.data.plugins, ["p1", "p2"]);
	f.hooks.run = null;
	await core.check();
	assert.equal(core.snapshot.issues.length, 0);
	assert.equal(f.plugins.has("p2"), true);
});
void test("unlisted extensions remain untouched and missing delisted entries produce issues", async () => {
	const f = fixture();
	f.plugins.set("custom", "Custom");
	f.data = createData(["p1", "delisted"], [], "plugback");
	const core = f.core();
	await core.check();
	assert.equal(f.plugins.has("custom"), true);
	assert.equal(core.snapshot.issues.length, 1);
});
void test("concurrent checks coalesce and repeated checks are idempotent", async () => {
	const f = fixture();
	const core = f.core();
	const a = core.check();
	const b = core.check();
	assert.equal(a, b);
	await Promise.all([a, b]);
	await core.check();
	assert.equal(f.updates, 0);
	assert.equal(f.deviceWrites, 0);
	assert.equal(f.operations.length, 0);
});
void test("published snapshots cannot mutate coordinator state; unsubscribe stops delivery", async () => {
	const f = fixture();
	const core = f.core();
	let deliveries = 0;
	const off = core.subscribe((snapshot) => {
		deliveries++;
		snapshot.data?.plugins.push("tampered");
	});
	await core.check();
	assert.deepEqual(core.snapshot.data?.plugins, ["p1"]);
	off();
	const before = deliveries;
	await core.check();
	assert.equal(deliveries, before);
});
void test("a native operation invalidates a suspended plan even before recording an event", async () => {
	const f = fixture();
	f.plugins.set("p2", "Two");
	const core = f.core();
	f.hooks.prepare = () => {
		f.emit({ type: "started" });
	};
	await core.check();
	assert.equal(f.operations.length, 0);
});

void test("an installation appearing during resolution is preserved without reinstalling", async () => {
	const f = fixture();
	f.data = createData(["p1", "p2"], [], "plugback");
	f.hooks.prepare = () => {
		f.plugins.set("p2", "Already installed");
	};
	await f.core().check();
	assert.equal(f.operations.length, 0);
});
void test("sustained changes bound immediate retries and expose waiting status", async () => {
	const f = fixture();
	const core = f.core();
	f.hooks.scan = () => core.invalidate();
	await core.check();
	assert.equal(f.scans, 4);
	assert.equal(core.snapshot.phase, "waiting");
	f.hooks.scan = null;
	await core.check();
	assert.equal(core.snapshot.phase, "idle");
});
void test("successful checks restore activation; missing sync data blocks activation", async () => {
	const f = fixture();
	let activations = 0;
	f.services.activate = async (guard) => {
		if (guard()) {
			activations++;
		}
	};
	const core = f.core();
	await core.check();
	assert.equal(activations, 1);
	f.data = null;
	await core.check();
	assert.equal(activations, 1);
});
void test("repeated identical failures notify once until successful recovery", async () => {
	const f = fixture();
	const core = f.core();
	core.record("plugin", "p2", true);
	f.sharedWriteError = true;
	await core.check();
	await core.check();
	assert.equal(f.notifications.length, 1);
	f.sharedWriteError = false;
	await core.check();
	core.record("plugin", "p2", false);
	f.sharedWriteError = true;
	await core.check();
	assert.equal(f.notifications.filter((message) => message.includes("Disk full")).length, 2);
});

void test("an event after transaction commit but before its promise resolves is retained", async () => {
	const f = fixture();
	const core = f.core();
	f.plugins.set("p2", "Two");
	core.record("plugin", "p2", true);
	let injected = false;
	f.services.shared.update = (transform, guard) => {
		assert.equal(guard(), true);
		f.data = transform(f.data);
		if (!injected) {
			injected = true;
			f.plugins.delete("p2");
			core.record("plugin", "p2", false);
		}
		return Promise.resolve(f.data);
	};
	await core.check();
	assert.deepEqual(f.data?.plugins, ["p1"]);
	assert.equal(f.device.pending.length, 0);
});

void test("Add from this device merges installed community extensions without removing existing entries", async () => {
	const f = fixture();
	f.plugins.set("p2", "Two");
	f.plugins.set("custom", "Custom");
	f.themes.set("Things", "Things");
	f.data = createData(["remote"], ["Minimal"], "plugback");
	await f.core().consolidate();
	assert.deepEqual(f.data, createData(["p1", "p2", "remote"], ["Minimal", "Things"], "plugback"));
	assert.equal(
		f.operations.some((action) => !action.present),
		false,
	);
	assert.equal(f.plugins.has("custom"), true);
});
void test("consolidation uses current data and excludes Plugback and its seed", async () => {
	const f = fixture(false);
	f.plugins.set("p2", "Two");
	f.plugins.set("plugback", "Plugback");
	f.plugins.set("plugback-seed", "Seed");
	f.hooks.update = () => {
		f.data = createData(["remote"], ["Minimal"], "plugback");
	};
	await f.core().consolidate();
	assert.deepEqual(f.data, createData(["p1", "p2", "remote"], ["Minimal"], "plugback"));
});
void test("failed consolidation reports its error without changing installations or shared data", async () => {
	const f = fixture();
	f.plugins.set("p2", "Two");
	f.sharedWriteError = true;
	const core = f.core();
	await core.consolidate();
	assert.equal(core.snapshot.phase, "error");
	assert.equal(f.operations.length, 0);
	assert.deepEqual(f.data?.plugins, ["p1"]);
	f.sharedWriteError = false;
	await core.consolidate();
	assert.deepEqual(f.data?.plugins, ["p1", "p2"]);
});
void test("invalid data blocks explicit consolidation as well as automatic checks", async () => {
	const f = fixture();
	f.hooks.read = () => {
		throw new SyncError("invalid-data", "Unresolved conflict markers");
	};
	await f.core().consolidate();
	assert.equal(f.updates, 0);
	assert.equal(f.operations.length, 0);
});
void test("stop during consolidation prevents its transaction", async () => {
	const f = fixture();
	const core = f.core();
	f.hooks.update = () => core.stop();
	await core.consolidate();
	assert.equal(f.updates, 0);
	assert.equal(f.operations.length, 0);
});

void test("native changes before the first check are journaled without starting synchronization", async () => {
	const f = fixture();
	const core = f.core();
	f.plugins.set("p2", "Two");
	f.emit({ type: "started" });
	f.emit({ type: "changed", action: { kind: "plugin", id: "p2", present: true } });
	f.emit({ type: "finished" });
	assert.equal(f.scans, 0);
	assert.equal(f.updates, 0);
	assert.equal(f.device.pending.length, 1);
	await core.check();
	assert.deepEqual(f.data?.plugins, ["p1", "p2"]);
});
void test("core waits for all native operations to finish before scheduling its next check", async () => {
	const f = fixture();
	const core = f.core();
	await core.check();
	const before = f.scans;
	const completed = deferred<void>();
	const off = core.subscribe((snapshot) => {
		if (snapshot.phase === "idle" && snapshot.data?.plugins.includes("p2")) {
			completed.resolve();
		}
	});
	f.emit({ type: "started" });
	f.emit({ type: "started" });
	f.plugins.set("p2", "Two");
	f.emit({ type: "changed", action: { kind: "plugin", id: "p2", present: true } });
	f.emit({ type: "finished" });
	assert.equal(f.scans, before);
	assert.equal(f.updates, 0);
	f.emit({ type: "finished" });
	await completed.promise;
	off();
	assert.deepEqual(f.data?.plugins, ["p1", "p2"]);
	assert.equal(f.updates, 1);
});
void test("stopping the core unsubscribes once and ignores late native events", async () => {
	const f = fixture();
	let detached = 0;
	let listener: Parameters<typeof f.services.observe>[0] = () => {};
	const observe = f.services.observe.bind(f.services);
	f.services.observe = (callback) => {
		listener = callback;
		const off = observe(callback);
		return () => {
			detached++;
			off();
		};
	};
	const core = f.core();
	core.stop();
	core.stop();
	listener({ type: "started" });
	listener({ type: "changed", action: { kind: "plugin", id: "p2", present: true } });
	listener({ type: "finished" });
	await core.check();
	assert.equal(detached, 1);
	assert.equal(f.device.pending.length, 0);
	assert.equal(f.scans, 0);
	assert.equal(core.snapshot.phase, "stopped");
});

void test("an unsaved local event is persisted before retrying its shared update", async () => {
	const f = fixture();
	const core = f.core();
	f.plugins.set("p2", "Two");
	f.deviceWriteError = true;
	core.record("plugin", "p2", true);
	await core.check();
	assert.equal(core.snapshot.phase, "error");
	assert.equal(f.operations.length, 0);
	assert.equal(f.deviceWrites, 0);
	assert.equal(f.updates, 0);
	f.deviceWriteError = false;
	f.hooks.update = () => {
		assert.equal(f.deviceWrites, 1);
		assert.equal(f.device.pending[0]?.id, "p2");
	};
	await core.check();
	assert.equal(f.deviceWrites, 2);
	assert.equal(f.device.pending.length, 0);
	assert.deepEqual(f.data?.plugins, ["p1", "p2"]);
	await core.check();
	assert.equal(f.deviceWrites, 2);
});
void test("failed acknowledgement retains the journal for retry after a successful shared save", async () => {
	const f = fixture();
	const core = f.core();
	f.plugins.set("p2", "Two");
	core.record("plugin", "p2", true);
	const save = f.services.device.write.bind(f.services.device);
	f.services.device.write = (state) => {
		if (!state.pending.length) {
			throw new Error("Cannot acknowledge journal");
		}
		save(state);
	};
	await core.check();
	assert.equal(core.snapshot.phase, "error");
	assert.equal(f.device.pending.length, 1);
	assert.deepEqual(f.data?.plugins, ["p1", "p2"]);
	assert.equal(f.operations.length, 0);
	f.services.device.write = save;
	await core.check();
	assert.equal(f.updates, 2);
	assert.equal(f.device.pending.length, 0);
	assert.equal(f.deviceWrites, 2);
});

void test("local changes during a failed journal read survive recovery alongside older pending changes", async () => {
	const f = fixture();
	f.device = {
		initialized: true,
		sequence: 7,
		pending: [{ kind: "theme", id: "Minimal", present: true, sequence: 7 }],
	};
	f.themes.set("Minimal", "Minimal");
	f.deviceReadError = true;
	const core = f.core();
	f.plugins.set("p2", "Two");
	core.record("plugin", "p2", true);
	await core.check();
	assert.equal(core.snapshot.phase, "error");
	assert.equal(f.deviceWrites, 0);
	assert.equal(f.updates, 0);
	f.deviceReadError = false;
	await core.check();
	assert.deepEqual(f.data?.plugins, ["p1", "p2"]);
	assert.deepEqual(f.data?.themes, ["Minimal"]);
	assert.equal(f.operations.length, 0);
	assert.equal(f.device.sequence, 8);
	assert.equal(f.device.pending.length, 0);
});

void test("new local changes supersede an unread journal entry after storage recovers", async () => {
	const f = fixture();
	f.device = {
		initialized: true,
		sequence: 10,
		pending: [{ kind: "plugin", id: "p1", present: false, sequence: 10 }],
	};
	f.deviceReadError = true;
	const core = f.core();
	core.record("plugin", "p1", false);
	core.record("plugin", "p1", true);
	assert.equal(f.deviceWrites, 0);
	f.deviceReadError = false;
	await core.check();
	assert.deepEqual(f.data?.plugins, ["p1"]);
	assert.equal(f.operations.length, 0);
	assert.equal(f.device.sequence, 11);
	assert.equal(f.device.pending.length, 0);
});

void test("repairs and sync changes have separate success counts", async () => {
	const f = fixture();
	f.plugins.delete("p1");
	f.data = createData(["p1", "p2"], ["Minimal"], "plugback");
	const prepare = f.services.extensions.prepare.bind(f.services.extensions);
	f.services.extensions.prepare = async (action) => {
		const prepared = await prepare(action);
		return "run" in prepared ? { ...prepared, repair: action.id !== "p2" } : prepared;
	};
	await f.core().check();
	assert.deepEqual(f.notifications, [
		"Plugback: synced 1 plugin.",
		"Plugback: repaired 1 plugin and 1 theme.",
	]);
});

void test("success notices name plugins and themes, pluralize counts, and omit zero counts", async () => {
	for (const repair of [false, true]) {
		for (const [plugins, themes, expected] of [
			[["p1", "p2"], [], "2 plugins"],
			[[], ["Minimal"], "1 theme"],
			[[], ["Minimal", "Things"], "2 themes"],
			[["p1", "p2"], ["Minimal"], "2 plugins and 1 theme"],
		] as const) {
			const f = fixture();
			f.plugins.clear();
			f.data = createData(plugins, themes, "plugback");
			const prepare = f.services.extensions.prepare.bind(f.services.extensions);
			f.services.extensions.prepare = async (action) => {
				const prepared = await prepare(action);
				return "run" in prepared ? { ...prepared, repair } : prepared;
			};
			await f.core().check();
			assert.deepEqual(f.notifications, [
				`Plugback: ${repair ? "repaired" : "synced"} ${expected}.`,
			]);
		}
	}
});

void test("a failed repair does not produce a success notice", async () => {
	const f = fixture();
	f.plugins.delete("p1");
	const prepare = f.services.extensions.prepare.bind(f.services.extensions);
	f.services.extensions.prepare = async (action) => {
		const prepared = await prepare(action);
		return "run" in prepared ? { ...prepared, repair: true } : prepared;
	};
	f.hooks.run = () => {
		throw new Error("Repair failed");
	};
	const core = f.core();
	await core.check();
	assert.equal(core.snapshot.issues.length, 1);
	assert.deepEqual(f.notifications, []);
	f.hooks.run = null;
	await core.check();
	assert.deepEqual(f.notifications, ["Plugback: repaired 1 plugin."]);
});

void test("activation failure preserves the latest inventory and clears repaired operation errors", async () => {
	const f = fixture();
	f.data = createData(["p1", "p2"], [], "plugback");
	f.hooks.run = () => {
		throw new Error("Download failed");
	};
	const core = f.core();
	await core.check();
	assert.equal(core.snapshot.issues.length, 1);
	f.hooks.run = null;
	f.services.activate = () => Promise.reject(new Error("Enable failed"));
	await core.check();
	assert.equal(core.snapshot.phase, "error");
	assert.equal(core.snapshot.error?.code, "operation");
	assert.equal(core.snapshot.installed?.plugins.has("p2"), true);
	assert.deepEqual(core.snapshot.issues, []);
});
