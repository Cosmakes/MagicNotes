import { App, TFile } from 'obsidian';
import { serializeFrontmatter } from './frontmatter';
import {
	ensureFolder,
	extractTitle,
	ingestionDate,
	subtopicPath,
	topicFolderPath,
	uniqueBaseNotePath,
} from './paths';
import type { SubtopicMeta } from '../types';

export interface WriterSettings {
	knowledgeBaseFolder: string;
	baseNotesFolder: string;
}

export class KbWriter {
	private app: App;
	private getSettings: () => WriterSettings;

	constructor(app: App, getSettings: () => WriterSettings) {
		this.app = app;
		this.getSettings = getSettings;
	}

	async createOrUpdateSubtopic(
		topic: string,
		subtopic: string,
		meta: SubtopicMeta,
		body: string,
	): Promise<string> {
		const s = this.getSettings();
		const path = subtopicPath(s.knowledgeBaseFolder, topic, subtopic);
		await ensureFolder(this.app, topicFolderPath(s.knowledgeBaseFolder, topic));
		const sources = dedupeSources(meta.sources ?? (meta.ingestedFrom ? [meta.ingestedFrom] : []));
		const content =
			serializeFrontmatter({
				m2type: 'subtopic',
				topic,
				summary: meta.summary,
				references: meta.references,
				sources,
				ingestedFrom: meta.ingestedFrom ?? sources[sources.length - 1],
				originalPath: meta.originalPath,
				ingestedAt: meta.ingestedAt,
			}) +
			'\n' +
			body;
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			await this.app.vault.create(path, content);
		}
		return path;
	}

	async planArchivePath(srcPath: string): Promise<string> {
		const s = this.getSettings();
		const file = this.app.vault.getAbstractFileByPath(srcPath);
		if (!(file instanceof TFile) || !file.path.toLowerCase().endsWith('.md')) {
			throw new Error(`Source note not found: ${srcPath}`);
		}
		const content = await this.app.vault.read(file);
		const title = extractTitle(content, file.name.replace(/\.md$/, ''));
		const date = ingestionDate();
		return uniqueBaseNotePath(this.app, s.baseNotesFolder, title, date);
	}

	async archiveBaseNoteTo(srcPath: string, target: string): Promise<string> {
		const file = this.app.vault.getAbstractFileByPath(srcPath);
		if (!(file instanceof TFile) || !file.path.toLowerCase().endsWith('.md')) {
			throw new Error(`Source note not found: ${srcPath}`);
		}
		await ensureFolder(this.app, this.getSettings().baseNotesFolder);
		await this.app.vault.rename(file, target);
		return target;
	}

	async archiveBaseNote(srcPath: string): Promise<string> {
		const target = await this.planArchivePath(srcPath);
		return this.archiveBaseNoteTo(srcPath, target);
	}
}

function dedupeSources(sources: Array<string | undefined>): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const source of sources) {
		if (typeof source !== 'string') continue;
		const trimmed = source.trim();
		if (trimmed.length === 0) continue;
		const key = trimmed.toLowerCase().replace(/\.md$/i, '');
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(trimmed);
	}
	return out;
}

