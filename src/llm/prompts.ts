import { chat, type LlmSettings } from './client';
import { asNumber, chatJson, headTailTruncate } from './json';
import type {
	IngestChatTurn,
	IngestDraft,
	IngestSuggestion,
	IngestTarget,
	TopicMeta,
	Verbosity,
} from '../types';

const MAX_INDEX_ENTRIES = 300;
const NOTE_HEAD = 20000;
const NOTE_TAIL = 4000;
const P4A_SNIPPET_CHARS = 160;
const P4A_MAX_PAGES = 400;
const P4A_MAX_SELECTED = 20;
const P4B_HEAD = 6000;
const P4B_TAIL = 2000;
const P3_MAX_TURNS = 6;

export function verbosityInstruction(level: Verbosity): string {
	switch (level) {
		case 'concise':
			return 'Keep the response concise: use minimal prose and short bullets only when needed.';
		case 'balanced':
			return 'Keep the response clear and direct, without padding.';
		case 'detailed':
			return 'Be thorough and structured, including useful context and organized detail.';
	}
}

// ── P1: classify ──────────────────────────────────────────────────────────────

function buildIndexText(topics: TopicMeta[]): string {
	if (topics.length === 0) {
		return '(empty — no topics yet)';
	}
	const ordered = [...topics].sort((a, b) => {
		const ra = recency(a);
		const rb = recency(b);
		if (rb !== ra) return rb - ra;
		return a.name.localeCompare(b.name);
	});
	const lines: string[] = [];
	for (const t of ordered) {
		lines.push(`Topic: ${t.name}`);
		for (const s of t.subtopics) {
			lines.push(`  - ${s.name}: ${s.summary.length > 0 ? s.summary : '(no summary)'}`);
		}
	}
	const total = lines.length;
	const kept = lines.slice(0, MAX_INDEX_ENTRIES);
	let text = kept.join('\n');
	if (total > kept.length) {
		text += `\n…[truncated: showing ${kept.length} of ${total} entries, most recent first]`;
	}
	return text;
}

function recency(t: TopicMeta): number {
	let max = 0;
	for (const s of t.subtopics) {
		if (s.ingestedAt) {
			const t0 = Date.parse(s.ingestedAt);
			if (Number.isFinite(t0) && t0 > max) max = t0;
		}
	}
	return max;
}

export function classifyNote(
	settings: LlmSettings,
	noteTitle: string,
	noteBody: string,
	topics: TopicMeta[],
	verbosity: Verbosity,
): Promise<IngestSuggestion[]> {
	const system =
		'You are the knowledge-base classifier for MagicNotes, an Obsidian plugin that ' +
		'organizes neuroscience notes into topics and subtopics (e.g. topic "Spatial coding in ' +
		'the hippocampus", subtopic "Place cell dynamics in CA1"). ' +
		'Decide where the new note belongs. Prefer an existing subtopic when the note clearly ' +
		'extends one. Choose a new subtopic under an existing topic when the topic fits but no ' +
		'subtopic does. Choose a new topic only when the note fits no existing topic. ' +
		'Respond with ONLY a JSON object: ' +
		'{"suggestions":[{"kind":"existing-subtopic"|"new-subtopic"|"new-topic","topic":"...","subtopic":"...","reason":"one sentence"}]} ' +
		'Omit "subtopic" for new-topic. At most 3 suggestions, best first. ' +
		'For existing-subtopic and new-subtopic, "topic" must be an exact existing topic name. ' +
		'Keep names short, specific, and in sentence case. ' +
		verbosityInstruction(verbosity);
	const user =
		`Existing knowledge base:\n${buildIndexText(topics)}\n\n` +
		`New note "${noteTitle}":\n${headTailTruncate(noteBody, NOTE_HEAD, NOTE_TAIL)}`;
	return chatJson<IngestSuggestion[]>(settings, [
		{ role: 'system', content: system },
		{ role: 'user', content: user },
	], validateSuggestions);
}

function validateSuggestions(v: unknown): IngestSuggestion[] {
	if (typeof v !== 'object' || v === null) throw new Error('expected an object');
	const raw = (v as { suggestions?: unknown }).suggestions;
	if (!Array.isArray(raw)) throw new Error('missing "suggestions" array');
	const out: IngestSuggestion[] = [];
	for (const item of raw) {
		if (item === null || typeof item !== 'object') continue;
		const o = item as Record<string, unknown>;
		const kind = o.kind;
		if (kind !== 'existing-subtopic' && kind !== 'new-subtopic' && kind !== 'new-topic') continue;
		const topic = typeof o.topic === 'string' ? o.topic.trim() : '';
		if (topic.length === 0) continue;
		const subtopic = typeof o.subtopic === 'string' ? o.subtopic.trim() : undefined;
		if (kind !== 'new-topic' && !subtopic) continue;
		out.push({
			kind,
			topic,
			subtopic,
			reason: typeof o.reason === 'string' ? o.reason : '',
		});
		if (out.length >= 3) break;
	}
	if (out.length === 0) throw new Error('no valid suggestions');
	return out;
}

