# Prompt Forge

A prompt library and optimisation system built on Obsidian, with AI-assisted classification, typed context params, and a race-improve loop.

---

## What problem does this solve?

Most prompt management is a folder of markdown files with no structure, no metadata, and no way to know which prompts actually work. Prompt Forge treats prompts as first-class software artefacts with types, versions, ratings, and an evolutionary lifecycle.

---

## Core concepts

### Prompts as typed templates

Every prompt in the vault has frontmatter that defines its interface:

```yaml
---
title: Research Paper Digest
category: research
subcategory: paper-digest
params: audience, style, paper
description: Structured critical analysis of a research paper.
version: 1
rating: null
last_used: null
---
```

The `params` field is the key innovation — it's a type system for prompts. It declares what context variables the prompt needs at runtime, so Runner can present the right input fields automatically.

### The lifecycle

```
Inbox → Vault → Runner → Improvements
                  ↕
               Variants
```

**Inbox** — paste any raw prompt from anywhere (Twitter, papers, your own experiments). Claude classifies it, infers its params, and files it in your vault with proper frontmatter.

**Vault** — browse, edit, rate, and clone your prompt library. The vault mirrors your Obsidian vault directly — every file is a real `.md` file you own.

**Runner** — select a prompt, fill in its params, optionally fetch a paper by URL (arXiv, bioRxiv, PubMed), and run it. Rate the output 1–5 and add notes. Ratings feed directly into Improvements.

**Variants** — explores the solution space *horizontally*. Given a base prompt, Claude generates 3 distinct approaches (analytical, concise, socratic). Race them on the same context simultaneously, see outputs side by side, vote for the winner. Only the winner is saved — to your vault, rated 4/5, ready for Improvements.

**Improvements** — climbs the hill *vertically*. Takes any rated prompt (1–4), reads your rating and notes, proposes a specific rewrite with a diff view showing exactly what changed. Approve → version bumps, original archived, new version written to vault. Rename on approve if the improved prompt has become something distinct.

**Registry** — portfolio view across all prompts. Filter by category, search by title/description/params, sort by rating or last used. Shows the prompt slug (stable identity) primary, title secondary.

---

## Variants vs Improvements — the key distinction

**Variants** explores different *instruction approaches* to the same job:
- "Analyse this company" → Analytical (Porter's Five Forces) vs Concise (bullet assessment) vs Socratic (question-driven)
- You race them on real context and vote — empirical selection, not preference
- The winning *instruction set* is saved as a template

**Improvements** evolves a single prompt iteratively:
- Claude reads the prompt + your feedback ("output was too generic, lacked quantitative benchmarks")
- Proposes specific edits to the prompt text itself — a diff you can approve, reject, or modify
- Version history is preserved in `_archive/`

Together: Variants explores the solution space horizontally. Improvements climbs the hill vertically. Use Variants first to find the right approach, then Improvements to refine it.

---

## Setup

### Prerequisites

- [Obsidian](https://obsidian.md) with the [Local REST API plugin](https://github.com/coddingtonbear/obsidian-local-rest-api) installed and enabled
- Node.js 18+
- An Anthropic API key

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

Edit `.env`:

```
VITE_ANTHROPIC_API_KEY=sk-ant-...
VITE_OBSIDIAN_TOKEN=your-token-here
```

Your Obsidian token is in **Obsidian Settings → Community Plugins → Local REST API → API Key**.

### Run

```bash
npm run dev
```

Open `http://localhost:5173`.

---

## Vault structure

Prompt Forge expects prompts under a `prompts/` folder in your vault:

```
prompts/
  _context/
    sandy.md          ← injected into every run (your background, style prefs)
    personas.md       ← available personas for Runner
  _templates/
    vc/               ← categorised by type
    research/
    learning/
    reasoning/
    tools/
  _variants/
    paper-digest/     ← race winners, per base prompt
      analytical-bioinformatics.md
  _archive/
    board-prep-v1.md  ← previous versions, auto-archived on approve
```

The `_context/sandy.md` file is injected into every Runner execution as background context. Edit it to match your background, working style, and output preferences.

---

## Context injection

Runner automatically injects `_context/sandy.md` and `_context/personas.md` as the system prompt prefix before every run. This means your personal context (role, style, portfolio) is always present without you having to repeat it.

The **copy full prompt** button assembles the complete prompt — context + template + params — for pasting into Claude.ai web when you need to attach PDFs or other files.

---

## Paper fetch

Runner and Variants support fetching paper content directly by URL:

- **arXiv** — `arxiv.org/abs/2401.12345` or `arxiv.org/pdf/...`
- **bioRxiv** — `biorxiv.org/content/...`
- **PubMed** — `pubmed.ncbi.nlm.nih.gov/...`
- **Generic URLs** — best effort HTML extraction

Fetched content is injected into the run automatically. If no paper is provided and the prompt mentions "paper", "document", or "materials", Claude will ask for them before proceeding.

---

## Prompt identity

The filename slug is the stable identity of a prompt — it never changes unless you explicitly move the file. The frontmatter `title` is a human-readable label that can evolve as you rename through improvements.

This means:
- Version history (`v1`, `v2`) tracks a single slug
- Variant win/loss records are keyed to the slug
- Registry always shows slug primary, title secondary

---

## Limitations

Prompt Forge is a **local-first** application. The Obsidian Local REST API runs on `localhost:27123` — it cannot be accessed from a deployed URL. This means:

- Runner, Vault, Variants, Improvements, Registry all require Obsidian running locally
- Inbox classification and the Anthropic API calls work from any deployment
- A fully cloud-hosted version would require a different vault backend

---

## Stack

- React + Vite + Tailwind
- Obsidian Local REST API (vault read/write)
- Anthropic Claude API (classification, improvement proposals, variant generation)
- No database — the vault is the source of truth

---

## Acknowledgements

Built with [Obsidian](https://obsidian.md), [Claude](https://anthropic.com), and the [Local REST API plugin](https://github.com/coddingtonbear/obsidian-local-rest-api) by Adam Coddington.
