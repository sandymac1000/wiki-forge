# Wiki Forge

A local-first personal knowledge base built on Obsidian, with AI-assisted document ingestion, classification, summarisation, and synthesis. Drop in any document — PDF, PPTX, DOCX, XLSX, URL, or paste — and Claude converts it, classifies it, summarises it, and files it into the right section of your wiki automatically.

---

## Inspired by Karpathy — and where it diverges

Wiki Forge is directly inspired by Andrej Karpathy's personal LLM wiki pattern: a `raw/` layer of immutable source documents, a `wiki/` layer of LLM-generated and maintained pages, and a schema file (`CLAUDE.md`) that tells the LLM how the whole thing works.

The core architecture is the same. The divergences are deliberate:

**1. Automated ingest pipeline, not a tarball**
Karpathy's original pattern assumes you drop files into `raw/` and manually invoke Claude to process them. Wiki Forge automates the full pipeline: convert any format → classify → summarise → route → update index. Zero manual steps between dropping a PDF and having a structured wiki page.

**2. Node.js-native document conversion — no Python required**
PDF, DOCX, PPTX, and XLSX are all extracted in pure Node.js (pdf-parse, adm-zip + XML parsing). No dependency on markitdown, pandoc, or pymupdf4llm. This was a pragmatic choice for reliability on machines without a clean Python environment.

**3. Two-layer storage: raw + structured summary**
The tarball approach stores source documents in `raw/` and the LLM writes wiki pages. Wiki Forge does both: the full converted text goes to `raw/` as the immutable source, and a separately generated structured summary (Key Points, Open Questions, Counter-Arguments, Key Entities) goes to `wiki/`. The raw file is always available for full-fidelity direct analysis; the wiki page is optimised for synthesis across many sources.

**4. Structured summarisation, not raw filing**
Rather than storing the converted document text as the wiki page, Claude generates a structured analysis on every ingest. This makes wiki pages genuinely useful to read and cross-reference, and makes Query synthesis cheaper and more accurate.

**5. Persona/lens system**
All personal context lives in the vault (`personas/` directory), not in the app code. The same document is classified and summarised differently depending on which persona is active. The app ships with anonymous templates; you add your own personas to your vault.

**6. User-controlled cross-referencing**
Karpathy's schema states "a single source should touch 10–15 wiki pages." Wiki Forge proposes candidate links (entity name and tag matching against the index) but requires user approval before writing any cross-references. Automatic linking at scale produces spurious connections that are harder to remove than to prevent.

**7. `outputs/` folded into `wiki/query-results/`**
The referenced schema uses a separate `outputs/` directory for generated analyses and query answers. Wiki Forge files these into `wiki/query-results/` instead, keeping the entire knowledge graph in one connected structure that Obsidian's graph view and search can traverse.

**What we kept exactly:**
- `raw/` immutable, `wiki/` LLM-owned, `CLAUDE.md` as schema
- `wiki/INDEX.md` as the primary retrieval index
- `wiki/log.md` as an append-only activity record
- Lint workflow (defined in CLAUDE.md, not yet a UI feature)
- Status field (`draft | reviewed | needs_update`) and contradiction flagging conventions

---

## Setup

### Prerequisites

- [Obsidian](https://obsidian.md) with the [Local REST API plugin](https://github.com/coddingtonbear/obsidian-local-rest-api) installed and enabled
- Node.js 18+
- An Anthropic API key

No Python required for core functionality. PDF, DOCX, PPTX, and XLSX are handled in Node.js.

### Install

```bash
git clone https://github.com/sandymac1000/wiki-forge.git
cd wiki-forge
npm install
```

### Configure

```bash
cp .env.example .env
```

Edit `.env`:

```
VITE_ANTHROPIC_API_KEY=sk-ant-...
VITE_OBSIDIAN_TOKEN=your-token-here
```

Your Obsidian token: **Obsidian Settings → Community Plugins → Local REST API → API Key**

> **Use HTTP, not HTTPS.** The Local REST API plugin defaults to HTTPS but Wiki Forge connects over HTTP on port `27123`. In the plugin settings confirm the HTTP port is `27123` and use the HTTP token. No certificate setup required.

### Run

```bash
npm run dev
```

Open `http://localhost:5173`. Obsidian must be running.

---

## Vault setup

Copy the templates from `vault-setup/` into your Obsidian vault:

```
your-vault/
├── CLAUDE.md           ← schema (copy from vault-setup/CLAUDE.md.example, fill in your context)
├── personas/           ← one .md file per lens (see vault-setup/personas/)
├── templates/          ← output templates (see vault-setup/templates/)
├── raw/                ← immutable source documents (auto-populated on ingest)
│   └── assets/
└── wiki/
    ├── INDEX.md        ← master catalog (auto-populated)
    ├── log.md          ← activity record (auto-populated)
    ├── summaries/
    ├── entities/
    ├── concepts/
    ├── comparisons/
    └── query-results/
```

---

## Ingest

Three input modes:

- **Paste** — notes, emails, thread copy, raw thoughts
- **URL** — fetches and converts any article, paper, or web page. Twitter/X uses oEmbed. arXiv abstract pages work well; point at the `abs/` URL not the PDF URL.
- **File** — PDF, DOCX, PPTX, XLSX, MD, TXT

Flow: convert → classify (title, tags, section, entities) → summarise (Key Points, Open Questions, Counter-Arguments) → save raw text to `raw/` + structured summary to `wiki/` → propose connections to existing pages → update INDEX.md and log.md.

---

## Query

Ask a question in plain language. Claude reads INDEX.md, identifies relevant wiki pages, synthesises an answer with citations, and optionally files the answer back as a `query-result` page. Token and cost tracking shown per query.

**When to use Query vs direct Claude analysis:**
- **Query** — synthesis across many sources, pattern-finding, "what does my research say about X"
- **Direct Claude + file** — deep analysis of one specific document; attach the file from `raw/` for full fidelity

---

## Personas

Create `.md` files in `your-vault/personas/` with YAML frontmatter:

```yaml
---
name: My Lens
id: my-lens
default: false
context: Optional short label
---

You are reviewing documents with a focus on...
```

The active persona shapes how documents are classified and summarised. No personal data lives in the app — all context is in your vault.

---

## Architecture

- React + Vite + Tailwind
- Obsidian Local REST API (vault read/write, localhost:27123)
- Anthropic Claude API (classification, summarisation, query synthesis)
- Vite middleware for document conversion — pure Node.js (pdf-parse, adm-zip)
- No database — the vault is the source of truth

---

## Acknowledgements

Inspired by [Andrej Karpathy's LLM wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). Built with [Obsidian](https://obsidian.md), [Claude](https://anthropic.com), and the [Local REST API plugin](https://github.com/coddingtonbear/obsidian-local-rest-api) by Adam Coddington.
