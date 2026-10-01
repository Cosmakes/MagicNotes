import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'.kilo',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		rules: {
			// The declarative settings API (getSettingDefinitions) is not available in the
			// obsidian types for the minAppVersion 1.7.2 this plugin targets.
			'obsidianmd/settings-tab/prefer-setting-definitions': 'off',
			'obsidianmd/ui/sentence-case': [
				'warn',
				{
					enforceCamelCaseLower: true,
					brands: [
						'MagicNotes',
						'MapTheMind',
						'BaseNotes',
						'NeuroMorpho',
						'Allen',
						'OpenAI',
						'GPT',
						'Markdown',
					],
				},
			],
		},
	},
);
