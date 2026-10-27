# Plugback

Keep your Obsidian plugins and themes in sync across devices.

Install or remove a community plugin or theme on one device. Once your vault syncs, Plugback applies that change on the others.

Your existing vault sync carries the saved list and settings. Each device downloads the plugins and themes it needs.

Requires Obsidian **1.8.7 or newer**. Your sync setup must include the configuration files listed below.

## Install

### First device

1. Install Plugback from the [community directory](https://community.obsidian.md/plugins/plugback).
2. Configure [what to sync](#what-to-sync).
3. Enable Plugback in Obsidian’s community plugin settings.
4. Let its first check finish, then sync your vault.

On first use, Plugback creates a saved list from the community plugins and themes installed on that device, unless a list already exists.

It also creates and enables **Plugback Seed** in `.obsidian/plugins/plugback-seed/`. This small loader installs Plugback on your other devices.

For a manual install, download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/mnalmahmud/obsidian-plugback/releases/latest) and place them in `.obsidian/plugins/plugback/`.

### Other devices

Let the vault finish syncing before opening it in Obsidian. Enable community plugins if asked; setup then runs automatically.

Plugins and themes absent from that list are removed if Plugback manages them. If your devices already have different setups, [combine their lists](#combine-existing-setups) before exchanging them.

## What to sync

Include the following files in your vault sync:

| Include                 | Location                                                                        |
| ----------------------- | ------------------------------------------------------------------------------- |
| Plugback’s saved list   | `.obsidian/plugins/plugback/data.json`                                          |
| Plugin settings         | `.obsidian/plugins/*/data.json`                                                 |
| Plugback Seed           | `.obsidian/plugins/plugback-seed/*`                                             |
| Other Obsidian settings | Your enabled-plugin list, selected theme, and other preferences in `.obsidian/` |

Exclude the remaining files in `.obsidian/plugins/` and downloaded themes in `.obsidian/themes/`. The settings and seed files above must remain included.

If you use a custom configuration folder, replace `.obsidian` with its name throughout these instructions.

### Git example

Add these rules to your vault’s `.gitignore`:

```gitignore
.obsidian/plugins/*/*
!.obsidian/plugins/*/data.json
!.obsidian/plugins/plugback-seed/*

.obsidian/themes/*
```

Ignore rules don’t untrack files already committed to Git. To keep an unlisted plugin in sync, add an exception such as `!.obsidian/plugins/my-plugin/*`.

## Combine existing setups

If your devices were set up separately, combine their saved lists before syncing them:

1. Set up Plugback on each device while it still has its own setup.
2. Collect each device’s saved list from the [location above](#what-to-sync). Combine the plugin and theme entries, keeping each entry only once.
3. Sync the combined list to all devices.

**Add from this device → Add** includes locally installed community plugins and themes in the current list while keeping existing entries. Use it before collecting the lists or receiving another device’s list.

## When sync fails

Plugback keeps local install and removal changes on the device until they can sync. An unreadable saved list, unresolved conflicts, or a missing list on an already initialized device stop sync.

Fix the reported issue or restore a valid copy of the saved list, then select **Check now** in Plugback’s settings. Changes made on multiple devices can require manually combining list entries.

Errors appear in settings or notices, with full details in the console.

## FAQ

### Does Plugback sync my vault or plugin settings?

Your existing vault sync transfers those files. Plugback installs and removes plugins and themes to match the saved list.

### Does Plugback sync versions or install updates?

Versions aren’t synced or pinned. Complete installations keep their versions; new installations use the latest compatible version.

A missing or empty plugin `main.js` or theme `theme.css` triggers a repair, which first tries the version recorded in the manifest. If that repair isn’t possible, Plugback uses the latest compatible version. Without a manifest, it chooses the latest compatible version directly.

### Can I keep different plugins enabled on different devices?

Plugback uses one installation list across devices. To choose which plugins are enabled on desktop or mobile, use [Device Extensions Switcher](https://community.obsidian.md/plugins/device-plugin-switcher).

### Can it install private or unlisted plugins and themes?

Plugback manages plugins by their community plugin IDs and themes by their community theme names. Unlisted plugins and themes are left alone; install them separately or include their files in vault sync. Plugback and Plugback Seed are excluded from the saved list.

Modified plugins and themes with the original community ID or name are still managed by Plugback. It removes them if they’re absent from your sync list, and repairs can overwrite your modifications. Use a different, unlisted plugin ID or theme name to keep them outside Plugback’s control.

## Network use

Plugback connects to `raw.githubusercontent.com` and `github.com` to read community directories, check compatible versions, and download plugins and themes. Plugback Seed uses the same services to download Plugback.

## Development

Use **Node.js 26 or newer** and **pnpm**. CI uses pnpm 10.

```sh
pnpm install --frozen-lockfile
pnpm run build
```

| Command                 | Purpose                                                   |
| ----------------------- | --------------------------------------------------------- |
| `pnpm run dev`          | Watch TypeScript sources and rebuild `main.js`            |
| `pnpm run build`        | Typecheck and build for production                        |
| `pnpm run check`        | Check metadata, formatting, types, lint, build, and tests |
| `pnpm run test`         | Build and run the tests                                   |
| `pnpm run format`       | Format source, configuration, and documentation           |
| `pnpm run format:check` | Check formatting without changing files                   |

`seed/main.js` is readable source. The build embeds a minified copy in Plugback, which writes it into the vault. Restart the watcher after changing seed sources or manifests.

For manual testing, copy or symlink the build’s `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/plugback/` in a test vault, then reload Plugback.

## License

[MIT](LICENSE)