// ── P2: draft ─────────────────────────────────────────────────────────────────

export interface DraftContext {
	sourceTitle: string;
	sourceBody: string;
	sourcePath: string;
	sourceLink: string;
	target: IngestTarget;
	targetContent?: string;
	targetSubtopics?: string[];
}

export function draftSubtopic(
	settings: LlmSettings,
	ctx: DraftContext,
	verbosity: Verbosity,
): Promise<IngestDraft> {
	const system =
		'You are the drafting engine for MagicNotes, a neuroscience knowledge base in Obsidian. ' +
		'Write the content of one subtopic note from a source note. ' +
		'Rules: ' +
		'- "body" is well-structured markdown. Start with a short summary paragraph, then details. Do not include a title heading. ' +
		'- Include the provided source-note wikilink inline in the summary paragraph (or in the section updated from that source) exactly as given. Do not create or preserve a separate "Sources" section; if one is present in the target content, move any useful links inline and omit the section. ' +
		'- Preserve existing inline source links from the target content, and preserve EVERY link found in the source note: wikilinks, markdown links, bare vault paths, and external http(s) URLs. For each link put a [n] citation marker in the text at the spot it was mentioned and list it in "references" with its target: for vault files give the plain file path WITHOUT wikilink brackets (e.g. "folder/paper.pdf#page=3"), for external links the full URL (keep any #page=N fragment on PDF links verbatim). Never drop a link. ' +
		'Respond with ONLY a JSON object: ' +
		'{"title":"...","summary":"one line","body":"...","references":[{"n":1,"target":"...","label":"..."}]}. ' +
		verbosityInstruction(verbosity);

	const targetDesc =
		ctx.target.kind === 'existing-subtopic'
			? `Target: existing subtopic "${ctx.target.topic} / ${ctx.target.subtopic}". Its current content:\n${headTailTruncate(ctx.targetContent ?? '', NOTE_HEAD, NOTE_TAIL)}`
			: ctx.target.kind === 'new-subtopic'
				? `Target: new subtopic "${ctx.target.subtopic}" under existing topic "${ctx.target.topic}". Existing subtopics of that topic:\n${(ctx.targetSubtopics ?? []).map((s) => `- ${s}`).join('\n') || '(none yet)'}`
				: `Target: new topic "${ctx.target.topic}" (no existing subtopics).`;

	const user =
		`Source note "${ctx.sourceTitle}":\n${headTailTruncate(ctx.sourceBody, NOTE_HEAD, NOTE_TAIL)}\n\n` +
		`Current source link to include inline: ${ctx.sourceLink} ` +
		`(use the plain path "${ctx.sourcePath}" without wikilink brackets in "references").\n\n` +
		`${targetDesc}`;

	return chatJson<IngestDraft>(settings, [
		{ role: 'system', content: system },
		{ role: 'user', content: user },
	], validateDraft);
}

export function validateDraft(v: unknown): IngestDraft {
	if (typeof v !== 'object' || v === null) throw new Error('expected an object');
	const o = v as Record<string, unknown>;
	const body = typeof o.body === 'string' ? o.body : '';
	if (body.length === 0) throw new Error('missing "body"');
	const references: IngestDraft['references'] = [];
	if (Array.isArray(o.references)) {
		for (const item of o.references) {
			if (item === null || typeof item !== 'object') continue;
			const r = item as Record<string, unknown>;
			const n = asNumber(r.n);
			const target = typeof r.target === 'string' ? r.target.trim() : '';
			if (n === undefined || target.length === 0) continue;
			references.push({ n, target, label: typeof r.label === 'string' ? r.label : target });
		}
	}
	references.sort((a, b) => a.n - b.n);
	return {
		title: typeof o.title === 'string' ? o.title : undefined,
		summary: typeof o.summary === 'string' ? o.summary : '',
		body,
		references,
	};
}

// ── P3: edit ──────────────────────────────────────────────────────────────────

