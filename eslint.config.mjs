import js from "@eslint/js";
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default tseslint.config(
	{
		ignores: ["node_modules/**", "main.js", "*.mjs", "tests/**/*.cjs"],
	},
	js.configs.recommended,
	...tseslint.configs.recommendedTypeChecked,
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts", "tests/**/*.ts"],
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node,
				activeDocument: "readonly",
				activeWindow: "readonly",
				__SEED_MANIFEST_TEXT__: "readonly",
				__SEED_MAIN_JS_TEXT__: "readonly",
			},
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			// Plugback has no configurable settings to index; the tab renders published status snapshots and supports Obsidian >= 1.8.7.
			"obsidianmd/settings-tab/prefer-setting-definitions": "off",
			// `setWarning()` and `display()` are the supported APIs for minAppVersion 1.8.7 (replacements require 1.13.0).
			"@typescript-eslint/no-deprecated": "off",
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
		},
	},
	{
		files: ["scripts/**/*.mjs"],
		...tseslint.configs.disableTypeChecked,
		languageOptions: { globals: globals.node },
		rules: {
			...tseslint.configs.disableTypeChecked.rules,
			"obsidianmd/no-nodejs-modules": "off",
		},
	},
	{
		files: ["seed/**/*.js"],
		...tseslint.configs.disableTypeChecked,
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.commonjs,
			},
		},
		rules: {
			...tseslint.configs.disableTypeChecked.rules,
			"@typescript-eslint/no-require-imports": "off",
		},
	},
	{
		files: ["tests/**/*.ts"],
		rules: {
			"obsidianmd/no-nodejs-modules": "off",
			"obsidianmd/hardcoded-config-path": "off",
			"obsidianmd/no-global-this": "off",
			"obsidianmd/prefer-window-timers": "off",
		},
	},
);
