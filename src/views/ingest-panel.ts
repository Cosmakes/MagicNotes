import { ItemView, Notice, TFile, type WorkspaceLeaf } from 'obsidian';
import { parseFrontmatter } from '../kb/frontmatter';
import { isUnderFolder } from '../kb/paths';
import { reconcileReferences } from '../kb/references';
import { classifyNote, draftSubtopic, editDraft } from '../llm/prompts';
import type { IngestState, IngestSuggestion, IngestTarget, SubtopicMeta } from '../types';
import type { MagicNotesPlugin } from '../main';
import { renderLineDiff } from './diff-view';

export const VIEW_TYPE_INGEST_PANEL = 'magicnotes-ingest-panel';

const STEP_LABELS: Record<string, string> = {
	analyzing: 'Analyzing',
	choose: 'Choose target',
	drafting: 'Drafting',
	review: 'Review & edit',
	saving: 'Saving',
};

function ensureInlineSourceLink(body: string, sourcePath: string): string {
	const linkTarget = sourcePath.replace(/\.md$/i, '');
	const link = `[[${linkTarget}]]`;
	const escaped = linkTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const existing = new RegExp(`\\[\\[${escaped}(?:#[^\\]|]*)?(?:\\|[^\\]]*)?\\]\\]`, 'i');
	if (existing.test(body)) return body;

	const lines = body.split('\n');
	const insertIndex =
		lines.findIndex((line) => line.trim().length > 0 && !/^#{1,6}\s/.test(line)) !== -1
			? lines.findIndex((line) => line.trim().length > 0 && !/^#{1,6}\s/.test(line))
			: lines.findIndex((line) => line.trim().length > 0);
	if (insertIndex === -1) return `${link}\n`;
	lines[insertIndex] = `${lines[insertIndex]!.trimEnd()} (${link})`;
	return lines.join('\n');
}

export class IngestPanelView extends ItemView {
	plugin: MagicNotesPlugin;
	private state: IngestState | null = null;
	private sourceFile: TFile | null = null;
	private stepRowEl: HTMLElement | null = null;
	private contentHostEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private draftTextarea: HTMLTextAreaElement | null = null;
	private renderToken = 0;

	constructor(leaf: WorkspaceLeaf, plugin: MagicNotesPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_INGEST_PANEL;
	}

	getDisplayText(): string {
		return 'Ingest into knowledge base';
	}

	getIcon(): string {
		return 'sparkles';
	}

	async onOpen(): Promise<void> {
		const el = this.contentEl;
		el.empty();
		el.addClass('m2-ingest');
		this.stepRowEl = el.createDiv({ cls: 'm2-step-row' });
		this.statusEl = el.createDiv({ cls: 'm2-status' });
		this.contentHostEl = el.createDiv({ cls: 'm2-ingest-content' });

		const saved = await this.plugin.loadIngestState();
		if (saved) {
			const file = this.plugin.app.vault.getAbstractFileByPath(saved.sourcePath);
			if (file instanceof TFile) {
				this.renderResumeOffer(saved, file);
			} else {
				void this.plugin.clearIngestState();
				this.renderIdle();
			}
		} else {
			this.renderIdle();
		}
	}

	private renderIdle(): void {
		const host = this.contentHostEl;
		if (!host) return;
		host.empty();
		host.createDiv({
			cls: 'm2-empty',
			text: 'Open a note and press “Ingest into knowledge base” to start.',
		});
	}

	private renderResumeOffer(saved: IngestState, file: TFile): void {
		const host = this.contentHostEl;
		if (!host) return;
		host.empty();
		host.createDiv({
			cls: 'm2-empty',
			text: `A previous ingest of “${file.name}” was interrupted. Resume it?`,
		});
		const actions = host.createDiv({ cls: 'm2-modal-actions' });
		actions
			.createEl('button', { text: 'Discard', cls: 'mod-warning' })
			.addEventListener('click', () => {
				void this.plugin.clearIngestState();
				this.renderIdle();
			});
		actions
			.createEl('button', { text: 'Resume', cls: 'mod-cta' })
			.addEventListener('click', () => {
				this.sourceFile = file;
				this.state = saved;
				void this.run();
			});
	}

	startIngest(file: TFile): void {
		this.sourceFile = file;
		this.state = { sourcePath: file.path, step: 'analyzing', chatHistory: [] };
		void this.run();
	}

	private async run(): Promise<void> {
		const st = this.state;
		if (!st) return;
		switch (st.step) {
			case 'analyzing':
				await this.stepAnalyze();
				break;
			case 'choose':
				this.stepChoose();
				break;
			case 'drafting':
				await this.stepDrafting();
				break;
			case 'review':
				this.stepReview();
				break;
			case 'saving':
				await this.stepSaving();
				break;
		}
	}

	private renderStepIndicator(): void {
		const row = this.stepRowEl;
		if (!row || !this.state) return;
		row.empty();
		const steps = ['analyzing', 'choose', 'drafting', 'review', 'saving'] as const;
		const currentIdx = steps.indexOf(this.state.step);
		for (const s of steps) {
			const chip = row.createSpan({ cls: 'm2-step-chip' });
			chip.setText(STEP_LABELS[s] ?? s);
			const idx = steps.indexOf(s);
			if (idx < currentIdx) chip.addClass('m2-step-done');
			if (idx === currentIdx) chip.addClass('m2-step-current');
		}
	}

	private setBusy(busy: boolean, text = ''): void {
		this.statusEl?.setText(busy ? text : '');
	}

	private showError(e: unknown, retryLabel: string, onRetry: () => void): void {
		const host = this.contentHostEl;
		if (!host) return;
		host.empty();
		host.createDiv({
			cls: 'm2-error',
			text: e instanceof Error ? e.message : String(e),
		});
		const actions = host.createDiv({ cls: 'm2-modal-actions' });
		actions.createEl('button', { text: 'Cancel', cls: 'mod-warning' }).addEventListener('click', () => {
			this.abort();
		});
		actions.createEl('button', { text: retryLabel, cls: 'mod-cta' }).addEventListener('click', () => {
			void onRetry();
		});
	}

	private abort(): void {
		this.state = null;
		this.sourceFile = null;
		void this.plugin.clearIngestState();
		this.renderIdle();
	}

	// ── Steps ──────────────────────────────────────────────────────────────────

	private async stepAnalyze(): Promise<void> {
		const st = this.state;
		const file = this.sourceFile;
		if (!st || !file) return;
		this.renderStepIndicator();
		this.setBusy(true, 'Analyzing note with the LLM…');
		try {
			const content = await this.plugin.app.vault.cachedRead(file);
			const { body } = parseFrontmatter(content);
			const topics = this.plugin.kb.getTopics();
			const suggestions = await classifyNote(
				this.plugin.settings.llm,
				file.name.replace(/\.md$/, ''),
				body,
				topics,
				this.plugin.settings.ingestVerbosity,
			);
			if (!this.state) return;
			this.state.suggestions = suggestions;
			this.state.step = 'choose';
			await this.plugin.saveIngestState(this.state);
			this.setBusy(false);
			this.stepChoose();
		} catch (e) {
			this.setBusy(false);
			this.showError(e, 'Retry', () => {
				if (this.state) {
					this.state.step = 'analyzing';
					void this.run();
				}
			});
		}
	}

	private stepChoose(): void {
		const st = this.state;
		const file = this.sourceFile;
		if (!st || !file) return;
		this.renderStepIndicator();
		const suggestions = st.suggestions ?? [];
		if (suggestions.length === 0) {
			this.showError(new Error('The LLM returned no suggestions. Try again.'), 'Retry', () => {
				if (this.state) {
					this.state.step = 'analyzing';
					void this.run();
				}
			});
			return;
		}
		const host = this.contentHostEl;
		if (!host) return;
		host.empty();

		const warnings: string[] = [];
		if (isUnderFolder(file.path, this.plugin.settings.baseNotesFolder)) {
			warnings.push(
				'This note is already in the BaseNotes folder (re-ingest). It will not be moved again.',
			);
		}
		if (isUnderFolder(file.path, this.plugin.settings.knowledgeBaseFolder)) {
			warnings.push(
				'This note is already inside the knowledge base folder. It will not be moved to BaseNotes.',
			);
		}
		for (const w of warnings) {
			host.createDiv({ cls: 'm2-warning', text: w });
		}

		const list = host.createDiv({ cls: 'm2-suggestion-list' });
		let selected: IngestSuggestion | null = null;
		const inputs = new Map<IngestSuggestion, HTMLInputElement>();
		suggestions.forEach((s, i) => {
			const item = list.createDiv({ cls: 'm2-suggestion' });
			const radio = item.createEl('input', {
				type: 'radio',
				attr: { name: 'm2-suggestion' },
			});
			radio.value = String(i);
			if (i === 0) {
				radio.checked = true;
				selected = s;
			}
			radio.addEventListener('change', () => {
				selected = s;
			});
			const label = item.createDiv({ cls: 'm2-suggestion-label' });
			const kindText =
				s.kind === 'existing-subtopic'
					? `Existing subtopic: ${s.topic} / ${s.subtopic}`
					: s.kind === 'new-subtopic'
						? `New subtopic in: ${s.topic}`
						: 'New topic';
			label.createDiv({ cls: 'm2-suggestion-kind', text: kindText });
			if (s.reason) label.createDiv({ cls: 'm2-suggestion-reason', text: s.reason });
			if (s.kind === 'new-subtopic' || s.kind === 'new-topic') {
				// The input lives inside the label so it does not become a flex
				// sibling that squeezes the label to a single word per line.
				const input = label.createEl('input', {
					cls: 'm2-name-input',
					type: 'text',
					value: s.kind === 'new-subtopic' ? (s.subtopic ?? '') : s.topic,
				});
				inputs.set(s, input);
			}
		});

		const actions = host.createDiv({ cls: 'm2-modal-actions' });
		actions
			.createEl('button', { text: 'Cancel', cls: 'mod-warning' })
			.addEventListener('click', () => this.abort());
		actions
			.createEl('button', { text: 'Continue', cls: 'mod-cta' })
			.addEventListener('click', () => {
				const s = selected;
				if (!s || !this.state) return;
				const target: IngestTarget = {
					kind: s.kind,
					topic: s.topic,
					subtopic: s.subtopic,
				};
				const input = inputs.get(s);
				if (input && input.value.trim().length > 0) {
					if (s.kind === 'new-subtopic') target.subtopic = input.value.trim();
					else if (s.kind === 'new-topic') target.topic = input.value.trim();
				}
				this.state.target = target;
				this.state.step = 'drafting';
				void this.plugin.saveIngestState(this.state);
				void this.stepDrafting();
			});
	}

	private async stepDrafting(): Promise<void> {
		const st = this.state;
		const file = this.sourceFile;
		if (!st || !file || !st.target) return;
		const target = st.target;
		this.renderStepIndicator();
		this.setBusy(true, 'Drafting subtopic content…');
		// Clear the stale "Choose target" list so the panel reflects the new step
		// instead of looking stuck on the previous request.
		const host = this.contentHostEl;
		if (host) {
			host.empty();
			host.createDiv({ cls: 'm2-empty', text: 'Drafting subtopic content…' });
		}
		try {
			const content = await this.plugin.app.vault.cachedRead(file);
			const { body } = parseFrontmatter(content);
			const topics = this.plugin.kb.getTopics();
			let targetContent: string | undefined;
			let targetSubtopics: string[] | undefined;
			const topic = topics.find((t) => t.name === target.topic);
			if (target.kind === 'existing-subtopic') {
				targetContent = topic?.subtopics.find((s) => s.name === target.subtopic)?.body;
			} else if (target.kind === 'new-subtopic') {
				targetSubtopics = topic?.subtopics.map((s) => s.name);
			}
			const finalSourcePath = await this.resolveFinalSourcePath(st, file);
			const draft = await draftSubtopic(
				this.plugin.settings.llm,
				{
					sourceTitle: file.name.replace(/\.md$/, ''),
					sourceBody: body,
					sourcePath: finalSourcePath,
					sourceLink: `[[${finalSourcePath.replace(/\.md$/i, '')}]]`,
					target,
					targetContent,
					targetSubtopics,
				},
				this.plugin.settings.ingestVerbosity,
			);
			if (!this.state) return;
			this.state.draft = draft;
			this.state.step = 'review';
			await this.plugin.saveIngestState(this.state);
			this.setBusy(false);
			this.stepReview();
		} catch (e) {
			this.setBusy(false);
			this.showError(e, 'Retry', () => {
				if (this.state) {
					this.state.step = 'drafting';
					void this.run();
				}
			});
		}
	}

	private stepReview(): void {
		const st = this.state;
		const host = this.contentHostEl;
		if (!st || !host || !st.draft || !st.target) return;
		const draft = st.draft;
		const target = st.target;
		this.renderStepIndicator();
		host.empty();

		const existing =
			target.kind === 'existing-subtopic'
				? this.plugin.kb.getSubtopic(
						this.plugin.subtopicPathFor(target.topic, target.subtopic ?? ''),
					)
				: null;
		const oldBody = existing?.body ?? '';

		const diffEl = host.createDiv({ cls: 'm2-diff-host' });
		renderLineDiff(oldBody, draft.body, diffEl);

		this.draftTextarea = host.createEl('textarea', {
			cls: 'm2-draft-textarea',
			attr: { spellcheck: 'false' },
		});
		this.draftTextarea.value = draft.body;
		this.draftTextarea.addEventListener('input', () => {
			if (this.state?.draft) {
				this.state.draft.body = this.draftTextarea?.value ?? '';
				void this.plugin.saveIngestState(this.state);
			}
		});

		const editRow = host.createDiv({ cls: 'm2-edit-row' });
		const editInput = editRow.createEl('input', {
			cls: 'm2-search',
			type: 'text',
			placeholder: 'Ask the LLM to edit the draft…',
		});
		const editBtn = editRow.createEl('button', { text: 'Apply edit' });
		const doEdit = () => {
			const instruction = editInput.value.trim();
			if (instruction.length === 0) return;
			editInput.value = '';
			void this.runEdit(instruction);
		};
		editBtn.addEventListener('click', doEdit);
		editInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') doEdit();
		});

		const actions = host.createDiv({ cls: 'm2-modal-actions' });
		actions
			.createEl('button', { text: 'Discard', cls: 'mod-warning' })
			.addEventListener('click', () => this.abort());
		actions
			.createEl('button', { text: 'Save', cls: 'mod-cta' })
			.addEventListener('click', () => {
				if (this.state) {
					this.state.step = 'saving';
					void this.plugin.saveIngestState(this.state);
					void this.stepSaving();
				}
			});
	}

	private async runEdit(instruction: string): Promise<void> {
		const st = this.state;
		if (!st || !st.draft) return;
		this.setBusy(true, 'Applying edit…');
		try {
			const updated = await editDraft(
				this.plugin.settings.llm,
				st.draft,
				st.chatHistory,
				instruction,
				this.plugin.settings.ingestVerbosity,
			);
			st.chatHistory.push({ role: 'user', content: instruction });
			st.chatHistory.push({ role: 'assistant', content: 'Draft updated.' });
			st.draft = updated;
			await this.plugin.saveIngestState(st);
			this.setBusy(false);
			this.stepReview();
		} catch (e) {
			this.setBusy(false);
			this.showError(e, 'Retry', () => void this.runEdit(instruction));
		}
	}

	private async resolveFinalSourcePath(st: IngestState, file: TFile): Promise<string> {
		if (st.plannedSourcePath && st.plannedSourcePath.length > 0) {
			return st.plannedSourcePath;
		}
		const settings = this.plugin.settings;
		const inBase = isUnderFolder(file.path, settings.baseNotesFolder);
		const inKb = isUnderFolder(file.path, settings.knowledgeBaseFolder);
		if (!inBase && !inKb) {
			st.plannedSourcePath = await this.plugin.writer.planArchivePath(file.path);
		} else {
			st.plannedSourcePath = file.path;
		}
		return st.plannedSourcePath;
	}

	private async stepSaving(): Promise<void> {
		const st = this.state;
		const file = this.sourceFile;
		if (!st || !file || !st.draft || !st.target) return;
		const draft = st.draft;
		const target = st.target;
		this.renderStepIndicator();
		this.setBusy(true, 'Saving into the knowledge base…');
		try {
			const app = this.plugin.app;
			const finalSourcePath = await this.resolveFinalSourcePath(st, file);
			const archiveTarget = finalSourcePath === file.path ? null : finalSourcePath;
			let body = ensureInlineSourceLink(
				this.draftTextarea?.value ?? draft.body,
				finalSourcePath,
			);
			const { refs, body: newBody, changed, dropped, added } = reconcileReferences(
				body,
				draft.references,
				app,
				file.path,
			);
			body = newBody;
			if (changed) {
				new Notice(
					`References updated: ${dropped} dropped, ${added} added to match the final text.`,
				);
			}

			const subtopicName =
				target.subtopic ?? draft.title ?? target.topic;
			const existing = this.plugin.kb.getSubtopic(
				this.plugin.subtopicPathFor(target.topic, subtopicName),
			);
			const previousSources = [
				...(existing?.sources ?? []),
				existing?.ingestedFrom,
			].filter((s): s is string => typeof s === 'string' && s.trim().length > 0);

			const meta: SubtopicMeta = {
				path: '',
				topic: target.topic,
				name: subtopicName,
				summary: draft.summary,
				body,
				references: refs,
				sources: [...previousSources, finalSourcePath],
				ingestedFrom: finalSourcePath,
				originalPath: file.path,
				ingestedAt: new Date().toISOString(),
			};

			await this.plugin.writer.createOrUpdateSubtopic(target.topic, subtopicName, meta, body);

			if (archiveTarget) {
				await this.plugin.writer.archiveBaseNoteTo(file.path, archiveTarget);
			}

			await this.plugin.kb.rebuild();
			void this.plugin.clearIngestState();
			this.state = null;
			this.sourceFile = null;
			this.setBusy(false);
			new Notice(`Ingested into **${target.topic} / ${subtopicName}**`);
			for (const leaf of this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_INGEST_PANEL)) {
				leaf.detach();
			}
		} catch (e) {
			this.setBusy(false);
			this.showError(e, 'Retry', () => void this.stepSaving());
		}
	}
}
