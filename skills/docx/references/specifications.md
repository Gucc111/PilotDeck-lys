# DOCX CLI Specifications

Read this file before writing JSON for `create`, `edit`, or `review`. Use only documented fields and write specifications into the user's workspace.

Query the live schema first:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" schema --command create
```

The parser is strict. Unknown fields, blocks, and actions fail instead of being ignored.
Document-writing commands refuse to replace an existing output by default. Pass
`--overwrite` only when the user explicitly authorizes replacement; input and
output paths must still differ.

## Contents

1. Create specification
2. Content blocks
3. Rich-text runs
4. Table specification
5. Edit patch
6. Review specification

## 1. Create specification

```json
{
  "preset": "business-report",
  "locale": "en-US",
  "page": "letter",
  "orientation": "portrait",
  "fonts": {
    "latin": "Arial",
    "east_asia": "Microsoft YaHei"
  },
  "margins_inches": {
    "top": 0.8,
    "right": 0.8,
    "bottom": 0.8,
    "left": 0.8
  },
  "metadata": {
    "title": "Program Readiness Brief",
    "subject": "Launch decision",
    "author": "Operations Team",
    "keywords": "launch, readiness",
    "category": "Internal",
    "comments": "Prepared for review"
  },
  "header": {"text": "INTERNAL", "alignment": "right"},
  "footer": {"text": "Page {PAGE} of {NUMPAGES}", "alignment": "center"},
  "content": []
}
```

Supported presets: `business-report`, `formal-memo`, `proposal`, `sop`, and `simple-document`.

Supported page values: `a4` and `letter`. Supported orientations: `portrait` and `landscape`.

`fonts` is optional. When `east_asia` is omitted, the creator chooses an installed CJK-capable default for the current platform. Header and footer values may be strings or objects with `text` and `alignment` (`left`, `center`, or `right`). `{PAGE}` and `{NUMPAGES}` create real fields.

## 2. Content blocks

### Title and subtitle

```json
{"type": "title", "text": "Program Readiness Brief"}
{"type": "subtitle", "text": "Decision meeting · 13 July 2026"}
```

### Heading

```json
{"type": "heading", "level": 1, "text": "Recommendation"}
```

Heading levels must be 1–3.

### Paragraph

```json
{"type": "paragraph", "text": "The program is ready to proceed.", "style": "Normal"}
```

Use `"bold": true` only when the entire paragraph requires bold treatment. Use rich-text runs for local emphasis.

### Bullet and numbered items

```json
{"type": "bullet", "text": "Confirm the release owner"}
{"type": "numbered", "text": "Approve the deployment window"}
```

Create one block per list item. Do not place multiple items in one paragraph with line breaks.

### Quote

```json
{"type": "quote", "text": "A short quotation or attributed statement."}
```

### Callout

```json
{
  "type": "callout",
  "label": "Decision",
  "text": "Proceed after the final readiness review.",
  "fill": "D9EAF7",
  "accent": "1F4E79"
}
```

Colors are six-digit RGB hex values. Keep callouts short.

### Checklist

```json
{
  "type": "checklist",
  "items": ["Confirm owner", "Confirm date", "Archive evidence"],
  "checked": [true, false, false]
}
```

The output is a visible checklist, not an interactive Word content control.

### Definition list

```json
{
  "type": "definition_list",
  "items": [
    {"term": "Owner", "definition": "Release Management"},
    {"term": "Status", "definition": "Ready with conditions"}
  ]
}
```

### Source list

```json
{
  "type": "source_list",
  "items": [
    "Readiness review, 10 July 2026",
    "Risk register, revision 4"
  ]
}
```

### Image

```json
{
  "type": "image",
  "path": "figures/timeline.png",
  "width_inches": 5.5,
  "caption": "Figure 1. Delivery timeline",
  "alt_text": "Milestones from discovery through launch"
}
```

Resolve relative paths from the JSON file's directory. Remote URLs are rejected.

### Table of contents and fields

```json
{
  "type": "toc",
  "title": "Contents",
  "levels": [1, 2, 3],
  "page_break_after": true
}
```

```json
{
  "type": "field",
  "instruction": "DATE \\@ \"yyyy-MM-dd\"",
  "placeholder": "Update field",
  "alignment": "right"
}
```

Supported field prefixes are `TOC`, `PAGE`, `NUMPAGES`, `DATE`, and `TIME`. Verify displayed field results in the rendered output.

### Page break and spacer

```json
{"type": "page_break"}
{"type": "spacer", "points": 8}
```

Use spacers sparingly. Prefer paragraph style spacing.

## 3. Rich-text runs

Use `runs` instead of `text` when local emphasis is required:

```json
{
  "type": "paragraph",
  "runs": [
    {"text": "Status: ", "bold": true},
    {"text": "Ready", "bold": true, "color": "1F4E79"},
    {"text": " with two open actions.", "italic": false}
  ]
}
```

Supported run fields: `text`, `bold`, `italic`, `underline`, `color`, and `size_pt`.

Use rich runs with `title`, `subtitle`, `heading`, `paragraph`, `bullet`, `numbered`, `quote`, and `callout` blocks. Avoid direct formatting on most body text; repeated formatting belongs in styles or presets.

## 4. Table specification

```json
{
  "type": "table",
  "headers": ["Workstream", "Owner", "Status"],
  "rows": [
    ["Security review", "Security", "Complete"],
    ["Release approval", "Operations", "Pending"]
  ],
  "column_widths": [4, 2, 1.5],
  "alignments": ["left", "left", "center"],
  "repeat_header": true,
  "style": "Table Grid",
  "caption": "Table 1. Launch readiness"
}
```

Rules:

- Every row must contain the same number of cells as the header.
- `column_widths` contains positive relative weights, one per column.
- `alignments` contains `left`, `center`, or `right`, one per column.
- The creator writes explicit table, grid, and cell widths in DXA.
- Rows auto-expand; do not simulate fixed height with blank lines.
- Set `repeat_header` to `true` for multi-page data tables.

## 5. Edit patch

```json
{
  "operations": [
    {
      "action": "replace_text",
      "match": "2025 plan",
      "replacement": "2026 plan",
      "occurrence": "all"
    },
    {
      "action": "insert_after",
      "match": "Recommendation",
      "text": "Proceed after final approval.",
      "style": "Normal",
      "occurrence": 1,
      "location": "body"
    },
    {
      "action": "set_style",
      "match": "Risk summary",
      "style": "Heading 1"
    },
    {
      "action": "append_paragraph",
      "text": "Appendix note.",
      "style": "Normal"
    },
    {"action": "add_page_break"},
    {
      "action": "set_metadata",
      "title": "Updated Program Brief",
      "author": "Operations Team"
    },
    {"action": "set_header", "text": "CONFIDENTIAL", "alignment": "right"},
    {"action": "set_footer", "text": "Page {PAGE} of {NUMPAGES}", "alignment": "center"},
    {"action": "set_table_cell", "table": 1, "row": 2, "column": 3, "text": "Complete"},
    {"action": "append_table_row", "table": 1, "values": ["Legal review", "Legal", "Pending"]}
  ]
}
```

Supported actions:

- `replace_text`: match across adjacent runs while retaining the first and last run formatting.
- `insert_after`: insert one paragraph after a selected matching paragraph.
- `delete_paragraph`: delete a selected paragraph containing `match`.
- `set_style`: set a Word style on a selected matching paragraph.
- `append_paragraph`: append a paragraph.
- `add_page_break`: append a page break.
- `set_metadata`: change supported core properties.
- `set_header` and `set_footer`: update recurring story text with optional page fields.
- `set_table_cell`: update a one-based table, row, and column.
- `append_table_row`: append values matching the existing column count.

Use `occurrence: "all"`, `occurrence: "first"`, or a one-based integer. For
`replace_text`, occurrence counts individual non-overlapping text matches in
document order, including repeated matches inside one paragraph. For
paragraph-level actions, it counts matching paragraphs. When the default
target is ambiguous, the operation returns `partial`; add `occurrence` or a
location prefix from `inspect`. A missing target also returns `partial` unless
`allow_missing: true` is explicit. Never interpret an unexpected zero
`affected` count as success.

`edit` blocks package-sensitive documents when a `python-docx` round trip may lose content. Prefer `fallback-patch`; use `--allow-lossy` only after explicit user acceptance.

## 6. Review specification

```json
{
  "comments": [
    {
      "match": "The program is ready",
      "text": "Add the evidence source for this conclusion.",
      "author": "PilotDeck",
      "occurrence": 1,
      "location": "body"
    }
  ],
  "tracked_replacements": [
    {
      "match": "launch in May",
      "replacement": "launch in June",
      "author": "PilotDeck",
      "occurrence": 1,
      "location": "body"
    }
  ]
}
```

Use short, unique match strings. Ambiguous matches return `partial` until a one-based `occurrence` is supplied. Bundled comments attach to the containing paragraph in the main body. Tracked replacements require the matched text to exist in one run; cross-run matches return `unsupported` with fallback guidance rather than silently becoming clean edits.
