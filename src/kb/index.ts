import { App, TFile, type EventRef, type TAbstractFile } from 'obsidian';
import { parseFrontmatter } from './frontmatter';
import { isMarkdownFile, isUnderFolder } from './paths';
import type {
	KbIndexData,
	Reference,
	SubtopicMeta,
	TopicMeta,
} from '../types';

type Listener = () => void;

function asString(v: unknown): string | undefined {
	return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function normalizeStringArray(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function normalizeReferences(v: unknown): Reference[] {
	if (!Array.isArray(v)) return [];
	const out: Reference[] = [];
	for (const item of v) {
		if (item === null || typeof item !== 'object') continue;
		const o = item as Record<string, unknown>;
		const n = typeof o.n === 'number' ? o.n : Number(o.n);
		const target = asString(o.target);
		if (!Number.isFinite(n) || target === undefined) continue;
		out.push({ n, target, label: asString(o.label) ?? target });
	}
	out.sort((a, b) => a.n - b.n);
	return out;
}

export class KbIndexManager {
	private app: App;
	private getKbFolder: () => string;
	private register: (evt: EventRef) => void;
	private data: KbIndexData = { topics: new Map(), byPath: new Map() };
	private listeners = new Set<Listener>();
	private timer: number | null = null;
	private inflight: Promise<void> | null = null;

	constructor(app: App, getKbFolder: () => string, register: (evt: EventRef) => void) {
		this.app = app;
		this.getKbFolder = getKbFolder;
		this.register = register;
	}

	start(): void {
		void this.rebuild();
		this.register(this.app.vault.on('create', (file) => this.onVaultEvent(file)));
		this.register(this.app.vault.on('modify', (file) => this.onVaultEvent(file)));
		this.register(this.app.vault.on('delete', (file) => this.onVaultEvent(file)));
		this.register(
			this.app.vault.on('rename', (file, oldPath) => {
				if (file instanceof TFile && isMarkdownFile(file)) {
					if (
						isUnderFolder(file.path, this.getKbFolder()) ||
						isUnderFolder(oldPath, this.getKbFolder())
					) {
						this.scheduleRebuild();
					}
				}
			}),
		);
	}

	private onVaultEvent(file: TAbstractFile): void {
		if (file instanceof TFile && isMarkdownFile(file) && isUnderFolder(file.path, this.getKbFolder())) {
			this.scheduleRebuild();
		}
	}

	scheduleRebuild(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			void this.rebuild();
		}, 500);
	}

	async rebuild(): Promise<void> {
		if (this.inflight) return this.inflight;
		this.inflight = (async () => {
			const kbFolder = this.getKbFolder();
			const topics = new Map<string, TopicMeta>();
			const byPath = new Map<string, SubtopicMeta>();
			const files = this.app.vault
				.getMarkdownFiles()
				.filter((f) => isUnderFolder(f.path, kbFolder));
			for (const file of files) {
				let content: string;
				try {
					content = await this.app.vault.cachedRead(file);
				} catch {
					continue;
				}
				const { data, body } = parseFrontmatter(content);
				if (data.m2type !== 'subtopic') continue;
				const topic = asString(data.topic) ?? 'Untitled';
				const meta: SubtopicMeta = {
					path: file.path,
					topic,
					name: file.name.replace(/\.md$/, ''),
					summary: asString(data.summary) ?? '',
				body,
				references: normalizeReferences(data.references),
				sources: normalizeStringArray(data.sources),
					ingestedFrom: asString(data.ingestedFrom),
					originalPath: asString(data.originalPath),
					ingestedAt: asString(data.ingestedAt),
				};
				byPath.set(file.path, meta);
				let t = topics.get(topic);
				if (!t) {
					t = { name: topic, subtopics: [] };
					topics.set(topic, t);
				}
				t.subtopics.push(meta);
			}
			for (const t of topics.values()) {
				t.subtopics.sort((a, b) => a.name.localeCompare(b.name));
			}
			this.data = { topics, byPath };
			this.notify();
		})();
		try {
			await this.inflight;
		} finally {
			this.inflight = null;
		}
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private notify(): void {
		for (const l of this.listeners) l();
	}

	getTopics(): TopicMeta[] {
		return Array.from(this.data.topics.values()).sort((a, b) =>
			a.name.localeCompare(b.name),
		);
	}

	getTopic(name: string): TopicMeta | null {
		return this.data.topics.get(name) ?? null;
	}

	getSubtopic(path: string): SubtopicMeta | null {
		return this.data.byPath.get(path) ?? null;
	}

	searchTopics(query: string): TopicMeta[] {
		const q = query.trim().toLowerCase();
		if (q.length === 0) return this.getTopics();
		return this.getTopics().filter((t) => topicMatches(t, q));
	}

	searchSubtopics(topic: string, query: string): SubtopicMeta[] {
		const t = this.data.topics.get(topic);
		if (!t) return [];
		const q = query.trim().toLowerCase();
		if (q.length === 0) return t.subtopics;
		return t.subtopics.filter((s) => subtopicMatches(s, q));
	}
}

function topicMatches(t: TopicMeta, q: string): boolean {
	if (t.name.toLowerCase().includes(q)) return true;
	return t.subtopics.some((s) => subtopicMatches(s, q));
}

function subtopicMatches(s: SubtopicMeta, q: string): boolean {
	if (s.name.toLowerCase().includes(q)) return true;
	if (s.summary.toLowerCase().includes(q)) return true;
	return s.body.toLowerCase().includes(q);
}
