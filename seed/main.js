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
	async #bootstrap() {
		const { adapter, configDir } = this.app.vault;
		const dir = normalizePath(`${configDir}/plugins/${ID}`);
		const manifestPath = `${dir}/manifest.json`;
		const mainPath = `${dir}/main.js`;
		let existing = null;
		let installed = false;
		if (await adapter.exists(manifestPath)) {
			existing = JSON.parse(await adapter.read(manifestPath));
			if (!this.#valid(existing))
				throw new Error("Plugback’s saved installation information is invalid.");
			installed =
				(!this.#pending || existing.version === this.#pending.version) &&
				requireApiVersion(existing.minAppVersion) &&
				(await adapter.exists(mainPath)) &&
				!!(await adapter.read(mainPath)).trim();
		}
		if (!this.#alive) return;
		if (installed && !this.#pending) {
			this.#complete = true;
			return;
		}
		let manifest = this.#pending ?? existing;
		if (!manifest) {
			const response = await requestUrl({
				url: `https://github.com/${REPO}/releases/latest/download/manifest.json`,
			});
			if (!this.#alive) return;
			manifest = response.json;
			if (!this.#valid(manifest))
				throw new Error("Plugback’s downloaded installation information is invalid.");
		}
		if (!requireApiVersion(manifest.minAppVersion))
			throw new Error(`Obsidian ${manifest.minAppVersion} or newer is required.`);
		const manager = this.app.plugins;
		if (
			typeof manager?.enablePluginAndSave !== "function" ||
			(!installed && typeof manager.installPlugin !== "function")
		) {
			throw new Error("couldn’t access Obsidian’s plugins.");
		}
		if (!installed) {
			this.#pending = manifest;
			await manager.installPlugin(REPO, manifest.version, manifest);
			if (!this.#alive) return;
			if (!(await adapter.exists(mainPath)) || !(await adapter.exists(manifestPath)))
				throw new Error("Plugback’s installation didn’t finish.");
			const written = JSON.parse(await adapter.read(manifestPath));
			if (!(await adapter.read(mainPath)).trim() || !this.#valid(written))
				throw new Error("Plugback’s installed files are invalid.");
			if (written.version !== manifest.version || !requireApiVersion(written.minAppVersion)) {
				throw new Error("the installed Plugback version doesn’t match the requested version.");
			}
		}
		if (!this.#alive) return;
		await manager.enablePluginAndSave(ID);
		if (this.#alive) this.#complete = true;
	}
}
module.exports = PlugbackSeed;
