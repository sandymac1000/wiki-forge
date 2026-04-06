# Vault Setup

Copy the contents of this folder into your Obsidian vault to get started with Wiki Forge.

## Structure to create in your vault

```
your-vault/
├── personas/
│   ├── researcher-primary.md    ← your main lens — edit with your own context
│   └── researcher-secondary.md ← alternate lens — edit or delete
├── templates/
│   ├── briefing.md              ← structured briefing template
│   └── meeting-note.md          ← meeting note template
├── wiki/
│   ├── INDEX.md
│   ├── log.md
│   ├── summaries/
│   ├── entities/
│   ├── concepts/
│   ├── comparisons/
│   └── query-results/
└── raw/
    └── assets/
```

## Personas

Each file in `personas/` is a lens you can switch between in the Ingest and Query tabs.

Frontmatter fields:
- `name` — display name in the selector
- `id` — unique slug
- `context` — optional short label shown alongside name
- `default` — set `true` for your primary persona
- `public` — set `true` if this persona contains no personal or identifying information

The body of the file is your persona description — who you are in this mode, how you think, what you care about, how you want outputs to read. Write it in the second person ("You are...").

## Templates

Files in `templates/` are used by the Suggestions engine when generating follow-on documents. Name them to match the `template_type` values Wiki Forge uses:

- `briefing.md`
- `meeting-note.md`
- `analysis.md`
- `summary.md`
- `comparison.md`

Add your own template types freely — just reference the filename (without `.md`) in your persona descriptions if you want the suggestions engine to prefer them.

## All personal data stays in the vault

The wiki-forge app code contains zero personal or identifying information. Personas and templates live in your vault — on your machine, never committed to any repository.