export function editDraft(
	settings: LlmSettings,
	draft: IngestDraft,
	history: IngestChatTurn[],
	instruction: string,
	verbosity: Verbosity,
): Promise<IngestDraft> {
	const system =
		'You are editing a subtopic draft for MagicNotes, a neuroscience knowledge base in Obsidian. ' +
		'Apply the user\'s edit instruction to the current draft and return the FULL updated draft as a JSON object with exactly this schema: ' +
		'{"title":"...","summary":"one line","body":"markdown with [n] citation markers","references":[{"n":1,"target":"...","label":"..."}]} ' +
		'Keep all [n] citation markers consistent with "references". Preserve inline source-note wikilinks and do not add a "Sources" section. Respond with ONLY the JSON object. ' +
		verbosityInstruction(verbosity);
	const draftJson = JSON.stringify({
		...draft,
		body: headTailTruncate(draft.body, NOTE_HEAD, NOTE_TAIL),
	});
	const turns = history.slice(-P3_MAX_TURNS);
	const user =
		`Current draft:\n${draftJson}\n\n` +
		(turns.length > 0
			? `Previous edit conversation:\n${turns.map((t) => `${t.role}: ${t.content}`).join('\n')}\n\n`
			: '') +
		`Edit instruction: ${instruction}`;
	return chatJson<IngestDraft>(settings, [
		{ role: 'system', content: system },
		{ role: 'user', content: user },
	], validateDraft);
}

// ── P4a: page select ──────────────────────────────────────────────────────────

export function selectPdfPages(
	settings: LlmSettings,
	question: string,
	pages: Map<number, string>,
): Promise<number[]> {
	const ordered = Array.from(pages.keys()).sort((a, b) => a - b);
	const range = parsePageRange(question);
	const inRange = ordered.filter((p) =>
		range ? p >= range[0] && p <= range[1] : true,
	).slice(0, P4A_MAX_PAGES);
	const snippets = inRange
		.map((p) => `Page ${p}: ${(pages.get(p) ?? '').slice(0, P4A_SNIPPET_CHARS)}`)
		.join('\n');
	const system =
		'You select PDF pages that may contain the answer to a question. ' +
		'Respond with ONLY a JSON object: {"pages":[1,4,5]} listing page numbers (1-based) in order, most relevant first, at most 10 pages. ' +
		'Only use page numbers that appear in the provided snippets.';
	const user = `Question: ${question}\n\nPer-page snippets:\n${snippets}`;
	return chatJson<number[]>(settings, [
		{ role: 'system', content: system },
		{ role: 'user', content: user },
	], (v) => {
		// Accept either a bare array [1,4,5] or {"pages":[1,4,5]}.
		let raw: unknown = v;
		if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
			raw = (v as { pages?: unknown }).pages;
		}
		if (!Array.isArray(raw)) throw new Error('expected an array of page numbers');
		const valid = new Set(ordered);
		const out: number[] = [];
		for (const p of raw) {
			const n = asNumber(p);
			if (n === undefined || !valid.has(n) || out.includes(n)) continue;
			out.push(n);
			if (out.length >= P4A_MAX_SELECTED) break;
		}
		if (out.length === 0) throw new Error('no valid pages selected');
		return out;
	});
}

function parsePageRange(question: string): [number, number] | null {
	const range = question.match(/pages?\s+(\d+)\s*(?:-|–|to|through)\s*(\d+)/i);
	if (range && range[1] && range[2]) {
		const a = Number(range[1]);
		const b = Number(range[2]);
		return [Math.min(a, b), Math.max(a, b)];
	}
	const single = question.match(/page\s+(\d+)/i);
	if (single && single[1]) {
		const n = Number(single[1]);
		return [n, n];
	}
	return null;
}

// ── P4b: pdf answer ───────────────────────────────────────────────────────────

export function answerPdfQuestion(
	settings: LlmSettings,
	question: string,
	pages: Map<number, string>,
	selected: number[],
	history: IngestChatTurn[],
	verbosity: Verbosity,
): Promise<string> {
	const system =
		'You answer questions about a PDF document using ONLY the provided page text. ' +
		'Ground every claim in the text and cite pages inline as [pN] (e.g. "the authors report X [p3] [p7]"). ' +
		'If the answer is not present in the provided text, say exactly that it is not in this PDF. ' +
		'Do not use outside knowledge. Be factual. ' +
		verbosityInstruction(verbosity);
	const turns = history.slice(-P3_MAX_TURNS);
	const pageText = selected
		.map((p) => `[[page ${p}]]\n${headTailTruncate(pages.get(p) ?? '', P4B_HEAD, P4B_TAIL)}`)
		.join('\n\n');
	const user =
		(turns.length > 0
			? `Earlier conversation:\n${turns.map((t) => `${t.role}: ${t.content}`).join('\n')}\n\n`
			: '') +
		`Question: ${question}\n\nPDF text:\n${pageText}`;
	return chat(settings, [
		{ role: 'system', content: system },
		{ role: 'user', content: user },
	]);
}
