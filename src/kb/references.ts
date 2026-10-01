import type { App } from 'obsidian';
import type { Reference } from '../types';

export function resolveLinkTarget(app: App, target: string, sourcePath: string): string {
	if (/^https?:\/\//i.test(target)) return target;
	const clean = target.split('#')[0] ?? target;
	const resolved =
		app.metadataCache.getFirstLinkpathDest(target, sourcePath) ??
		app.metadataCache.getFirstLinkpathDest(clean, sourcePath);
	if (resolved) return resolved.path;
	const direct = app.vault.getAbstractFileByPath(clean);
	if (direct) return direct.path;
	return target;
}

function splitWikiTarget(raw: string): { target: string; label: string } {
	const parts = raw.split('|');
	const linkPart = (parts[0] ?? '').trim();
	const label = parts.length > 1 ? parts.slice(1).join('|').trim() : linkPart;
	const hashIdx = linkPart.indexOf('#');
	if (hashIdx === -1) return { target: linkPart, label };
	const path = linkPart.slice(0, hashIdx);
	const anchor = linkPart.slice(hashIdx + 1);
	const pageMatch = anchor.match(/page=(\d+)/);
	if (pageMatch && pageMatch[1]) {
		return { target: `${path}#page=${pageMatch[1]}`, label };
	}
	return { target: path, label };
}

interface FoundLink {
	start: number;
	end: number;
	target: string;
	label: string;
}

export interface ReconcileResult {
	refs: Reference[];
	body: string;
	changed: boolean;
	dropped: number;
	added: number;
}

/**
 * Re-scans the final body for [n] markers and links:
 * - keeps only references whose marker still exists,
 * - auto-numbers newly found wikilinks/markdown links in order of appearance.
 */
export function reconcileReferences(
	body: string,
	refs: Reference[],
	app: App,
	sourcePath: string,
): ReconcileResult {
	const markerRe = /\[(\d+)\]/g;
	const used = new Set<number>();
	for (const m of body.matchAll(markerRe)) {
		if (m[1]) used.add(Number(m[1]));
	}
	const kept = refs.filter((r) => used.has(r.n));
	const keptTargets = new Set(kept.map((r) => r.target));

	const found: FoundLink[] = [];
	const wikiRe = /\[\[([^\]]+)\]\]/g;
	for (const m of body.matchAll(wikiRe)) {
		const raw = m[1];
		if (!raw || m.index === undefined) continue;
		const { target, label } = splitWikiTarget(raw);
		if (target.length > 0) {
			found.push({ start: m.index, end: m.index + m[0].length, target, label });
		}
	}
	const mdRe = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
	for (const m of body.matchAll(mdRe)) {
		if (m.index === undefined || !m[2]) continue;
		if (found.some((f) => m.index >= f.start && m.index < f.end)) continue;
		found.push({
			start: m.index,
			end: m.index + m[0].length,
			target: m[2],
			label: m[1] ?? m[2],
		});
	}
	found.sort((a, b) => a.start - b.start);

	let nextN = kept.length > 0 ? Math.max(...kept.map((r) => r.n)) : 0;
	const newRefs: Reference[] = [];
	let newBody = body;
	let offset = 0;
	for (const f of found) {
		const target = resolveLinkTarget(app, f.target, sourcePath);
		if (keptTargets.has(target)) continue;
		nextN += 1;
		newRefs.push({ n: nextN, target, label: f.label });
		keptTargets.add(target);
		const marker = ` [${nextN}]`;
		const insertAt = f.end + offset;
		newBody = newBody.slice(0, insertAt) + marker + newBody.slice(insertAt);
		offset += marker.length;
	}

	const dropped = refs.length - kept.length;
	const added = newRefs.length;
	return {
		refs: [...kept, ...newRefs].sort((a, b) => a.n - b.n),
		body: newBody,
		changed: dropped > 0 || added > 0,
		dropped,
		added,
	};
}
