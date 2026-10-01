import { ItemView, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import type { MagicNotesPlugin } from '../main';
import type { SubtopicMeta } from '../types';
import { SubtopicPanel } from './subtopic-panel';

export const VIEW_TYPE_TOPIC_DETAIL = 'magicnotes-topic-detail';

interface DetailState {
	topic?: string;
	selectedSubtopic?: string;
}

export class TopicDetailView extends ItemView {
	plugin: MagicNotesPlugin;
	private searchEl: HTMLInputElement | null = null;
	private listEl: HTMLElement | null = null;
	private panel: SubtopicPanel | null = null;
	private panelHostEl: HTMLElement | null = null;
	private unsubscribe: (() => void) | null = null;
	private topic: string | null = null;
	private selectedSubtopic: string | null = null;
	private listQuery = '';

	constructor(leaf: WorkspaceLeaf, plugin: MagicNotesPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_TOPIC_DETAIL;
	}

	getDisplayText(): string {
		return this.topic ?? 'Topic detail';
	}

	getIcon(): string {
		return 'brain';
	}

	getState(): Record<string, unknown> {
		return {
			topic: this.topic ?? undefined,
			selectedSubtopic: this.selectedSubtopic ?? undefined,
		};
	}

	setState(state: unknown, _result: ViewStateResult): Promise<void> {
		const s = state as DetailState;
		if (s.topic) {
			void this.setTopic(s.topic, s.selectedSubtopic);
		}
		return Promise.resolve();
	}

	async onOpen(): Promise<void> {
		const el = this.contentEl;
		el.empty();
		el.addClass('m2-detail');

		this.searchEl = el.createEl('input', {
			cls: 'm2-search',
			type: 'text',
			placeholder: 'Search subtopics…',
		});
		this.searchEl.addEventListener('input', () => {
			this.listQuery = this.searchEl?.value ?? '';
			this.renderList();
		});
		this.listEl = el.createDiv({ cls: 'm2-subtopic-list' });
		this.panelHostEl = el.createDiv({ cls: 'm2-subtopic-panel-host' });
		this.panel = new SubtopicPanel(this.plugin, this.panelHostEl, this);

		this.unsubscribe = this.plugin.kb.subscribe(() => this.renderList());

		if (this.topic) {
			await this.renderTopic();
		}
	}

	onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		return Promise.resolve();
	}

	setTopic(topic: string, selectedSubtopic?: string): void {
		this.topic = topic;
		this.selectedSubtopic = selectedSubtopic ?? null;
		void this.renderTopic();
	}

	private async renderTopic(): Promise<void> {
		if (!this.topic) return;
		this.renderList();
		if (this.selectedSubtopic) {
			this.openSubtopicPanel(this.selectedSubtopic);
		}
	}

	private renderList(): void {
		const list = this.listEl;
		if (!list || !this.topic) return;
		const topic = this.plugin.kb.getTopic(this.topic);
		list.empty();
		if (!topic) {
			list.createDiv({ cls: 'm2-empty', text: 'Topic not found.' });
			return;
		}
		const subs = this.plugin.kb.searchSubtopics(this.topic, this.listQuery);
		if (subs.length === 0) {
			list.createDiv({ cls: 'm2-empty', text: 'No subtopics.' });
			return;
		}
		for (const st of subs) {
			const row = list.createDiv({ cls: 'm2-subtopic-row' });
			row.toggleClass('m2-selected', st.path === this.selectedSubtopic);
			row.createDiv({ cls: 'm2-subtopic-name', text: st.name });
			if (st.summary) row.createDiv({ cls: 'm2-subtopic-summary', text: st.summary });
			row.addEventListener('click', () => this.selectSubtopic(st));
		}
	}

	private selectSubtopic(st: SubtopicMeta): void {
		this.selectedSubtopic = st.path;
		this.renderList();
		this.openSubtopicPanel(st.path);
	}

	private openSubtopicPanel(path: string): void {
		const st = this.plugin.kb.getSubtopic(path);
		if (!st || !this.panel) return;
		void this.panel.render(st);
	}
}
