import assert from "node:assert/strict";
import test from "node:test";
import {
	Registry,
	PLUGINS_REGISTRY_URL,
	THEMES_REGISTRY_URL,
	parseSemver,
	compareSemver,
} from "../src/registry.ts";
import { deferred } from "./helpers.ts";

function registry(mobile = false) {
	const replies = new Map<string, unknown>([
		[PLUGINS_REGISTRY_URL, [{ id: "one", repo: "owner/one" }]],
		[
			THEMES_REGISTRY_URL,
			[
				{
					name: "Minimal",
					repo: "owner/theme",
					author: "Author",
					branch: "stable",
				},
			],
		],
	]);
	const calls: string[] = [];
	let now = 0;
	const instance = new Registry({
		now: () => now,
		isMobile: mobile,
		supportsVersion: (value) => Number(value.split(".")[0]) < 2,
		fetchJson: (url) => {
			calls.push(url);
			const value = replies.get(url);
			return value === undefined || value instanceof Error
				? Promise.reject(value ?? new Error("404"))
				: Promise.resolve(value);
		},
	});
	return {
		instance,
		replies,
		calls,
		advance: () => {
			now += 31 * 60 * 1000;
		},
	};
}
const plugin = (version = "1.0.0", minAppVersion = "1.0.0", isDesktopOnly = false) => ({
	id: "one",
	name: "One",
	version,
	minAppVersion,
	isDesktopOnly,
});
void test("directory cache coalesces requests, refreshes, expires, and rejects invalid responses", async () => {
	const f = registry();
	await Promise.all([f.instance.getOfficialPluginIds(), f.instance.getOfficialPluginIds()]);
	assert.equal(f.calls.length, 1);
	await f.instance.getOfficialPluginIds();
	assert.equal(f.calls.length, 1);
	await f.instance.getOfficialPluginIds({ refresh: true });
	assert.equal(f.calls.length, 2);
	f.advance();
	await f.instance.getOfficialPluginIds();
	assert.equal(f.calls.length, 3);
	for (const raw of [[], {}, [{ id: "../bad", repo: "a/b" }], [{ id: "one", repo: "../bad" }]]) {
		f.instance.clearCache();
		f.replies.set(PLUGINS_REGISTRY_URL, raw);
		await assert.rejects(f.instance.getOfficialPluginIds());
	}
	f.replies.set(PLUGINS_REGISTRY_URL, [{ id: "one", repo: "owner/one" }, null]);
	assert.equal((await f.instance.getOfficialPluginIds()).has("one"), true);
});
void test("clearing the cache prevents an old in-flight response from repopulating it", async () => {
	const waiting = deferred<unknown>();
	let requests = 0;
	const r = new Registry({
		isMobile: false,
		supportsVersion: () => true,
		now: () => 0,
		fetchJson: () => {
			requests++;
			return requests === 1 ? waiting.promise : Promise.resolve([{ id: "new", repo: "owner/new" }]);
		},
	});
	const old = r.getOfficialPluginIds();
	r.clearCache();
	waiting.resolve([{ id: "old", repo: "owner/old" }]);
	await old;
	assert.deepEqual([...(await r.getOfficialPluginIds())], ["new"]);
});
void test("plugin compatibility is checked against the selected release, not the branch manifest", async () => {
	const f = registry();
	f.replies.set("https://raw.githubusercontent.com/owner/one/HEAD/manifest.json", plugin("2.0.0"));
	f.replies.set(
		"https://github.com/owner/one/releases/download/2.0.0/manifest.json",
		plugin("2.0.0", "2.0.0"),
	);
	f.replies.set("https://raw.githubusercontent.com/owner/one/HEAD/versions.json", {
		"1.9.0": "1.0.0",
		"1.10.0": "1.0.0",
	});
	f.replies.set(
		"https://github.com/owner/one/releases/download/1.10.0/manifest.json",
		plugin("1.10.0"),
	);
	const result = await f.instance.resolvePlugin("one");
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.installVersion, "1.10.0");
	}
});
void test("mobile falls back past desktop-only releases and accepts v-prefixed tags", async () => {
	const f = registry(true);
	f.replies.set(
		"https://raw.githubusercontent.com/owner/one/HEAD/manifest.json",
		plugin("2.0.0", "1.0.0", true),
	);
	f.replies.set("https://raw.githubusercontent.com/owner/one/HEAD/versions.json", {
		"2.0.0": "1.0.0",
		"1.0.0": "1.0.0",
	});
	f.replies.set(
		"https://github.com/owner/one/releases/download/2.0.0/manifest.json",
		plugin("2.0.0", "1.0.0", true),
	);
	f.replies.set("https://github.com/owner/one/releases/download/v1.0.0/manifest.json", plugin());
	const result = await f.instance.resolvePlugin("one");
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.installVersion, "v1.0.0");
	}
});
void test("invalid metadata and identity mismatches are rejected before resolving releases", async () => {
	for (const kind of ["plugin", "theme"] as const) {
		const f = registry();
		const url =
			kind === "plugin"
				? "https://raw.githubusercontent.com/owner/one/HEAD/manifest.json"
				: "https://raw.githubusercontent.com/owner/theme/stable/manifest.json";
		const valid =
			kind === "plugin"
				? plugin()
				: { name: "Minimal", author: "A", version: "1.0.0", minAppVersion: "1.0.0" };
		const resolve = () =>
			kind === "plugin" ? f.instance.resolvePlugin("one") : f.instance.resolveTheme("Minimal");
		f.replies.set(url, { ...valid, version: "invalid" });
		assert.deepEqual(await resolve(), {
			ok: false,
			reason: `The ${kind}’s information is invalid.`,
		});
		f.replies.set(url, { ...valid, [kind === "plugin" ? "id" : "name"]: "wrong" });
		assert.deepEqual(await resolve(), {
			ok: false,
			reason: `The ${kind}’s information identifies a different ${kind}.`,
		});
		assert.equal(
			f.calls.some((url) => url.includes("/releases/download/")),
			false,
		);
	}
});

