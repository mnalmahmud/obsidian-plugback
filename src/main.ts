import { Plugin, debounce } from "obsidian";
import { connect } from "./host.ts";
import { Core } from "./core.ts";
import { PlugbackSettingTab } from "./ui.ts";

export default class PlugbackPlugin extends Plugin {
	private core: Core | null = null;
	private integration: ReturnType<typeof connect> | null = null;
	private alive = false;
	private ready = false;
	private readonly requestCheck = debounce(
		() => {
			void this.check();
		},
		1000,
		true,
	);
	override onload(): void {
		this.alive = true;
		let unavailable: string | null = null;
		try {
			const integration = connect(this);
			this.integration = integration;
			this.core = new Core({
				...integration,
				selfId: this.manifest.id,
				now: Date.now,
			});
			this.registerDomEvent(window, "focus", this.requestCheck);
			this.registerDomEvent(window, "online", this.requestCheck);
			this.registerDomEvent(document, "visibilitychange", () => {
				if (document.visibilityState === "visible") {
					this.requestCheck();
				}
			});
			this.app.workspace.onLayoutReady(() => {
				if (!this.alive) {
					return;
				}
				this.ready = true;
				void this.check();
			});
		} catch (error) {
			unavailable = error instanceof Error ? error.message : String(error);
			console.error("[Plugback]", error);
		}
		this.addSettingTab(new PlugbackSettingTab(this.app, this, this.core, unavailable));
	}
	private async check(): Promise<void> {
		if (!this.alive || !this.ready || !this.integration || !this.core) {
			return;
		}
		try {
			await this.integration.seed.check(() => this.alive);
		} catch (error) {
			console.warn("[Plugback] Seed maintenance failed; will retry on next check", error);
		}
		if (!this.alive) {
			return;
		}
		await this.core.check();
	}
	override onExternalSettingsChange(): void {
		this.core?.invalidate();
		this.requestCheck();
	}
	override onunload(): void {
		this.alive = false;
		this.ready = false;
		this.core?.stop();
		this.requestCheck.cancel();
	}
}
