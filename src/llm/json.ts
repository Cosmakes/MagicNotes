import { chat, LlmError, type ChatMessage, type LlmSettings } from './client';

export function extractJson(text: string): unknown {
	let t = text.trim();
	const fence = t.match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```\s*$/);
	if (fence && fence[1]) t = fence[1].trim();
	// The first JSON value may be an object ({...}) or a bare array ([...]).
	let start = -1;
	for (let i = 0; i < t.length; i++) {
		if (t[i] === '{' || t[i] === '[') {
			start = i;
			break;
		}
	}
	if (start === -1) throw new Error('No JSON value found in LLM response.');
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = start; i < t.length; i++) {
		const c = t[i];
		if (inStr) {
			if (esc) esc = false;
			else if (c === '\\') esc = true;
			else if (c === '"') inStr = false;
		} else if (c === '"') {
			inStr = true;
		} else if (c === '{' || c === '[') {
			depth++;
		} else if (c === '}' || c === ']') {
			depth--;
			if (depth === 0) {
				const slice = t.slice(start, i + 1);
				try {
					return JSON.parse(slice);
				} catch (e) {
					throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
				}
			}
		}
	}
	throw new Error('Unbalanced JSON in LLM response.');
}

export function asNumber(v: unknown): number | undefined {
	if (typeof v === 'number' && Number.isFinite(v)) return v;
	if (typeof v === 'string' && v.length > 0 && Number.isFinite(Number(v))) return Number(v);
	return undefined;
}

export async function chatJson<T>(
	settings: LlmSettings,
	messages: ChatMessage[],
	validate: (v: unknown) => T,
): Promise<T> {
	let lastError = '';
	for (let attempt = 0; attempt < 2; attempt++) {
		const msgs =
			attempt === 0
				? messages
				: [
						...messages,
						{
							role: 'user' as const,
							content:
								`Your previous reply was not valid JSON (${lastError}). ` +
								'Reply again with ONLY the JSON (object or array), no prose and no code fences.',
						},
					];
		const text = await chat(settings, msgs);
		try {
			return validate(extractJson(text));
		} catch (e) {
			lastError = e instanceof Error ? e.message : String(e);
		}
	}
	throw new LlmError(`LLM returned invalid JSON after retry: ${lastError}`, false);
}

export function headTailTruncate(text: string, head: number, tail: number): string {
	if (text.length <= head + tail) return text;
	return `${text.slice(0, head)}\n…[truncated]…\n${text.slice(-tail)}`;
}
