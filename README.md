# Prompt Forge — UPDATED

A prompt vault manager with human-in-the-loop improvement loop for Obsidian.

Built for people who treat prompts as a serious asset — versioned, rated, and iteratively improved.

## What it does

- **Vault** — full CRUD browser for your Obsidian prompt library
- **Runner** — execute prompts with real temperature control via Anthropic API, with streaming output
- **Variants** — manage persona variants per template (coming soon)
- **Improvements** — Claude-proposed deltas based on your ratings, approve/reject (coming soon)
- **Registry** — table view across all prompts, ratings, and versions (coming soon)

## Prerequisites

- [Obsidian](https://obsidian.md) with the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) community plugin installed and running on HTTP (port 27123)
- An [Anthropic API key](https://console.anthropic.com/settings/keys) (Claude Pro/Max/API)
- Node.js 18+

## Setup

```bash
git clone https://github.com/sandymac1000/prompt-forge.git
cd prompt-forge
npm install
cp .env.example .env
```

Edit `.env` with your keys:

```
VITE_ANTHROPIC_API_KEY=sk-ant-...
VITE_OBSIDIAN_TOKEN=your-obsidian-local-rest-api-token
```

## Run locally

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173)

> **Note:** Obsidian must be open and the Local REST API plugin active for vault features to work. Enable the HTTP (non-encrypted) server in the plugin settings.

## Vault structure

Prompt Forge works best with a structured vault:

```
prompts/
  _templates/     ← reusable prompt templates
    vc/
    learning/
    tools/
  _variants/      ← persona variants per template (coming soon)
  _used/          ← instantiated prompts with ratings
  _context/       ← persona and user context files
```

## Prompt frontmatter

Prompt Forge reads and writes these frontmatter fields:

```yaml
---
title: Board prep
tags: [prompt/vc/board-prep]
version: 1
rating: null
last_used: null
notes: ""
---
```

Ratings are written back to the vault automatically after each run.

## Tech stack

- React + Vite
- Tailwind CSS
- Obsidian Local REST API
- Anthropic Claude API (streaming)
- Deployed via Vercel

## Roadmap

- [ ] Variant management per template
- [ ] Improvement loop — Claude proposes diffs, human approves
- [ ] Registry dashboard with Dataview-style filtering
- [ ] Temperature presets saved per variant
- [ ] Export rated outputs as training examples

## Licence

MIT