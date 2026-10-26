# Plugback

Sync Obsidian community plugins and themes across devices without committing downloaded code to Git.

Plugback records which plugins and themes to install in `.obsidian/plugins/plugback/data.json`. Git or your vault sync tool carries that file between devices. Plugback installs and removes extensions to match it.

Requires Obsidian **1.8.7 or newer**.

## Setup

### First device

1. Build Plugback using the [development instructions](#development).
2. Copy or symlink `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/plugback/` in your vault.
3. Add the [Git ignore rules](#git-setup) below, then enable Plugback in Obsidian.
4. Commit and push your vault, including your Obsidian settings and `data.json`.

If `data.json` doesn’t exist, Plugback creates it from this device's installed community plugins and themes.

Plugback also creates and enables **Plugback Seed** in `.obsidian/plugins/plugback-seed/`. The seed is a small, minified loader that downloads Plugback when its code is missing. Automatic setup on another device requires a published Plugback release on GitHub.

### Additional devices

1. Clone or sync the vault completely before opening it in Obsidian.
2. Enable community plugins if Obsidian asks.
3. Plugback Seed downloads and enables Plugback. Plugback then installs the plugins and themes recorded in `data.json`.

An existing `data.json` determines what gets installed, including on a new device. Community extensions installed locally but absent from that file are removed.

## Git setup

Add these rules to your vault's `.gitignore`:

```gitignore
.obsidian/plugins/*/*
!.obsidian/plugins/*/data.json
!.obsidian/plugins/plugback-seed/*

.obsidian/themes/*
```

Git keeps plugin settings, Plugback's `data.json`, and the seed's files. Downloaded plugin code and theme files are ignored. Your other Obsidian settings, including enabled plugins and the selected theme, should remain tracked.

Use your vault's configuration folder in place of `.obsidian` if you changed it. Ignore rules don’t untrack files already committed to Git.

## Sync behavior

- Installing or removing a community plugin or theme in Obsidian updates `data.json`.
- Existing complete installations keep their versions. Plugback doesn’t synchronize versions or update installed extensions.
- Enabled plugins and the selected theme follow Obsidian's settings.
- Empty plugin and theme arrays in `data.json` remove all managed extensions.
- Plugback and Plugback Seed are excluded from extension sync.

Plugback manages extensions by their identity in Obsidian's community directories: plugin ID or theme name. Unlisted plugins and themes are left alone. A fork or locally modified extension that uses an official ID or name is still managed. Use a custom, unlisted identity to keep it outside Plugback's control.

To keep an unlisted extension in Git, unignore its folder, for example `!.obsidian/plugins/my-plugin/*`.

### Combining existing setups

For independently configured devices, initialize Plugback on each before exchanging their `data.json` files, then merge those files with Git.

The **Add** button under **Add from this device** includes this device's installed community plugins and themes in sync while keeping existing entries. Use it before bringing in another device's `data.json`; once that file arrives, ordinary sync follows its contents and removes managed local extras.

### Recovery

Pending local installs and removals are saved on the device and retried after a restart. Invalid JSON, unresolved merge conflicts, or a missing `data.json` on an already initialized device stop sync.

Resolve conflicts or restore the file with your sync tool, then select **Check now** in Plugback settings. Git merges text, so concurrent edits to the JSON arrays can still require a manual merge.

## Network use

Plugback fetches community directories and extension metadata from `raw.githubusercontent.com` and `github.com`. Downloads use Obsidian's plugin and theme installers. Plugback Seed downloads Plugback from its GitHub releases.

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

For manual testing, install the build into a test vault using the setup steps above, then reload Plugback in Obsidian.

## License

[MIT](LICENSE)
