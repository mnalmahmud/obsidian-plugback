import assert from "node:assert/strict";
import test from "node:test";
import {
	createData,
	parseDataText,
	isValidPluginId,
	isValidThemeName,
	emptyDevice,
	mergeIntents,
	parseDevice,
	plan,
	type Intent,
	type Installed,
	Interrupted,
	SyncError,
	LocalDevice,
	SharedFile,
	DataError,
	noticeMessage,
} from "../src/data.ts";
import { Files } from "./helpers.ts";

void test("notices lowercase owned errors while preserving settings text, proper names, and external errors", () => {
	const damaged = new DataError("Your sync list is damaged.");
	assert.equal(
		noticeMessage(new SyncError("invalid-data", damaged.message, damaged)),
		"your sync list is damaged.",
	);
	assert.equal(damaged.message, "Your sync list is damaged.");
	assert.equal(
		noticeMessage(new SyncError("directory", "Network request failed (HTTP 404).")),
		"network request failed (HTTP 404).",
	);
	for (const message of [
		"Plugback couldn’t read your unsynced changes.",
		"Obsidian 1.8.7 or newer is required.",
	]) {
		assert.equal(noticeMessage(new SyncError("operation", message)), message);
	}
	const external = new Error("EIO: Disk unavailable");
	assert.equal(noticeMessage(external), external.message);
	assert.equal(
		noticeMessage(new SyncError("operation", external.message, external)),
		external.message,
	);
	assert.equal(noticeMessage("HTTP request rejected"), "HTTP request rejected");
});

void test("shared data rejects unsupported schemas, unsafe names, duplicates, self, and conflicts", () => {
	for (const raw of [
		"null",
		"[]",
		"{}",
		"<<<<<<< HEAD\n{}",
		'{"schemaVersion":2,"plugins":[],"themes":[]}',
		'{"schemaVersion":1,"plugins":["a","a"],"themes":[]}',
		'{"schemaVersion":1,"plugins":["plugback"],"themes":[]}',
		'{"schemaVersion":1,"plugins":[],"themes":["../bad"]}',
	]) {
		assert.throws(() => parseDataText(raw));
	}
	for (const id of ["../escape", "/absolute", "a/b", "a\\b", "..", "", "a\n"]) {
		assert.equal(isValidPluginId(id), false);
	}
	for (const name of ["../escape", "a/b", " bad", "bad ", "bad\u0000", "bad:"]) {
		assert.equal(isValidThemeName(name), false);
	}
	assert.equal(isValidThemeName("Minimal Theme"), true);
});
void test("serialization normalizes deterministically and validates its inputs", () => {
	assert.deepEqual(createData(["z", "a", "a", "plugback"], ["Z", "A", "A"], "plugback"), {
		schemaVersion: 1,
		plugins: ["a", "z"],
		themes: ["A", "Z"],
	});
	assert.throws(() => createData(["../bad"], [], "plugback"));
});
void test("device journal validation rejects corrupt or ambiguous state", () => {
	assert.deepEqual(parseDevice(emptyDevice()), emptyDevice());
	for (const value of [
		null,
		{},
		{
			initialized: true,
			sequence: -1,
			pending: [],
		},
		{
			initialized: true,
			sequence: 1,
			pending: [
				{
					kind: "plugin",
					id: "a",
					present: true,
					sequence: 2,
				},
			],
		},
		{
			initialized: true,
			sequence: 1,
			pending: [
				{
					kind: "invalid",
					id: "a",
					present: true,
					sequence: 1,
				},
			],
		},
	]) {
		assert.throws(() => parseDevice(value));
	}
});
void test("planner preserves unlisted extensions and synchronizes presence without versions", () => {
	const installed: Installed = {
		plugins: new Map([
			["custom", "Custom"],
			["removed", "Removed"],
		]),
		themes: new Map(),
		managedPlugins: new Set(["removed", "added"]),
		managedThemes: new Set(),
	};
	assert.deepEqual(plan(createData(["added"], [], "plugback"), installed), [
		{
			kind: "plugin",
			id: "removed",
			present: false,
		},
		{
			kind: "plugin",
			id: "added",
			present: true,
		},
	]);
});
void test("intent merging is idempotent and preserves unrelated remote edits over generated histories", () => {
	let state = createData(["remote"], [], "plugback");
	const expected = new Set(["remote"]);
	let seed = 31;
	for (let sequence = 1; sequence <= 500; sequence++) {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		const id = `p${seed % 17}`;
		const present = (seed & 32) !== 0;
		const intent: Intent = {
			kind: "plugin",
			id,
			present,
			sequence,
		};
		if (present) {
			expected.add(id);
		} else {
			expected.delete(id);
		}
		state = mergeIntents(state, [intent], "plugback");
		assert.deepEqual(state.plugins, [...expected].sort());
		assert.deepEqual(mergeIntents(state, [intent], "plugback"), state);
	}
});

