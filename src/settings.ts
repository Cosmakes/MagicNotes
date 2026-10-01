import { App, Notice, PluginSettingTab, Setting, requestUrl } from 'obsidian';
import MagicNotesPlugin from './main';
import type { Verbosity } from './types';

export type SplitSide = 'right' | 'left' | 'top' | 'bottom';
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high';

export interface MagicNotesSettings {
	llm: {
		baseUrl: string;
		apiKey: string;
		model: string;
		reasoningEffort: ReasoningEffort;
		maxTokens: number;
		temperature: number;
	};
	knowledgeBaseFolder: string;
	baseNotesFolder: string;
	ingestPanelSplit: SplitSide;
	chatPanelSplit: SplitSide;
	ingestVerbosity: Verbosity;
	pdfVerbosity: Verbosity;
}

export const DEFAULT_SETTINGS: MagicNotesSettings = {
	llm: {
		baseUrl: 'https://api.openai.com/v1',
		apiKey: '',
		model: '',
		reasoningEffort: 'off',
		maxTokens: 4096,
		temperature: 0.2,
	},
	knowledgeBaseFolder: 'MapTheMind',
	baseNotesFolder: 'BaseNotes',
		ingestPanelSplit: 'right',
		chatPanelSplit: 'right',
		ingestVerbosity: 'balanced',
		pdfVerbosity: 'balanced',
	};

const REASONING_EFFORT_OPTIONS: Record<ReasoningEffort, string> = {
	off: 'off',
	low: 'low',
	medium: 'medium',
	high: 'high',
};

const SPLITS_OPTIONS: Record<SplitSide, string> = {
	right: 'right',
	left: 'left',
	top: 'top',
	bottom: 'bottom',
};

const VERBOSITY_OPTIONS: Record<Verbosity, string> = {
	concise: 'concise',
	balanced: 'balanced',
	detailed: 'detailed',
};

export class MagicNotesSettingTab extends PluginSettingTab {
	plugin: MagicNotesPlugin;

