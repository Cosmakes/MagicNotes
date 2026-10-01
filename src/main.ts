import { Notice, Plugin, TFile, type SplitDirection } from 'obsidian';
import {
	DEFAULT_SETTINGS,
	MagicNotesSettings,
	MagicNotesSettingTab,
	type SplitSide,
} from './settings';
import { KbIndexManager } from './kb/index';
import { subtopicPath } from './kb/paths';
import { KbWriter } from './kb/writer';
import { registerHeaderButton, registerPdfHeaderButton } from './ui/header-button';
import type { IngestState } from './types';
import { IngestPanelView, VIEW_TYPE_INGEST_PANEL } from './views/ingest-panel';
import { PdfChatView, VIEW_TYPE_PDF_CHAT } from './views/chat-panel';
import { TopicArchiveView, VIEW_TYPE_TOPIC_ARCHIVE } from './views/topic-archive';
import { TopicDetailView, VIEW_TYPE_TOPIC_DETAIL } from './views/topic-detail';

// pdf.js v4 relies on Promise.withResolvers (ES2024); polyfill for older
// Electron runtimes so the worker can load anywhere.
interface PromiseWithResolversLocal<T> {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
}
const PromiseCtor = Promise as unknown as {
	withResolvers?: () => PromiseWithResolversLocal<unknown>;
};
if (typeof PromiseCtor.withResolvers !== 'function') {
	PromiseCtor.withResolvers = function () {
		let resolve: (value: unknown) => void = () => undefined;
		let reject: (reason?: unknown) => void = () => undefined;
		const promise = new Promise<unknown>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		return { promise, resolve, reject };
	};
}

export default class MagicNotesPlugin extends Plugin {
	settings!: MagicNotesSettings;
	kb!: KbIndexManager;
	writer!: KbWriter;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.writer = new KbWriter(this.app, () => ({
			knowledgeBaseFolder: this.settings.knowledgeBaseFolder,
			baseNotesFolder: this.settings.baseNotesFolder,
		}));
		this.kb = new KbIndexManager(
			this.app,
			() => this.settings.knowledgeBaseFolder,
			(evt) => this.registerEvent(evt),
		);

		this.registerView(VIEW_TYPE_TOPIC_ARCHIVE, (leaf) => new TopicArchiveView(leaf, this));
		this.registerView(VIEW_TYPE_TOPIC_DETAIL, (leaf) => new TopicDetailView(leaf, this));
		this.registerView(VIEW_TYPE_INGEST_PANEL, (leaf) => new IngestPanelView(leaf, this));
		this.registerView(VIEW_TYPE_PDF_CHAT, (leaf) => new PdfChatView(leaf, this));

		this.addRibbonIcon('brain', 'MagicNotes knowledge base', () => {
			void this.app.workspace
				.ensureSideLeaf(VIEW_TYPE_TOPIC_ARCHIVE, 'left', { reveal: true })
				.catch((e) => {
					console.warn('[magicnotes] failed to open archive view:', e);
				});
		});

		this.addCommand({
			id: 'ingest-active-note',
			name: 'Ingest active note into knowledge base',
			checkCallback: () => this.activeMarkdownFile() !== null,
			callback: () => this.startIngest(),
		});
		this.addCommand({
			id: 'ask-about-pdf',
			name: 'Ask about the open PDF',
			checkCallback: () => this.activePdfFile() !== null,
			callback: () => {
				const file = this.activePdfFile();
				if (!file) {
					new Notice('Open a PDF first.');
					return;
				}
				this.openChatPanelFor(file);
			},
		});

		registerHeaderButton(this);
		registerPdfHeaderButton(this);

