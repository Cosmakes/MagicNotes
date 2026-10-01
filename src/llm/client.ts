import { requestUrl } from 'obsidian';

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface LlmSettings {
	baseUrl: string;
	apiKey: string;
	model: string;
	reasoningEffort: 'off' | 'low' | 'medium' | 'high';
	maxTokens: number;
	temperature: number;
}

export class LlmError extends Error {
	retryable: boolean;

	constructor(message: string, retryable: boolean) {
		super(message);
		this.name = 'LlmError';
		this.retryable = retryable;
	}
}

export function isLlmConfigured(s: LlmSettings): boolean {
	return s.baseUrl.length > 0 && s.apiKey.length > 0 && s.model.length > 0;
}

export async function chat(
	settings: LlmSettings,
	messages: ChatMessage[],
	opts?: { maxTokens?: number; temperature?: number },
): Promise<string> {
	const body: Record<string, unknown> = {
		model: settings.model,
		messages,
		temperature: opts?.temperature ?? settings.temperature,
		max_tokens: opts?.maxTokens ?? settings.maxTokens,
	};
	if (settings.reasoningEffort !== 'off') {
		body.reasoning_effort = settings.reasoningEffort;
	}
	let res: Awaited<ReturnType<typeof requestUrl>>;
	try {
		res = await requestUrl({
			url: `${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${settings.apiKey}`,
			},
			body: JSON.stringify(body),
		});
	} catch (e) {
		throw mapRequestError(e);
	}
	const data = res.json as { choices?: { message?: { content?: unknown } }[] };
	const content = data.choices?.[0]?.message?.content;
	if (typeof content !== 'string') {
		throw new LlmError('Unexpected response shape from LLM endpoint.', false);
	}
	return content;
}

function mapRequestError(e: unknown): LlmError {
	const msg = e instanceof Error ? e.message : String(e);
	const statusMatch = msg.match(/status code (\d{3})/i);
	const status = statusMatch ? Number(statusMatch[1]) : null;
	if (status === 401) return new LlmError('Invalid API key.', false);
	if (status === 403) return new LlmError('Access denied by the LLM endpoint.', false);
	if (status === 404) return new LlmError('Model not found at this base URL.', false);
	if (status === 429) return new LlmError('Rate limited. Try again shortly.', true);
	if (status !== null && status >= 500) {
		return new LlmError(`LLM server error (HTTP ${status}).`, true);
	}
	if (/timed? ?out/i.test(msg)) return new LlmError('Request timed out.', true);
	if (status !== null && status >= 400) {
		return new LlmError(`LLM request failed (HTTP ${status}).`, false);
	}
	return new LlmError(msg, true);
}
