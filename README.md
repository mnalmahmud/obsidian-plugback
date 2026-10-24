# Plugback

Plugback synchronizes installed Obsidian community plugins and themes across devices without tracking their downloaded files in Git.

## How it works

Plugback records which community plugins and themes to sync in `.obsidian/plugins/plugback/data.json`. Installing or removing a plugin or theme in Obsidian updates this file automatically.

### First device
1. Install and enable Plugback.
2. Plugback automatically creates, maintains, and enables **Plugback Seed** (`.obsidian/plugins/plugback-seed/`).
3. Commit and push your vault. Git synchronizes the seed, your settings, and `data.json`.

### Additional devices
1. Clone or sync the vault.
2. Enable community plugins in Obsidian settings.
3. Obsidian loads Plugback Seed, which downloads and enables Plugback if it is missing.
4. Plugback installs your tracked community plugins and themes automatically.

## Network use

Plugback uses the network to query official community directories and download community plugins and themes. Synchronization of the shared data file (`data.json`) between devices is handled separately by your sync or Git tool. It makes automatic HTTPS requests to GitHub for:

- **Community directories**: Fetching Obsidian's official lists of community plugins and themes to verify directory membership.
- **Extension metadata and compatibility**: Fetching public manifests and version compatibility information from official plugin and theme repositories on `raw.githubusercontent.com` and `github.com`.
- **Installation**: Delegating to Obsidian's built-in plugin and theme managers to download missing community extensions from their GitHub repositories.
- **Plugback bootstrap**: Plugback Seed checks the Plugback GitHub release and installs Plugback when it is missing or incomplete.

These requests check directory membership, compatibility, and install missing extensions.

## Git setup

Add the following to your vault's `.gitignore`:

```gitignore
.obsidian/plugins/*/*
!.obsidian/plugins/*/data.json
!.obsidian/plugins/plugback-seed/*

.obsidian/themes/*
```

With these rules:
- Git tracks each plugin's settings (`data.json`) and the files in `plugback-seed/`. The seed’s `main.js` is minified.
- Git ignores downloaded plugin code and theme files.
- Plugback Seed downloads Plugback when needed. Plugback keeps the seed updated and excludes it from sync.

Unlisted plugins and themes (whose IDs or names are not registered in Obsidian's official community directory, such as custom plugins, BRAT installations, or forks with custom IDs) are unmanaged: Plugback ignores them and never uninstalls them. If an extension shares an official community directory ID or theme name, it is treated as managed by Plugback. If a listed extension's files are modified locally and that extension is subsequently removed from `data.json`, Plugback manages it via Obsidian's uninstaller. To protect custom extensions or forks from uninstallation, give them an unlisted custom ID or name. To track an unlisted local plugin or theme in Git, unignore its folder (for example, `!.obsidian/plugins/my-plugin/*`).

## Synchronization and recovery

Local install/remove intent is stored on each device and replayed after a restart. Updates to `data.json` are saved through Obsidian's atomic read-modify-write API. Invalid JSON, unresolved merge conflicts, and missing data on an initialized device stop synchronization.

Git or your sync tool still handles concurrent edits between devices. Resolve its conflicts before checking again. Finish syncing a cloned vault before first startup. Plugback follows an existing valid `data.json`, including on a new device: missing extensions are installed and managed local extras are removed. Empty plugin and theme arrays remove all managed extensions.

Plugback synchronizes installation presence, not versions. Complete existing installations keep their versions; plugin enabled settings and the active theme remain controlled by Obsidian's settings.

## Combining independently configured devices

Select **Add local extensions** in Plugback settings to include this device's installed community plugins and themes in sync. Existing entries in `data.json` are kept; unlisted extensions remain unmanaged. Commit and sync the updated file with Git.

At startup, Plugback follows `data.json`. If the file does not exist on a new device, Plugback creates it from that device’s installed community extensions.

## Development

Use Node.js 26 or newer and pnpm. CI uses Node.js 26 and pnpm 10.

Install dependencies from the committed lockfile:

```bash
pnpm install --frozen-lockfile
```

| Command | Purpose |
| --- | --- |
| `pnpm run dev` | Watch source files and rebuild `main.js` during development |
| `pnpm run build` | Typecheck and create the production `main.js` bundle |
| `pnpm run check` | Check release metadata, types, lint, production bundling, and tests |
| `pnpm run test` | Rebuild the production bundle and run the tests |

For manual testing, build the project and copy or symlink `main.js`, `manifest.json`, and `styles.css` into your vault's `.obsidian/plugins/plugback/` directory, then enable or reload Plugback in Obsidian. Adjust the path if your vault uses a different configuration directory.

The six files in `src/` cover startup (`main.ts`), synchronization (`core.ts`), data and storage (`data.ts`), Obsidian integration (`host.ts`), release lookup (`registry.ts`), and settings (`ui.ts`). Tests follow the same layout. `seed/main.js` is readable source; the build minifies it before embedding it in Plugback.

## License

[MIT](LICENSE)
