import type { App, TFile } from 'obsidian';

export function sanitizeName(name: string): string {
	const cleaned = name
		.replace(/[\\/:*?"<>|]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 150);
	return cleaned.length > 0 ? cleaned : 'Untitled';
}

export function topicFolderPath(kbFolder: string, topic: string): string {
	return `${kbFolder.replace(/\/+$/, '')}/${sanitizeName(topic)}`;
}

export function subtopicPath(kbFolder: string, topic: string, subtopic: string): string {
	return `${topicFolderPath(kbFolder, topic)}/${sanitizeName(subtopic)}.md`;
}

export function isUnderFolder(path: string, folder: string): boolean {
	const f = folder.replace(/\/+$/, '');
	return path === f || path.startsWith(`${f}/`);
}

export function extractTitle(content: string, fallback: string): string {
	const match = content.match(/^#\s+(.+)$/m);
	if (match && match[1]) return sanitizeName(match[1]);
	return sanitizeName(fallback);
}

export function ingestionDate(): string {
	return new Date().toISOString().slice(0, 10);
}

export async function uniqueBaseNotePath(
	app: App,
	baseFolder: string,
	title: string,
	date: string,
): Promise<string> {
	const folder = baseFolder.replace(/\/+$/, '');
	const base = `${folder}/${date} ${sanitizeName(title)}`;
	let candidate = `${base}.md`;
	let i = 2;
	while (await app.vault.adapter.exists(candidate)) {
		candidate = `${base} (${i}).md`;
		i++;
	}
	return candidate;
}

export async function ensureFolder(app: App, folderPath: string): Promise<void> {
	const normalized = folderPath.replace(/\/+$/, '');
	const existing = app.vault.getAbstractFileByPath(normalized);
	if (!existing) {
		await app.vault.createFolder(normalized);
	}
}

export function isMarkdownFile(file: TFile): boolean {
	return file.path.toLowerCase().endsWith('.md');
}
