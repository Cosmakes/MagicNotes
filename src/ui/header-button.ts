import { MarkdownView, TFile, setIcon, type WorkspaceLeaf } from 'obsidian';
import type MagicNotesPlugin from '../main';

const DATA_ATTR = 'data-m2-ingest';
const DATA_ATTR_PDF = 'data-m2-pdf';

function headerActionContainer(view: { containerEl: HTMLElement }): HTMLElement | null {
	const header = view.containerEl.querySelector('.view-header');
	if (!(header instanceof HTMLElement)) return null;
	const actions = header.querySelector('.view-actions');
	if (actions instanceof HTMLElement) return actions;
	const fallback = header.querySelector('.view-header-action-container');
	if (fallback instanceof HTMLElement) return fallback;
	return header;
}

function injectIntoView(plugin: MagicNotesPlugin, view: MarkdownView): void {
	const container = headerActionContainer(view);
	if (!container) return;
	if (container.querySelector(`[${DATA_ATTR}]`)) return;
	const btn = container.createEl('button', { cls: 'clickable-icon view-action' });
	btn.setAttribute(DATA_ATTR, 'true');
	btn.setAttribute('aria-label', 'Ingest into knowledge base');
	btn.setAttribute('title', 'Ingest into knowledge base');
	setIcon(btn, 'sparkles');
	btn.addEventListener('click', (e: MouseEvent) => {
		e.stopPropagation();
		plugin.startIngest();
	});
}

function injectPdfButton(plugin: MagicNotesPlugin, leaf: WorkspaceLeaf): void {
	const container = headerActionContainer(leaf.view);
	if (!container || container.querySelector(`[${DATA_ATTR_PDF}]`)) return;
	const btn = container.createEl('button', { cls: 'clickable-icon view-action' });
	btn.setAttribute(DATA_ATTR_PDF, 'true');
	btn.setAttribute('aria-label', 'Ask about this PDF');
	btn.setAttribute('title', 'Ask about this PDF');
	setIcon(btn, 'bot');
	btn.addEventListener('click', (e: MouseEvent) => {
		e.stopPropagation();
		const file = (leaf.view as { file?: TFile | null }).file;
		plugin.openChatPanelFor(file instanceof TFile ? file : undefined);
	});
}

export function registerHeaderButton(plugin: MagicNotesPlugin): void {
	const inject = (): void => {
		const leaves = plugin.app.workspace.getLeavesOfType('markdown');
		for (const leaf of leaves) {
			if (leaf.view instanceof MarkdownView) {
				injectIntoView(plugin, leaf.view);
			}
		}
	};
	let scheduled = false;
	const observer = new MutationObserver(() => {
		if (scheduled) return;
		scheduled = true;
		window.requestAnimationFrame(() => {
			scheduled = false;
			inject();
		});
	});
	observer.observe(plugin.app.workspace.containerEl, {
		childList: true,
		subtree: true,
	});
	plugin.register(() => observer.disconnect());
	plugin.registerEvent(plugin.app.workspace.on('layout-change', () => inject()));
	plugin.registerEvent(
		plugin.app.workspace.on('file-open', (file) => {
			if (file instanceof TFile && file.extension === 'md') inject();
		}),
	);
}

export function registerPdfHeaderButton(plugin: MagicNotesPlugin): void {
	// Inject a robot button into the header of the native PDF view. Third-party
	// viewers (e.g. PDF++) are covered by the "Ask about the open PDF" command,
	// which works for whatever PDF file is active.
	const inject = (): void => {
		const leaves = plugin.app.workspace.getLeavesOfType('pdf');
		for (const leaf of leaves) {
			injectPdfButton(plugin, leaf);
		}
	};
	let scheduled = false;
	const observer = new MutationObserver(() => {
		if (scheduled) return;
		scheduled = true;
		window.requestAnimationFrame(() => {
			scheduled = false;
			inject();
		});
	});
	observer.observe(plugin.app.workspace.containerEl, {
		childList: true,
		subtree: true,
	});
	plugin.register(() => observer.disconnect());
	plugin.registerEvent(plugin.app.workspace.on('layout-change', () => inject()));
	plugin.registerEvent(
		plugin.app.workspace.on('file-open', (file) => {
			if (file instanceof TFile && file.extension === 'pdf') inject();
		}),
	);
}