void test("unpublished versions, wrong identities, and mismatched release versions are rejected", async () => {
	const f = registry();
	f.replies.set("https://raw.githubusercontent.com/owner/one/HEAD/manifest.json", plugin());
	assert.equal((await f.instance.resolvePlugin("one")).ok, false);
	f.replies.set("https://github.com/owner/one/releases/download/1.0.0/manifest.json", {
		...plugin(),
		id: "wrong",
	});
	assert.equal((await f.instance.resolvePlugin("one")).ok, false);
	f.replies.set(
		"https://github.com/owner/one/releases/download/1.0.0/manifest.json",
		plugin("3.0.0"),
	);
	assert.equal((await f.instance.resolvePlugin("one")).ok, false);
});
void test("a valid tagged-source manifest cannot override a mismatched plugin release attachment", async () => {
	const f = registry();
	f.replies.set("https://raw.githubusercontent.com/owner/one/HEAD/manifest.json", plugin());
	f.replies.set("https://github.com/owner/one/releases/download/1.0.0/manifest.json", {
		...plugin(),
		id: "wrong",
	});
	f.replies.set("https://raw.githubusercontent.com/owner/one/1.0.0/manifest.json", plugin());
	f.replies.set("https://raw.githubusercontent.com/owner/one/v1.0.0/manifest.json", plugin());
	assert.equal((await f.instance.resolvePlugin("one")).ok, false);
});
void test("themes support branch distribution and compatible older releases", async () => {
	const f = registry();
	const url = "https://raw.githubusercontent.com/owner/theme/stable/manifest.json";
	f.replies.set(url, {
		name: "Minimal",
		author: "A",
		version: "1.0.0",
		minAppVersion: "1.0.0",
	});
	let result = await f.instance.resolveTheme("Minimal");
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.branch, "stable");
	}
	f.replies.set(url, {
		name: "Minimal",
		author: "A",
		version: "2.0.0",
		minAppVersion: "2.0.0",
	});
	f.replies.set("https://raw.githubusercontent.com/owner/theme/stable/versions.json", {
		"1.0.0": "1.0.0",
	});
	f.replies.set("https://github.com/owner/theme/releases/download/1.0.0/manifest.json", {
		name: "Minimal",
		author: "A",
		version: "1.0.0",
		minAppVersion: "1.0.0",
	});
	result = await f.instance.resolveTheme("Minimal");
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.equal(result.version, "1.0.0");
	}
});
void test("version ordering handles numeric components and prereleases", () => {
	for (const [low, high] of [
		["1.9.0", "1.10.0"],
		["1.0.0-beta.2", "1.0.0-beta.10"],
		["1.0.0-rc.1", "1.0.0"],
	]) {
		assert.ok(compareSemver(parseSemver(low!)!, parseSemver(high!)!) < 0);
	}
	assert.equal(parseSemver("garbage"), null);
});