void test("shared-file update transforms current contents at the actual transaction boundary", async () => {
	const files = new Files();
	const path = "config/plugins/plugback/data.json";
	files.content.set(path, JSON.stringify(createData(["one"], [], "plugback")));
	const store = new SharedFile(files, path, "plugback");
	await store.read();
	files.beforeProcess = () =>
		files.content.set(path, JSON.stringify(createData(["one", "remote"], [], "plugback")));
	const data = await store.update(
		(current) =>
			mergeIntents(
				current!,
				[
					{
						kind: "plugin",
						id: "local",
						present: true,
						sequence: 1,
					},
				],
				"plugback",
			),
		() => true,
	);
	assert.deepEqual(data.plugins, ["local", "one", "remote"]);
});
void test("shared-file guard is checked inside process and blocks a post-disposal write", async () => {
	const files = new Files();
	const path = "data.json";
	files.content.set(path, JSON.stringify(createData([], [], "plugback")));
	let alive = true;
	files.beforeProcess = () => {
		alive = false;
	};
	await assert.rejects(
		new SharedFile(files, path, "plugback").update(
			() => createData(["p1"], [], "plugback"),
			() => alive,
		),
		Interrupted,
	);
	assert.equal(files.writes.length, 0);
});
void test("invalid shared data is never replaced by an update", async () => {
	const files = new Files();
	files.content.set("data.json", "<<<<<<< HEAD");
	const store = new SharedFile(files, "data.json", "plugback");
	await assert.rejects(
		store.update(
			() => createData([], [], "plugback"),
			() => true,
		),
		SyncError,
	);
	assert.equal(files.writes.length, 0);
});
void test("first creation and missing reads work with a custom config path", async () => {
	const files = new Files();
	const store = new SharedFile(files, "custom/plugins/plugback/data.json", "plugback");
	assert.equal(await store.read(), null);
	await store.update(
		() => createData(["one"], [], "plugback"),
		() => true,
	);
	assert.deepEqual((await store.read())?.plugins, ["one"]);
});
void test("device state uses the plugback key and persists a clone of the journal", () => {
	const values = new Map<string, unknown>();
	const local = new LocalDevice({
		loadLocalStorage: (key) => values.get(key),
		saveLocalStorage: (key, value) => {
			values.set(key, value);
		},
	});
	assert.deepEqual(local.read(), emptyDevice());
	const state = {
		...emptyDevice(),
		sequence: 1,
		pending: [
			{
				kind: "plugin" as const,
				id: "p1",
				present: true,
				sequence: 1,
			},
		],
	};
	local.write(state);
	assert.deepEqual([...values.keys()], ["plugback"]);
	state.pending.length = 0;
	assert.equal(local.read().pending.length, 1);
	const saved = local.read();
	assert.throws(() => local.write({ ...emptyDevice(), sequence: -1 }));
	assert.deepEqual(local.read(), saved);
	values.set("plugback", { corrupt: true });
	assert.throws(() => local.read());
});
