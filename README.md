# Plugback

Keep your Obsidian plugins and themes in sync across devices.

Plugback saves your community plugin and theme list in `.obsidian/plugins/plugback/data.json`. Your existing vault sync carries that list and your settings between devices. Plugback installs or removes plugins and themes to match the list, so their downloaded files can stay out of vault sync.

Requires Obsidian **1.8.7 or newer**.

## Setup

### First device

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/mnalmahmud/obsidian-plugback/releases/latest).
2. Place them in `.obsidian/plugins/plugback/` in your vault.
3. Configure the [sync exclusions](#sync-exclusions), then enable Plugback in Obsidian’s community plugin settings.
4. Let your vault finish syncing before setting up another device.

When there’s no saved list, Plugback creates one from this device’s installed community plugins and themes.

Plugback also creates and enables **Plugback Seed**, a small loader in `.obsidian/plugins/plugback-seed/`. Keep its files in vault sync. It downloads and enables Plugback on devices where Plugback’s code is missing.

### Additional devices

1. Let the vault finish syncing before opening it in Obsidian.
2. Enable community plugins if Obsidian asks.
3. Plugback Seed downloads Plugback. Plugback installs the plugins and themes in the saved list.

An existing list determines what gets installed. Locally installed community plugins and themes absent from that list are removed. If you’re combining independently configured devices, follow [Combining existing setups](#combining-existing-setups) before syncing their lists.

## Sync exclusions

Include these files in vault sync:

| Files                               | Purpose                                                    |
| ----------------------------------- | ---------------------------------------------------------- |
| `.obsidian/plugins/*/data.json`     | Plugin settings, including Plugback’s list                 |
| `.obsidian/plugins/plugback-seed/*` | The loader for setting up additional devices               |
| Other Obsidian settings             | Enabled plugins, the selected theme, and other preferences |

Exclude downloaded plugin code and theme files. Plugback installs them on each device.

Use your vault’s configuration folder in place of `.obsidian` if you changed it. Make sure excluded files are no longer being synced; exclusions may leave previously synced files in place.

### Git example

Add these rules to your vault’s `.gitignore`:

```gitignore
.obsidian/plugins/*/*
!.obsidian/plugins/*/data.json
!.obsidian/plugins/plugback-seed/*

.obsidian/themes/*
```

These rules keep plugin settings, Plugback’s list, and the seed’s files while excluding downloaded plugin code and themes. Ignore rules don’t untrack files already committed to Git.

To include an unlisted plugin, add an exception such as `!.obsidian/plugins/my-plugin/*`.

## Sync behavior

- Installing or removing a community plugin or theme in Obsidian updates the saved list.
- Complete installations keep their versions. Plugback doesn’t update installed plugins and themes or synchronize their versions.
- Enabled plugins and the selected theme follow Obsidian’s settings.
- Empty plugin and theme arrays in `data.json` remove all managed plugins and themes.
- Plugback and Plugback Seed are excluded from the list.

Plugins are identified by their community plugin IDs; themes by their community theme names. Unlisted plugins and themes are left alone. A fork or locally modified plugin or theme that uses an official ID or name is still managed by Plugback.

To sync an unlisted plugin or theme, include its files in vault sync yourself.

## Combining existing setups

If your devices already have different plugins and themes installed, initialize Plugback on each device before exchanging their lists. Combine the plugin and theme entries from their `data.json` files into one list, then sync it to all devices.

**Add from this device → Add** includes this device’s installed community plugins and themes while keeping entries already in the list. Use it before another device’s list replaces yours; once that list arrives, normal sync removes managed plugins and themes absent from it.

## Recovery

Plugback keeps unsynced installs and removals on the device and retries them after a restart. Invalid data, unresolved conflicts, or a missing list on an already initialized device stop sync.

Resolve the conflict or restore `.obsidian/plugins/plugback/data.json`, then select **Check now** in Plugback settings. Edits made on multiple devices can require manually combining the plugin and theme entries.

Errors appear in settings or notices, with full details in the console.

## Network use

Plugback downloads community directories and plugin and theme information from their repositories. Downloads of plugin and theme files use Obsidian’s installers. Plugback Seed downloads Plugback from its published releases.

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
