import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const manifest = read("manifest.json");
assert.equal(
	read("package.json").version,
	manifest.version,
	"package.json and manifest.json versions differ",
);
assert.equal(
	read("versions.json")[manifest.version],
	manifest.minAppVersion,
	"versions.json does not match the manifest",
);
if (process.env.GITHUB_REF_TYPE === "tag")
	assert.equal(
		process.env.GITHUB_REF_NAME,
		manifest.version,
		"Release tag does not match the manifest",
	);
