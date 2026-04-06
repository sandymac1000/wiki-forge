# Vault Setup

Copy the contents of this folder into your Obsidian vault to get started.

## Structure to create in your vault

```
your-vault/
├── personas/
│   └── example-investor.md    ← copy and edit with your own lens
├── templates/
│   ├── pre-board-briefing.md  ← edit to match your preferred format
│   └── meeting-note.md        ← edit to match your preferred format
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

Each file in `personas/` is a lens you can switch between in the Wiki Ingest tab.

Frontmatter fields:
- `name` — display name in the selector
- `id` — unique slug
- `fund` — optional, shown alongside name
- `default` — set to `true` for your primary persona
- `public` — set to `true` if this persona contains no personal/identifying information

The body of the file is the persona description — tell it who you are, how you think, what you care about, how you want outputs to read.

## Templates

Files in `templates/` are loaded by the Suggestions engine when generating follow-on documents. Name them to match the `template_type` values that Wiki Forge uses:

- `pre-board-briefing.md`
- `meeting-note.md`
- `ic-memo.md`
- `analysis.md`
- `summary.md`
- `comparison.md`

If a template exists for a suggested action, Wiki Forge uses it as the output structure. If not, Claude generates using its own structure.

## All personal data stays in the vault

The wiki-forge app code contains zero personal or identifying information. Personas, portfolio entities, and templates all live in your vault — on your machine, never committed to any repository.
