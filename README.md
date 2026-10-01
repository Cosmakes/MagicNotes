# MagicNotes

MagicNotes turns your notes into a browsable knowledge base. An LLM classifies each note into topics and subtopics, drafts the knowledge-base entry for your review, and archives the original note. A second agent answers questions about any PDF in your vault, with clickable page citations.

## Features

- **Ingest notes into a knowledge base** — a sparkles button in the note header (or the command **Ingest active note into knowledge base**) runs a guided LLM workflow:
  1. **Analyze** — the LLM classifies the note against your existing topics.
  2. **Choose target** — pick an existing subtopic, or create a new subtopic or topic (names are editable).
  3. **Draft** — the LLM drafts the subtopic entry, with numbered references to the sources in the note.
  4. **Review & edit** — review a line diff against the existing entry, edit the text directly, or ask the LLM to revise it.
  5. **Save** — the entry is written to the knowledge base and the source note is archived, renamed with the ingestion date.
  - Interrupted ingests can be resumed later.
- **Knowledge base views** — a brain icon in the ribbon opens a searchable archive of topics. Each topic opens a detail view with a searchable subtopic list and a rendered subtopic panel with clickable references.
- **Ask about PDFs** — a robot button in the PDF view header (or the command **Ask about the open PDF**) opens a chat panel. Answers are grounded in the PDF text and cite pages as clickable chips that jump to that page in the PDF.
- **Bring your own LLM** — works with any OpenAI-compatible endpoint: base URL, API key, model, reasoning effort, max tokens, temperature, plus a connection test button.

## Requirements

- Obsidian 1.7.2 or newer
- An OpenAI-compatible LLM endpoint (OpenAI, or a local/self-hosted server)

## Installation

**From the community:** Settings → Community plugins → Browse → **MagicNotes** → Install → Enable.

**Manually:** download `main.js`, `manifest.json`, and `styles.css` from the latest GitHub release and place them in `<Vault>/.obsidian/plugins/magicnotes/`.

## Setup

1. Open **Settings → MagicNotes**.
2. Enter your LLM **Base URL** (including the version path, e.g. `https://api.openai.com/v1`), **API key**, and **Model**.
3. Press **Test connection**.
4. Optionally adjust the knowledge base folder (default `MapTheMind`), base notes folder (default `BaseNotes`), LLM verbosity, and panel split directions.

## Usage

- Open a note and press the sparkles button in the note header to ingest it into the knowledge base.
- Open the knowledge base via the brain icon in the ribbon, search topics, and click through to subtopics.
- Open a PDF and press the robot button in the PDF header to ask questions about it.

## Data and privacy

- Note contents, existing topic names, and PDF text are sent to the LLM endpoint you configure. Nothing else leaves your vault.
- The API key is stored locally in the plugin's `data.json` and is only sent to your configured base URL.
- No telemetry. No other network requests.

## Development

```bash
npm install
npm run dev     # watch mode
npm run build   # type-check + production bundle
npm run lint
```

## License

0BSD
