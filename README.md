# Plugback

Keep your Obsidian plugins and themes in sync across devices.

Plugback saves your community plugin and theme list in `.obsidian/plugins/plugback/data.json`. Your existing vault sync carries that list and your settings between devices. Plugback installs or removes plugins and themes to match the list.

Requires Obsidian **1.8.7 or newer**.

## Setup

### First device

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/mnalmahmud/obsidian-plugback/releases/latest).
2. Place them in `.obsidian/plugins/plugback/` in your vault.
3. Configure the [sync exclusions](#sync-exclusions), then enable Plugback in Obsidian’s community plugin settings.
4. Let your vault finish syncing before setting up another device.

When there’s no saved list, Plugback creates one from this device’s installed community plugins and themes.

Plugback also creates and enables **Plugback Seed**, a small loader in `.obsidian/plugins/plugback-seed/`. Keep its files in vault sync. The seed installs Plugback automatically on your other devices.

### Additional devices

1. Let the vault finish syncing before opening it in Obsidian.
2. Enable community plugins if Obsidian asks.
3. Wait for Plugback to install the plugins and themes in the saved list.

An existing list determines what gets installed. Locally installed community plugins and themes absent from that list are removed. If you’re combining independently configured devices, follow [Combining existing setups](#combining-existing-setups) before syncing their lists.

## Sync exclusions

Include these files in vault sync:

| Files                               | Purpose                                                    |
| ----------------------------------- | ---------------------------------------------------------- |
| `.obsidian/plugins/*/data.json`     | Plugin settings, including Plugback’s list                 |
| `.obsidian/plugins/plugback-seed/*` | The loader for setting up additional devices               |
| Other Obsidian settings             | Enabled plugins, the selected theme, and other preferences |

Exclude downloaded plugin and theme files.

Use your vault’s configuration folder in place of `.obsidian` if you changed it.

### Git example

Add these rules to your vault’s `.gitignore`:

```gitignore
.obsidian/plugins/*/*
!.obsidian/plugins/*/data.json
!.obsidian/plugins/plugback-seed/*

.obsidian/themes/*
```

Ignore rules don’t untrack files already committed to Git.

To include an unlisted plugin, add an exception such as `!.obsidian/plugins/my-plugin/*`.

## Sync behavior

- Installing or removing a community plugin or theme in Obsidian updates the saved list.
- Plugback doesn’t update installed plugins and themes or synchronize their versions.
- Plugback and Plugback Seed are excluded from the list.

Plugins are identified by their community plugin IDs; themes by their community theme names. Unlisted plugins and themes are left alone.

Modified plugins and themes with the original community ID or name are still managed by Plugback. It removes them if they’re absent from your sync list, and repairs can overwrite your modifications. Use a different, unlisted plugin ID or theme name to keep them outside Plugback’s control.

To sync an unlisted plugin or theme, include its files in vault sync yourself.

## Combining existing setups

If your devices were set up separately, combine their plugin and theme lists before syncing `data.json` between them.

1. Enable Plugback on each device while it still has its own setup. With no existing list, Plugback records that device’s installed community plugins and themes.
2. Collect each device’s `.obsidian/plugins/plugback/data.json`. Combine the entries in the `plugins` and `themes` arrays, removing duplicates.
3. Sync the combined file to all devices.

To include locally installed plugins and themes in a device’s current list, select **Add** under **Add from this device** in Plugback’s settings. Existing entries are kept. Do this before collecting the lists or letting another device’s list replace yours.

## Recovery

Plugback keeps unsynced installs and removals on the device and retries them after a restart. Invalid data, unresolved conflicts, or a missing list on an already initialized device stop sync.

Resolve the conflict or restore `.obsidian/plugins/plugback/data.json`, then select **Check now** in Plugback settings. Edits made on multiple devices can require manually combining the plugin and theme entries.

Errors appear in settings or notices, with full details in the console.

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
