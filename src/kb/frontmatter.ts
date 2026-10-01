export interface FrontmatterData {
	[key: string]: unknown;
}

function parseScalar(raw: string): unknown {
	const s = raw.trim();
	if (s.length === 0) return '';
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		return s
			.slice(1, -1)
			.replace(/\\(["\\])/g, '$1')
			.replace(/\\n/g, '\n');
	}
	if (s === 'true') return true;
	if (s === 'false') return false;
	if (s === 'null' || s === '~') return null;
	if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
	return s;
}

function parseInlineObject(raw: string): FrontmatterData {
	const inner = raw.trim().replace(/^\{/, '').replace(/\}$/, '');
	const out: FrontmatterData = {};
	let current = '';
	let inStr: string | null = null;
	const fields: string[] = [];
	for (let i = 0; i < inner.length; i++) {
		const c = inner[i];
		if (inStr) {
			current += c;
			if (c === inStr && inner[i - 1] !== '\\') inStr = null;
		} else if (c === '"' || c === "'") {
			inStr = c;
			current += c;
		} else if (c === ',') {
			fields.push(current);
			current = '';
		} else {
			current += c;
		}
	}
	if (current.trim().length > 0) fields.push(current);
	for (const field of fields) {
		const idx = field.indexOf(':');
		if (idx === -1) continue;
		const key = field.slice(0, idx).trim();
		if (key.length === 0) continue;
		out[key] = parseScalar(field.slice(idx + 1));
	}
	return out;
}

export function parseFrontmatter(content: string): {
	data: FrontmatterData;
	body: string;
} {
	const lines = content.split('\n');
	if (lines[0]?.trim() !== '---') return { data: {}, body: content };
	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i]?.trim() === '---') {
			end = i;
			break;
		}
	}
	if (end === -1) return { data: {}, body: content };

	const data: FrontmatterData = {};
	let listKey: string | null = null;
	for (let i = 1; i < end; i++) {
		const line = lines[i] ?? '';
		if (line.trim() === '' || line.trim().startsWith('#')) continue;
		const itemMatch = line.match(/^\s+-\s+(.*)$/);
		if (itemMatch && listKey) {
			const raw = (itemMatch[1] ?? '').trim();
			const list = (data[listKey] as unknown[]) ?? [];
			if (raw.startsWith('{') && raw.endsWith('}')) {
				list.push(parseInlineObject(raw));
			} else {
				list.push(parseScalar(raw));
			}
			data[listKey] = list;
			continue;
		}
		const kvMatch = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
		if (kvMatch) {
			const key = kvMatch[1];
			if (!key) continue;
			const value = (kvMatch[2] ?? '').trim();
			if (value === '') {
				data[key] = [];
				listKey = key;
			} else if (value.startsWith('{') && value.endsWith('}')) {
				data[key] = parseInlineObject(value);
				listKey = null;
			} else {
				data[key] = parseScalar(value);
				listKey = null;
			}
		}
	}
	const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '');
	return { data, body };
}

function quoteString(s: string): string {
	return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

function serializeValue(v: unknown): string {
	if (typeof v === 'number' || typeof v === 'boolean') return String(v);
	if (v === null) return 'null';
	if (typeof v === 'string') return quoteString(v);
	return quoteString(JSON.stringify(v));
}

export function serializeFrontmatter(data: FrontmatterData): string {
	const lines: string[] = ['---'];
	for (const [key, value] of Object.entries(data)) {
		if (value === undefined || value === null) continue;
		if (Array.isArray(value)) {
			if (value.length === 0) {
				lines.push(`${key}: []`);
				continue;
			}
			lines.push(`${key}:`);
			for (const item of value) {
				if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
					const fields = Object.entries(item as FrontmatterData)
						.filter(([, v]) => v !== undefined && v !== null)
						.map(([k, v]) => `${k}: ${serializeValue(v)}`)
						.join(', ');
					lines.push(`  - { ${fields} }`);
				} else {
					lines.push(`  - ${serializeValue(item)}`);
				}
			}
		} else if (typeof value === 'object') {
			const fields = Object.entries(value as FrontmatterData)
				.map(([k, v]) => `${k}: ${serializeValue(v)}`)
				.join(', ');
			lines.push(`${key}: { ${fields} }`);
		} else {
			lines.push(`${key}: ${serializeValue(value)}`);
		}
	}
	lines.push('---');
	return lines.join('\n');
}
