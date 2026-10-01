import { diffLines } from 'diff';

export function renderLineDiff(oldText: string, newText: string, container: HTMLElement): void {
	container.empty();
	container.addClass('m2-diff');
	const parts = diffLines(oldText, newText);
	for (const part of parts) {
		const lines = part.value.replace(/\n$/, '').split('\n');
		for (const line of lines) {
			const row = container.createDiv({ cls: 'm2-diff-line' });
			if (part.added) row.addClass('m2-diff-add');
			else if (part.removed) row.addClass('m2-diff-del');
			row.createSpan({ text: line.length > 0 ? line : ' ' });
		}
	}
}