	constructor(app: App, plugin: MagicNotesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('LLM')
			.setDesc(
				'OpenAI-compatible endpoint. Must include the API version path (e.g. HTTPS://api.OpenAI.com/v1).',
			);
		new Setting(containerEl)
			.setName('Base URL')
			.setDesc('Full chat-completions base URL.')
			.addText((text) =>
				text
					.setPlaceholder('HTTPS://api.OpenAI.com/v1')
					.setValue(this.plugin.settings.llm.baseUrl)
					.onChange(async (value) => {
						this.plugin.settings.llm.baseUrl = value;
						await this.plugin.saveSettings();
					}),
			);
		new Setting(containerEl)
			.setName('API key')
			.setDesc('Stored locally in data.json only. Sent only to the configured base URL.')
			.addText((text) => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder('Your API key')
					.setValue(this.plugin.settings.llm.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.llm.apiKey = value;
						await this.plugin.saveSettings();
					});
			});
		new Setting(containerEl)
			.setName('Model')
			.setDesc('Model name sent to the endpoint.')
			.addText((text) =>
				text
					.setPlaceholder('GPT-4o-mini')
					.setValue(this.plugin.settings.llm.model)
					.onChange(async (value) => {
						this.plugin.settings.llm.model = value;
						await this.plugin.saveSettings();
					}),
			);
		new Setting(containerEl)
			.setName('Reasoning effort')
			.setDesc('Sent as reasoning_effort when not "off".')
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(REASONING_EFFORT_OPTIONS)
					.setValue(this.plugin.settings.llm.reasoningEffort)
					.onChange(async (value) => {
						this.plugin.settings.llm.reasoningEffort = value as ReasoningEffort;
						await this.plugin.saveSettings();
					}),
			);
		new Setting(containerEl)
			.setName('Max tokens')
			.setDesc('Maximum tokens per completion.')
			.addText((text) =>
				text
					.setPlaceholder('4096')
					.setValue(String(this.plugin.settings.llm.maxTokens))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						this.plugin.settings.llm.maxTokens = Number.isFinite(n) && n > 0 ? n : 4096;
						await this.plugin.saveSettings();
					}),
			);
		new Setting(containerEl)
			.setName('Temperature')
			.addText((text) =>
				text
					.setPlaceholder('0.2')
					.setValue(String(this.plugin.settings.llm.temperature))
					.onChange(async (value) => {
						const n = parseFloat(value);
						this.plugin.settings.llm.temperature = Number.isFinite(n) ? n : 0.2;
						await this.plugin.saveSettings();
					}),
			);
		new Setting(containerEl)
			.setName('Test connection')
			.setDesc('Sends a one-token chat request to the configured endpoint.')
			.addButton((button) =>
				button
					.setButtonText('Test connection')
					.setDisabled(!this.isLlmConfigured())
					.onClick(async () => {
						await this.testConnection();
					}),
			);

		new Setting(containerEl).setName('Folders').setHeading();
		new Setting(containerEl)
			.setName('Knowledge base folder')
			.setDesc('Where topics are stored. Renaming affects future operations only.')
			.addText((text) =>
				text
					.setPlaceholder('MapTheMind')
					.setValue(this.plugin.settings.knowledgeBaseFolder)
					.onChange(async (value) => {
						this.plugin.settings.knowledgeBaseFolder = value.trim() || 'MapTheMind';
						await this.plugin.saveSettings();
					}),
			);
		new Setting(containerEl)
			.setName('Base notes folder')
			.setDesc('Where ingested source notes are archived.')
			.addText((text) =>
				text
					.setPlaceholder('BaseNotes')
					.setValue(this.plugin.settings.baseNotesFolder)
					.onChange(async (value) => {
						this.plugin.settings.baseNotesFolder = value.trim() || 'BaseNotes';
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName('LLM verbosity').setHeading();
		new Setting(containerEl)
			.setName('Ingest verbosity')
			.setDesc('Controls length and detail of classification, drafting, and edits.')
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(VERBOSITY_OPTIONS)
					.setValue(this.plugin.settings.ingestVerbosity)
					.onChange(async (value) => {
						this.plugin.settings.ingestVerbosity = value as Verbosity;
						await this.plugin.saveSettings();
					}),
			);
		new Setting(containerEl)
			.setName('PDF chat verbosity')
			.setDesc('Controls length and detail of chat answers.')
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(VERBOSITY_OPTIONS)
					.setValue(this.plugin.settings.pdfVerbosity)
					.onChange(async (value) => {
						this.plugin.settings.pdfVerbosity = value as Verbosity;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName('Panels').setHeading();
		new Setting(containerEl)
			.setName('Ingest panel split')
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(SPLITS_OPTIONS)
					.setValue(this.plugin.settings.ingestPanelSplit)
					.onChange(async (value) => {
						this.plugin.settings.ingestPanelSplit = value as SplitSide;
						await this.plugin.saveSettings();
					}),
			);
		new Setting(containerEl)
			.setName('Chat panel split')
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(SPLITS_OPTIONS)
					.setValue(this.plugin.settings.chatPanelSplit)
					.onChange(async (value) => {
						this.plugin.settings.chatPanelSplit = value as SplitSide;
						await this.plugin.saveSettings();
					}),
			);
	}

	private isLlmConfigured(): boolean {
		const s = this.plugin.settings.llm;
		return s.baseUrl.length > 0 && s.apiKey.length > 0 && s.model.length > 0;
	}

	private async testConnection(): Promise<void> {
		const s = this.plugin.settings.llm;
		if (!this.isLlmConfigured()) {
			new Notice('Configure base URL, API key and model first.');
			return;
		}
		try {
			await requestUrl({
				url: `${s.baseUrl.replace(/\/$/, '')}/chat/completions`,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${s.apiKey}`,
				},
				body: JSON.stringify({
					model: s.model,
					messages: [{ role: 'user', content: 'ping' }],
					max_tokens: 1,
					temperature: 0,
				}),
			});
			new Notice('LLM connection OK.');
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (msg.includes('401')) {
				new Notice('LLM connection failed: Invalid API key.');
			} else if (msg.includes('404')) {
				new Notice('LLM connection failed: Model not found at this base URL.');
			} else if (msg.includes('429')) {
				new Notice('LLM connection failed: Rate limited.');
			} else {
				new Notice(`LLM connection failed: ${msg}`);
			}
		}
	}
}
