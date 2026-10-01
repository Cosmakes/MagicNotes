import { ItemView, Notice, TFile, type WorkspaceLeaf } from 'obsidian';
import { extractPdfText, totalTextLength, type PageTextMap } from '../pdf/extract';
import { isLlmConfigured } from '../llm/client';
import { answerPdfQuestion, selectPdfPages } from '../llm/prompts';
import type { IngestChatTurn } from '../types';
import type MagicNotesPlugin from '../main';

export const VIEW_TYPE_PDF_CHAT = 'magicnotes-pdf-chat';

// Total PDF text length (chars) below which a single answer call is used.
const SINGLE_CALL_BUDGET = 24000;
const MAX_STORED_TURNS = 12;

export class PdfChatView extends ItemView {
	plugin: MagicNotesPlugin;
	private boundFile: TFile | null = null;
	private history: IngestChatTurn[] = [];
	private busy = false;
	private stopped = false;
	private messagesEl: HTMLElement | null = null;
	private pdfNameEl: HTMLElement | null = null;
	private inputEl: HTMLTextAreaElement | null = null;
	private sendBtn: HTMLButtonElement | null = null;
	private stopBtn: HTMLButtonElement | null = null;
	private textCache: { key: string; pages: PageTextMap } | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: MagicNotesPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_PDF_CHAT;
	}

	getDisplayText(): string {
		return 'Ask about PDF';
	}

	getIcon(): string {
		return 'bot';
	}

	async onOpen(): Promise<void> {
		const el = this.contentEl;
		el.empty();
		el.addClass('m2-chat');

		const headerRow = el.createDiv({ cls: 'm2-chat-header' });
		this.pdfNameEl = headerRow.createDiv({ cls: 'm2-chat-pdf-name' });
		headerRow
			.createEl('button', { cls: 'm2-chat-clear', text: 'Clear' })
			.addEventListener('click', () => this.clearConversation());

		this.messagesEl = el.createDiv({ cls: 'm2-chat-messages' });

		const inputRow = el.createDiv({ cls: 'm2-chat-input-row' });
		this.inputEl = inputRow.createEl('textarea', {
			cls: 'm2-chat-input',
			attr: { rows: '2', placeholder: 'Ask about this PDF…' },
		});
		this.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this.send();
			}
		});
		this.sendBtn = inputRow.createEl('button', { text: 'Send', cls: 'mod-cta' });
		this.sendBtn.addEventListener('click', () => this.send());
		this.stopBtn = inputRow.createEl('button', { text: 'Stop', cls: 'mod-warning' });
		this.stopBtn.hide();
		this.stopBtn.addEventListener('click', () => this.stop());

		this.registerEvent(
			this.plugin.app.workspace.on('active-leaf-change', () => this.rebind()),
		);

		this.rebind();
		this.renderMessages();
	}

	onClose(): Promise<void> {
		return Promise.resolve();
	}

	// The PDF the user is currently viewing, in whichever viewer it is open
	// in (Obsidian's native PDF view or a plugin such as PDF++).
	private findPdfFile(): TFile | null {
		const app = this.plugin.app;
		const active = app.workspace.getActiveFile();
		if (active instanceof TFile && active.extension === 'pdf') return active;
		for (const leaf of app.workspace.getLeavesOfType('pdf')) {
			const f = (leaf.view as { file?: TFile | null }).file;
			if (f instanceof TFile) return f;
		}
		return null;
	}

	bindToFile(file: TFile): void {
		this.boundFile = file;
		this.renderBinding();
	}

	// Extract the PDF's text, caching per file+mtime so follow-up questions
	// don't re-parse the document.
	private async getPageText(file: TFile): Promise<PageTextMap> {
		const key = `${file.path}@${file.stat?.mtime ?? 0}`;
		if (this.textCache && this.textCache.key === key) return this.textCache.pages;
		const pages = await extractPdfText(this.plugin.app, file);
		this.textCache = { key, pages };
		return pages;
	}

	private rebind(): void {
		const file = this.findPdfFile();
		if (file) this.boundFile = file;
		this.renderBinding();
	}

	private renderBinding(): void {
		const nameEl = this.pdfNameEl;
		if (!nameEl) return;
		const file = this.boundFile;
		nameEl.setText(file ? file.name : 'No PDF open');
	}

	private clearConversation(): void {
		this.history = [];
		this.renderMessages();
	}

	private renderMessages(): void {
		const el = this.messagesEl;
		if (!el) return;
		el.empty();
		if (this.history.length === 0) {
			el.createDiv({
				cls: 'm2-empty',
				text: 'Ask a question about the open PDF. Answers are grounded only in the PDF text and cite pages as [pN].',
			});
			return;
		}
		for (const turn of this.history) {
			const row = el.createDiv({ cls: `m2-msg m2-msg-${turn.role}` });
			row.createDiv({ cls: 'm2-msg-role', text: turn.role === 'user' ? 'You' : 'Assistant' });
			const body = row.createDiv({ cls: 'm2-msg-body' });
			if (turn.role === 'assistant') {
				this.renderAnswer(body, turn.content);
			} else {
				body.setText(turn.content);
			}
		}
		el.scrollTop = el.scrollHeight;
	}

	private renderAnswer(el: HTMLElement, text: string): void {
		const re = /\[p(\d+)\]/g;
		let last = 0;
		let m = re.exec(text);
		while (m) {
			if (m.index > last) el.createSpan({ text: text.slice(last, m.index) });
			const n = Number(m[1]);
			const chip = el.createSpan({ cls: 'm2-page-chip', text: `page ${n}` });
			chip.addEventListener('click', () => {
				this.plugin.jumpPdfToPage(n);
			});
			last = m.index + m[0].length;
			m = re.exec(text);
		}
		if (last < text.length) el.createSpan({ text: text.slice(last) });
	}

	private setBusy(busy: boolean): void {
		this.busy = busy;
		if (this.sendBtn) this.sendBtn.disabled = busy;
		if (this.stopBtn) {
			if (busy) this.stopBtn.show();
			else this.stopBtn.hide();
		}
		if (this.inputEl) this.inputEl.disabled = busy;
	}

	private stop(): void {
		// requestUrl has no abort handle: discard the in-flight response.
		this.stopped = true;
	}

	private send(): void {
		const input = this.inputEl;
		if (!input || this.busy) return;
		const question = input.value.trim();
		if (question.length === 0) return;
		const file = this.boundFile ?? this.findPdfFile();
		if (!file) {
			new Notice('Open a PDF first.');
			return;
		}
		this.boundFile = file;
		if (!isLlmConfigured(this.plugin.settings.llm)) {
			new Notice('Configure the LLM in settings first.');
			return;
		}
		input.value = '';
		this.history.push({ role: 'user', content: question });
		this.renderMessages();
		this.setBusy(true);
		this.stopped = false;
		void this.answer(question, file);
	}

	private async answer(question: string, file: TFile): Promise<void> {
		try {
			const pages = await this.getPageText(file);
			if (pages.size === 0) {
				this.finish('No extractable text in this PDF (scanned document?).', true);
				return;
			}
			let selected: number[];
			if (totalTextLength(pages) <= SINGLE_CALL_BUDGET) {
				selected = Array.from(pages.keys()).sort((a, b) => a - b);
			} else {
				selected = await selectPdfPages(this.plugin.settings.llm, question, pages);
			}
			// Exclude the question just pushed so it is not duplicated in context.
			const priorHistory = this.history.slice(0, -1);
			const answerText = await answerPdfQuestion(
				this.plugin.settings.llm,
				question,
				pages,
				selected,
				priorHistory,
				this.plugin.settings.pdfVerbosity,
			);
			if (this.stopped) return;
			this.finish(answerText, false);
		} catch (e) {
			if (this.stopped) return;
			this.finish(
				`Sorry, the LLM request failed: ${e instanceof Error ? e.message : String(e)}`,
				true,
			);
		} finally {
			this.setBusy(false);
			this.stopped = false;
		}
	}

	private finish(text: string, isError: boolean): void {
		this.history.push({ role: 'assistant', content: text });
		if (this.history.length > MAX_STORED_TURNS) {
			this.history = this.history.slice(-MAX_STORED_TURNS);
		}
		this.renderMessages();
		if (isError) new Notice(text);
	}
}