		this.kb.start();
		this.addSettingTab(new MagicNotesSettingTab(this.app, this));
	}

	onunload(): void {}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<MagicNotesSettings>,
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private pluginDir(): string {
		return this.manifest.dir ?? '.';
	}

	private activeMarkdownFile(): TFile | null {
		const f = this.app.workspace.getActiveFile();
		return f instanceof TFile && f.extension === 'md' ? f : null;
	}

	private activePdfFile(): TFile | null {
		const f = this.app.workspace.getActiveFile();
		return f instanceof TFile && f.extension === 'pdf' ? f : null;
	}

	subtopicPathFor(topic: string, subtopic: string): string {
		return subtopicPath(this.settings.knowledgeBaseFolder, topic, subtopic);
	}

	// The split API only distinguishes vertical (new leaf to the right)
	// vs horizontal (new leaf below). 'left' falls back to the right.
	private splitDirection(side: SplitSide): SplitDirection {
		return side === 'left' || side === 'right' ? 'vertical' : 'horizontal';
	}

	startIngest(): void {
		const file = this.activeMarkdownFile();
		if (!file) {
			new Notice('Open a Markdown note first.');
			return;
		}
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_INGEST_PANEL);
		if (existing.length > 0) {
			const leaf = existing[0]!;
			const panel = leaf.view as IngestPanelView;
			void this.app.workspace.revealLeaf(leaf);
			panel.startIngest(file);
			return;
		}
		const leaf = this.app.workspace.getLeaf('split', this.splitDirection(this.settings.ingestPanelSplit));
		void leaf
			.open(new IngestPanelView(leaf, this))
			.then((view) => {
				(view as IngestPanelView).startIngest(file);
			})
			.catch((e) => {
				console.error('[magicnotes] failed to open ingest panel:', e);
				new Notice('MagicNotes: could not open the ingest panel. Check the console.');
			});
	}

	// Open a PDF in Obsidian's native viewer (or PDF++ if the user prefers it),
	// then best-effort scroll to a page. We deliberately do not ship our own
	// pdf.js renderer: the built-in viewer is more robust, and this plugin's
	// role is the "ask about the PDF" agent, not a second PDF viewer.
	async openPdfTarget(file: TFile, page?: number): Promise<void> {
		const leaf = this.app.workspace.getLeaf();
		if (!leaf) {
			new Notice('No leaf available to open the PDF.');
			return;
		}
		try {
			await leaf.openFile(file);
		} catch (e) {
			console.error('[magicnotes] failed to open PDF:', e);
			new Notice('MagicNotes: could not open this PDF. Check the console.');
			return;
		}
		if (page && page >= 1) {
			// Let the native viewer render before scrolling to the page.
			window.setTimeout(() => this.jumpPdfToPage(page), 400);
		}
	}

	// Scroll the native PDF view to a page. The built-in viewer renders
	// pdf.js pages (.page[data-page-number]) into a shadow DOM, so we reach it
	// via the view's pdfViewer handle or the element's `doc` (shadow-aware).
	jumpPdfToPage(page: number): void {
		const leaf = this.app.workspace.getLeavesOfType('pdf')[0];
		if (!leaf) return;
		// Make sure the PDF tab is visible so the jump is actually seen.
		void this.app.workspace.revealLeaf(leaf);
		const selector = `.page[data-page-number="${page}"]`;

		const view = leaf.view as {
			containerEl?: HTMLElement;
			pdfViewer?: { dom?: { viewerEl?: HTMLElement } };
		};

		const viewerEl = view.pdfViewer?.dom?.viewerEl;
		if (viewerEl) {
			const pageEl = viewerEl.querySelector(selector);
			if (pageEl instanceof HTMLElement) {
				pageEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
				return;
			}
		}

		const containerEl = view.containerEl;
		if (!containerEl) return;
		const pageEl =
			containerEl.doc?.querySelector?.(selector) ?? containerEl.querySelector(selector);
		if (pageEl instanceof HTMLElement) {
			pageEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
		}
	}

	openChatPanelFor(file?: TFile): void {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_PDF_CHAT);
		if (existing.length > 0) {
			const leaf = existing[0]!;
			if (file) (leaf.view as PdfChatView).bindToFile(file);
			void this.app.workspace.revealLeaf(leaf);
			return;
		}
		const leaf = this.app.workspace.getLeaf('split', this.splitDirection(this.settings.chatPanelSplit));
		void leaf
			.open(new PdfChatView(leaf, this))
			.then((v) => {
				if (file) (v as PdfChatView).bindToFile(file);
			})
			.catch((e) => {
				console.error('[magicnotes] failed to open chat panel:', e);
				new Notice('MagicNotes: could not open the chat panel. Check the console.');
			});
	}

	// ── Ingest state persistence ──────────────────────────────────────────────

	private ingestStatePath(): string {
		return `${this.pluginDir()}/data/ingest-state.json`;
	}

	async loadIngestState(): Promise<IngestState | null> {
		const adapter = this.app.vault.adapter;
		try {
			if (await adapter.exists(this.ingestStatePath())) {
				const raw = await adapter.read(this.ingestStatePath());
				const parsed = JSON.parse(raw) as IngestState;
				if (parsed && typeof parsed.sourcePath === 'string' && typeof parsed.step === 'string') {
					return parsed;
				}
			}
		} catch {
			// corrupt state file — treat as absent
		}
		return null;
	}

	async saveIngestState(state: IngestState): Promise<void> {
		const adapter = this.app.vault.adapter;
		try {
			await adapter.mkdir(`${this.pluginDir()}/data`);
			await adapter.write(this.ingestStatePath(), JSON.stringify(state));
		} catch {
			// persistence failure is non-fatal
		}
	}

	async clearIngestState(): Promise<void> {
		const adapter = this.app.vault.adapter;
		try {
			if (await adapter.exists(this.ingestStatePath())) {
				await adapter.remove(this.ingestStatePath());
			}
		} catch {
			// ignore
		}
	}
}

export type { MagicNotesPlugin };
