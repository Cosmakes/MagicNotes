import { ItemView, type WorkspaceLeaf } from 'obsidian';
import type { MagicNotesPlugin } from '../main';
import type { TopicMeta } from '../types';
import { TopicDetailView } from './topic-detail';

export const VIEW_TYPE_TOPIC_ARCHIVE = 'magicnotes-topic-archive';

export class TopicArchiveView extends ItemView {
	plugin: MagicNotesPlugin;
	private searchEl: HTMLInputElement | null = null;
	private gridEl: HTMLElement | null = null;
	private query = '';
	private unsubscribe: (() => void) | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: MagicNotesPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_TOPIC_ARCHIVE;
	}

	getDisplayText(): string {
		return 'MagicNotes knowledge base';
	}

	getIcon(): string {
		return 'brain';
	}

	async onOpen(): Promise<void> {
		const el = this.contentEl;
		el.empty();
		el.addClass('m2-archive');
		this.searchEl = el.createEl('input', {
			cls: 'm2-search',
			type: 'text',
			placeholder: 'Search topics, subtopics…',
		});
		this.searchEl.addEventListener('input', () => {
			this.query = this.searchEl?.value ?? '';
			this.render();
		});
		this.gridEl = el.createDiv({ cls: 'm2-topic-grid' });
		this.unsubscribe = this.plugin.kb.subscribe(() => this.render());
		await this.plugin.kb.rebuild();
		this.render();
	}

	onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		return Promise.resolve();
	}

	private render(): void {
		const grid = this.gridEl;
		if (!grid) return;
		const topics = this.query
			? this.plugin.kb.searchTopics(this.query)
			: this.plugin.kb.getTopics();
		grid.empty();
		if (topics.length === 0) {
			grid.createDiv({
				cls: 'm2-empty',
				text:
					this.query.length > 0
						? 'No topics match your search.'
						: 'No topics yet. Open a note and press “Ingest into knowledge base”.',
			});
			return;
		}
		for (const topic of topics) {
			const card = grid.createDiv({ cls: 'm2-topic-card' });
			card.createDiv({ cls: 'm2-topic-name', text: topic.name });
			card.createDiv({
				cls: 'm2-topic-meta',
				text: `${topic.subtopics.length} subtopic${topic.subtopics.length === 1 ? '' : 's'}`,
			});
			const chips = card.createDiv({ cls: 'm2-chips' });
			for (const st of topic.subtopics.slice(0, 5)) {
				chips.createSpan({ cls: 'm2-chip', text: st.name });
			}
			if (topic.subtopics.length > 5) {
				chips.createSpan({
					cls: 'm2-chip m2-chip-more',
					text: `+${topic.subtopics.length - 5}`,
				});
			}
			card.addEventListener('click', () => {
				void this.openDetail(topic);
			});
		}
	}

	private async openDetail(topic: TopicMeta): Promise<void> {
		const leaf = this.app.workspace.getLeaf('split', 'horizontal');
		const view = (await leaf.open(new TopicDetailView(leaf, this.plugin))) as TopicDetailView;
		view.setTopic(topic.name);
	}
}
