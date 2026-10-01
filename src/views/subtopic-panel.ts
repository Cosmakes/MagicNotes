import { Component, MarkdownRenderer, Notice, TFile } from 'obsidian';
import type { MagicNotesPlugin } from '../main';
import type { Reference, SubtopicMeta } from '../types';

interface ParsedRef {
	path: string;
	page?: number;
	heading?: string;
	display: string;
}

// Reference targets may be plain vault paths, wikilinks ([[path]],
// [[path|alias]], [[path#heading]]), markdown fragments (#page=N, #heading)
// or external URLs. Normalize them into a resolvable path + display text.
function parseReferenceTarget(target: string): ParsedRef {
	let t = target.trim();
	let display = t;
	const wiki = t.match(/^\[\[([^\]|#]+)(?:#([^\]|]*))?(?:\|([^\]]*))?\]\]$/);
	if (wiki) {
		t = wiki[1]!.trim();
		display = (wiki[3] ?? wiki[2] ?? wiki[1]!).trim();
	}
	let page: number | undefined;
	let heading: string | undefined;
	const hashIdx = t.indexOf('#');
	if (hashIdx >= 0) {
		const fragment = t.slice(hashIdx + 1);
		t = t.slice(0, hashIdx).trim();
		const pageMatch = fragment.match(/^page=(\d+)$/i);
		if (pageMatch) {
			page = Number(pageMatch[1]);
		} else if (fragment.length > 0) {
			heading = fragment;
		}
	}
	return { path: t, page, heading, display };
}

export class SubtopicPanel {
	private plugin: MagicNotesPlugin;
	private hostEl: HTMLElement;
	private component: Component;
	private renderToken = 0;
	private sourcePath = '';

	constructor(plugin: MagicNotesPlugin, hostEl: HTMLElement, component: Component) {
		this.plugin = plugin;
		this.hostEl = hostEl;
		this.component = component;
	}

	async render(meta: SubtopicMeta): Promise<void> {
		const token = ++this.renderToken;
		this.sourcePath = meta.path;
		this.hostEl.empty();
		this.hostEl.addClass('m2-subtopic-panel');

		const bodyEl = this.hostEl.createDiv({ cls: 'm2-subtopic-body' });
		try {
			await MarkdownRenderer.render(this.plugin.app, meta.body, bodyEl, meta.path, this.component);
		} catch (e) {
			console.warn('[magicnotes] markdown render failed:', e);
			bodyEl.createEl('pre', { text: meta.body });
		}
		if (token !== this.renderToken) return;
		this.attachCitations(bodyEl, meta.references);

		if (meta.references.length > 0) {
			const refsEl = this.hostEl.createDiv({ cls: 'm2-refs' });
			refsEl.createDiv({ cls: 'm2-refs-title', text: 'References' });
		for (const ref of meta.references) {
			const row = refsEl.createDiv({ cls: 'm2-ref-row' });
			row.createSpan({ cls: 'm2-ref-n', text: `[${ref.n}]` });
			row.createSpan({ cls: 'm2-ref-label', text: ref.label });
			row.createSpan({ cls: 'm2-ref-target', text: parseReferenceTarget(ref.target).display });
			row.addEventListener('click', () => this.openReference(ref));
		}
		}
	}

	private attachCitations(root: HTMLElement, refs: Reference[]): void {
		if (refs.length === 0) return;
		const refMap = new Map<number, Reference>();
		for (const r of refs) refMap.set(r.n, r);
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		const textNodes: Text[] = [];
		let node = walker.nextNode();
		while (node) {
			if (node.instanceOf(Text)) textNodes.push(node);
			node = walker.nextNode();
		}
		const re = /\[(\d+)\]/g;
		for (const tn of textNodes) {
			const text = tn.nodeValue ?? '';
			re.lastIndex = 0;
			if (!re.test(text)) continue;
			re.lastIndex = 0;
			const parent = tn.parentNode;
			if (!parent) continue;
			const frag = createFragment();
			let last = 0;
			let m = re.exec(text);
			while (m) {
				if (m.index > last) {
					frag.appendChild(document.createTextNode(text.slice(last, m.index)));
				}
				const n = Number(m[1]);
				const ref = refMap.get(n);
				if (ref) {
					const sup = createEl('sup');
					sup.className = 'm2-cite';
					sup.textContent = String(n);
					sup.addEventListener('click', (e) => {
						e.stopPropagation();
						this.openReference(ref);
					});
					frag.appendChild(sup);
				} else {
					frag.appendChild(document.createTextNode(m[0]));
				}
				last = m.index + m[0].length;
				m = re.exec(text);
			}
			if (last < text.length) {
				frag.appendChild(document.createTextNode(text.slice(last)));
			}
			parent.replaceChild(frag, tn);
		}
	}

	private openReference(ref: Reference): void {
		const target = ref.target;
		if (/^https?:\/\//i.test(target)) {
			window.open(target, '_blank');
			return;
		}
		const parsed = parseReferenceTarget(target);
		const app = this.plugin.app;
		const resolved =
			app.metadataCache.getFirstLinkpathDest(parsed.path, this.sourcePath) ??
			app.metadataCache.getFirstLinkpathDest(parsed.path + '.md', this.sourcePath);
		const file = resolved ?? app.vault.getAbstractFileByPath(parsed.path);
		if (file instanceof TFile) {
			if (file.extension === 'pdf') {
				void this.plugin.openPdfTarget(file, parsed.page);
			} else {
				void app.workspace
					.getLeaf()
					?.openFile(
						file,
						parsed.heading ? { state: { heading: parsed.heading } } : undefined,
					);
			}
		} else {
			new Notice(`Could not resolve reference target: ${target}`);
		}
	}
}
