# Wiki Forge

A personal knowledge base and prompt management system built on Obsidian, with AI-assisted document ingestion, classification, and a prompt race-improve loop.

---

## What it does

Wiki Forge has two jobs:

**1. Wiki Ingest** — drop in any document (PDF, DOCX, PPTX, XLSX, URL, paste) and Claude classifies it, converts it to markdown, and files it into the right section of your Obsidian-backed knowledge wiki with proper frontmatter, TLDR, and index entries.

**2. Prompt Library** — treats prompts as first-class software artefacts with types, versions, ratings, and an evolutionary lifecycle (classify → run → variants → improvements).

---

## Setup

### Prerequisites

- [Obsidian](https://obsidian.md) with the [Local REST API plugin](https://github.com/coddingtonbear/obsidian-local-rest-api) installed and enabled
- Node.js 18+
- An Anthropic API key
- Python 3 with conversion tools (for Wiki Ingest file uploads):

```bash
pip install 'markitdown[all]' pymupdf4llm pptx2md
brew install pandoc
```

### Install

```bash
git clone https://github.com/sandymac1000/prompt-forge.git
cd prompt-forge
npm install
```

### Configure

```bash
cp .env.example .env
```

Edit `.env` (never commit this file — it's in `.gitignore`):

```
VITE_ANTHROPIC_API_KEY=sk-ant-...
VITE_OBSIDIAN_TOKEN=your-token-here
```

Your Obsidian token: **Obsidian Settings → Community Plugins → Local REST API → API Key**

### Run

```bash
npm run dev
```

Open `http://localhost:5173`. Obsidian must be running.

---

## Wiki Ingest

The first tab. Three input modes:

- **Paste** — notes, emails, thread copy, raw thoughts
- **URL** — fetches and converts any article, paper, or web page
- **File** — PDF, DOCX, PPTX, XLSX, MD, TXT

Claude classifies the content into the right wiki section (`summaries`, `entities`, `concepts`, `comparisons`, `query-results`), generates a TLDR and tags, and saves it directly to the vault. `wiki/log.md` and `wiki/INDEX.md` are updated automatically.

---

## Prompt lifecycle

```
Inbox → Vault → Runner → Improvements
                  ↕
               Variants
```

**Inbox** — paste any raw prompt. Claude classifies it and files it with proper frontmatter.

**Vault** — browse, edit, rate, and clone your prompt library.

**Runner** — select a prompt, fill in params, optionally fetch a paper by URL, run and rate.

**Variants** — generates 3 instruction approaches side-by-side. Race them, vote for the winner.

**Improvements** — AI-proposed rewrite with diff view. Approve → version bumps, original archived.

**Registry** — portfolio view. Filter, search, sort by rating or last used.

---

## Vault structure

```
your-vault/
├── wiki/                   ← managed by Wiki Ingest
│   ├── INDEX.md
│   ├── log.md
│   ├── summaries/
│   ├── entities/
│   ├── concepts/
│   ├── comparisons/
│   └── query-results/
├── raw/                    ← immutable source documents
│   └── assets/
└── prompts/                ← managed by prompt tabs
    ├── _context/
    │   └── sandy.md        ← injected into every Runner run
    ├── _templates/
    ├── _variants/
    └── _archive/
```

---

## Architecture

- React + Vite + Tailwind
- Obsidian Local REST API (vault read/write)
- Anthropic Claude API (classification, ingest, improvement, variants)
- Vite middleware for document conversion (markitdown / pandoc / pymupdf4llm / pptx2md)
- No database — the vault is the source of truth

**Local-first.** The Obsidian Local REST API runs on `localhost:27123`. Obsidian must be open and running for vault operations.

---

## Acknowledgements

Built with [Obsidian](https://obsidian.md), [Claude](https://anthropic.com), and the [Local REST API plugin](https://github.com/coddingtonbear/obsidian-local-rest-api) by Adam Coddington.
