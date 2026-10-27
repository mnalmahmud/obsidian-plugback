const { Plugin, Notice, normalizePath, requestUrl, requireApiVersion } = require("obsidian");
const ID = "plugback";
const REPO = "mnalmahmud/obsidian-plugback";

class PlugbackSeed extends Plugin {
	#alive;
	#complete;
	#pending;
	#lastError;
	#job;
	onload() {
		this.#alive = true;
		this.#complete = false;
		this.#pending = null;
		this.#lastError = "";
		this.#job = null;
		const retry = () => {
			void this.check();
		};
		this.registerDomEvent(window, "online", retry);
		this.registerDomEvent(window, "focus", retry);
		this.app.workspace.onLayoutReady(retry);
	}
	onunload() {
		this.#alive = false;
	}
	check() {
		if (!this.#alive || this.#complete) return Promise.resolve();
		if (!this.#job) {
			this.#job = this.#bootstrap()
				.catch((error) => {
					console.error("[Plugback Seed]", error);
					const message = error?.message ?? String(error);
					if (this.#alive && message !== this.#lastError) {
						this.#lastError = message;
						new Notice(`Plugback: setup failed: ${message}`, 8000);
					}
				})
				.finally(() => {
					this.#job = null;
				});
		}
		return this.#job;
	}
	#valid(manifest) {
		return (
			manifest &&
			manifest.id === ID &&
			typeof manifest.version === "string" &&
			/^[0-9A-Za-z.+-]{1,64}$/.test(manifest.version) &&
			typeof manifest.minAppVersion === "string" &&
			/^\d+(\.\d+){0,3}$/.test(manifest.minAppVersion)
		);
	}
	async #latest() {
		const response = await requestUrl({
			url: `https://github.com/${REPO}/releases/latest/download/manifest.json`,
		});
		const manifest = response.json;
		if (!this.#valid(manifest))
			throw new Error("Plugback’s downloaded installation information is invalid.");
		if (!this.#alive || requireApiVersion(manifest.minAppVersion)) return manifest;
		const versions = (
			await requestUrl({ url: `https://raw.githubusercontent.com/${REPO}/HEAD/versions.json` })
		).json;
		const candidates = Object.entries(versions ?? {}).sort(([a], [b]) =>
			b.localeCompare(a, "en", { numeric: true }),
		);
		for (const [version, minAppVersion] of candidates) {
			if (!this.#alive) return manifest;
			if (
				!/^\d+\.\d+\.\d+$/.test(version) ||
				!this.#valid({ id: ID, version, minAppVersion }) ||
				!requireApiVersion(minAppVersion)
			)
				continue;
			try {
				const candidate = (
					await requestUrl({
						url: `https://github.com/${REPO}/releases/download/${version}/manifest.json`,
					})
				).json;
				if (
					this.#valid(candidate) &&
					candidate.version === version &&
					requireApiVersion(candidate.minAppVersion)
				)
					return candidate;
			} catch {
				// A listed version may no longer have downloadable release files.
			}
		}
		throw new Error(`Obsidian ${manifest.minAppVersion} or newer is required.`);
	}
	async #bootstrap() {
		const { adapter, configDir } = this.app.vault;
		const dir = normalizePath(`${configDir}/plugins/${ID}`);
		const manifestPath = `${dir}/manifest.json`;
		const complete = async () => {
			for (const path of [`${dir}/main.js`, `${dir}/styles.css`]) {
				if (!(await adapter.exists(path)) || !(await adapter.read(path)).trim()) return false;
			}
			return true;
		};
		let existing = null;
		let installed = false;
		if (await adapter.exists(manifestPath)) {
			const text = await adapter.read(manifestPath);
			try {
				existing = JSON.parse(text);
				if (!this.#valid(existing))
					throw new Error("Plugback’s saved installation information is invalid.");
			} catch (error) {
				if (!this.#pending) throw error;
				existing = null;
			}
			installed =
				!!existing &&
				(!this.#pending || existing.version === this.#pending.version) &&
				requireApiVersion(existing.minAppVersion) &&
				(await complete());
		}
		if (!this.#alive) return;
		if (installed && !this.#pending) {
			this.#complete = true;
			return;
		}
		const repairing = !!existing || !!this.#pending;
		let manifest = this.#pending ?? existing;
		if (!manifest || !requireApiVersion(manifest.minAppVersion)) manifest = await this.#latest();
		if (!this.#alive) return;
		const manager = this.app.plugins;
		if (
			typeof manager?.enablePluginAndSave !== "function" ||
			(!installed && typeof manager.installPlugin !== "function")
		)
			throw new Error("couldn’t access Obsidian’s plugins.");
		const install = async (target) => {
			this.#pending = target;
			await manager.installPlugin(REPO, target.version, target);
			if (!this.#alive) return;
			if (!(await adapter.exists(manifestPath)) || !(await complete()))
				throw new Error("Plugback’s installation didn’t finish.");
			const written = JSON.parse(await adapter.read(manifestPath));
			if (!this.#valid(written)) throw new Error("Plugback’s installed files are invalid.");
			if (written.version !== target.version)
				throw new Error("the installed Plugback version doesn’t match the requested version.");
			if (!requireApiVersion(written.minAppVersion))
				throw new Error(`Obsidian ${written.minAppVersion} or newer is required.`);
		};
		if (!installed) {
			try {
				await install(manifest);
			} catch (error) {
				if (!this.#alive || !repairing) throw error;
				console.error("[Plugback Seed]", error);
				const latest = await this.#latest();
				if (!this.#alive) return;
				if (latest.version === manifest.version) throw error;
				await install(latest);
			}
		}
		if (!this.#alive) return;
		await manager.enablePluginAndSave(ID);
		if (this.#alive) this.#complete = true;
	}
}
module.exports = PlugbackSeed;
