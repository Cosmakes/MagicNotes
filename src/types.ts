export type Verbosity = 'concise' | 'balanced' | 'detailed';

export interface Reference {
	n: number;
	target: string;
	label: string;
}

export interface SubtopicMeta {
	path: string;
	topic: string;
	name: string;
	summary: string;
	body: string;
	references: Reference[];
	sources?: string[];
	ingestedFrom?: string;
	originalPath?: string;
	ingestedAt?: string;
}

export interface TopicMeta {
	name: string;
	subtopics: SubtopicMeta[];
}

export interface KbIndexData {
	topics: Map<string, TopicMeta>;
	byPath: Map<string, SubtopicMeta>;
}

export interface DraftReference {
	n: number;
	target: string;
	label: string;
}

export interface IngestDraft {
	title?: string;
	summary: string;
	body: string;
	references: DraftReference[];
}

export type SuggestionKind = 'existing-subtopic' | 'new-subtopic' | 'new-topic';

export interface IngestSuggestion {
	kind: SuggestionKind;
	topic: string;
	subtopic?: string;
	reason: string;
}

export interface IngestTarget {
	kind: SuggestionKind;
	topic: string;
	subtopic?: string;
}

export type IngestStep = 'analyzing' | 'choose' | 'drafting' | 'review' | 'saving';

export interface IngestChatTurn {
	role: 'user' | 'assistant';
	content: string;
}

export interface IngestState {
	sourcePath: string;
	step: IngestStep;
	suggestions?: IngestSuggestion[];
	target?: IngestTarget;
	plannedSourcePath?: string;
	draft?: IngestDraft;
	chatHistory: IngestChatTurn[];
}
