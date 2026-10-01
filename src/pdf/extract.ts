import type { App, TFile } from 'obsidian';
import * as pdfjsLib from 'pdfjs-dist';
import workerCode from 'pdfjs-dist/build/pdf.worker.mjs?raw';
import type { PDFDocumentProxy } from 'pdfjs-dist';

export type PageTextMap = Map<number, string>;

let workerInitialized = false;
export function initPdfWorker(): void {
	if (workerInitialized) return;
	workerInitialized = true;
	try {
		const blob = new Blob([workerCode], { type: 'text/javascript' });
		pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
	} catch (e) {
		// pdf.js falls back to a main-thread "fake worker" if the real worker
		// cannot be created, so extraction still works.
		console.warn('[magicnotes] pdf.js worker blob creation failed.', e);
	}
}

export async function extractAllPages(doc: PDFDocumentProxy): Promise<PageTextMap> {
	const pages: PageTextMap = new Map();
	for (let i = 1; i <= doc.numPages; i++) {
		const page = await doc.getPage(i);
		const content = await page.getTextContent();
		const text = content.items
			.map((item) => ('str' in item ? item.str : ''))
			.join(' ');
		pages.set(i, text);
	}
	return pages;
}

export function totalTextLength(pages: PageTextMap): number {
	let total = 0;
	for (const text of pages.values()) total += text.length;
	return total;
}

// Parse a PDF and return its per-page text without rendering any page.
// This is intentionally render-free so it stays robust even when canvas
// rendering is unavailable.
export async function extractPdfText(app: App, file: TFile): Promise<PageTextMap> {
	initPdfWorker();
	const data = await app.vault.readBinary(file);
	const task = pdfjsLib.getDocument({ data: new Uint8Array(data) });
	const doc = await task.promise;
	try {
		return await extractAllPages(doc);
	} finally {
		await doc.destroy().catch(() => undefined);
	}
}
