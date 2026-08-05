---
name: spreadsheets
description: Create, edit, inspect, analyze, recalculate, render, and validate standalone spreadsheet files in .xlsx, .xls, .csv, and .tsv formats through a capability-declared workflow with controlled OOXML fallback, neutral built-in styling, native charts, raster images, source-bound numeric reconciliation, and SHA-bound visual QA. Use whenever the requested input or deliverable is a workspace spreadsheet, including multi-file merges, numeric filling, formula-driven workbooks, formatted tables, data cleanup, workbook questions, legacy XLS conversion, Chinese or bilingual workbooks, and spreadsheet visual QA. Do not use for Google Sheets, macro-enabled .xlsm files, or live control of Microsoft Excel.
---

# Spreadsheets

Work with standalone spreadsheet files through a reproducible JavaScript `.mjs` builder and the bundled `spreadsheet.sh` workflow. Preserve source files, keep calculations auditable, recalculate formulas, and verify both workbook structure and rendered pages before delivery.

## Hard requirements

- Use JavaScript ES modules and the bundled scripts. Do not use `openpyxl`, `xlsxwriter`, `pandas.ExcelWriter`, Google Sheets APIs, or Codex-private runtime paths.
- Run `capabilities` before the first spreadsheet operation in a session. Query `schema` instead of guessing helper or requirements fields.
- For a modifying XLSX task, run `prepare` before the first build. Use its canonical paths and do not change the frozen task policy merely to make a gate pass.
- Treat only `status: ok` as success. `partial`, `unsupported`, and `blocked` require the declared fallback or an honest limitation report.
- Preserve every input file. Write edits to a distinct output unless the user explicitly requests replacement.
- Keep important calculations in worksheet formulas. Do not replace inspectable formulas with hardcoded results.
- Inspect and render an existing workbook before modifying it. Match its formatting and conventions unless the user requests a redesign.
- Run compatibility preflight before editing an existing XLSX. Do not bypass a risky round trip without explicit user approval.
- Recalculate formula-driven XLSX files through LibreOffice and scan the saved results for formula errors.
- Use native Excel chart objects for requested charts. A raster image or SVG does not satisfy a chart requirement.
- Use `await helpers.addImage(...)` for local raster illustrations. Do not fetch remote images or use an image to impersonate a chart.
- Create `requirements.json` for every non-trivial workbook and require `coverage.status=passed`.
- Pass every fact-providing file through repeatable `prepare --source`. For source-backed workbooks containing important numbers, bind a strict numeric-integrity plan before building; do not hand-write source evidence or use model-authored expected totals as the only proof.
- If ExcelJS cannot read a source that LibreOffice can open, let `prepare` create its normalized copy under `PILOTDECK_WORK_DIR`; use the effective path returned in source evidence and never create `.tmp_src` or converted copies beside user files.
- Treat copied, joined, unioned, aggregated, and formula-derived values as different operations and reconcile them against the frozen sources. A numeric-looking string does not satisfy a numeric fact.
- Treat image-derived numbers as unverified until independent high-confidence observations agree or the user explicitly confirms the bound image region. Never use `evidence-confirm` without that explicit confirmation.
- Treat Chinese as first-class content when the user does not specify a language. Apply the cross-platform typography policy and verify glyphs after recalculation.
- Render every final worksheet page and inspect the individual PNG files at full size. A montage is only an overview.
- Fix formula errors, clipped content, broken tables, unreadable formats, unexpected blank sheets, and poor page layout before delivery.
- Build to a scratch candidate and use `deliver` to seal the final XLSX. Do not manually copy an unaudited candidate to the final path.
- Keep every builder, comparison report, normalized source, and debug artifact under `PILOTDECK_WORK_DIR`. `deliver` compares the project directory with the snapshot frozen by `prepare` and blocks unexpected new, modified, or deleted files.
- Use `qa-init`, record every required page with `qa-record`, and run `qa-finalize`. Any candidate, requirements, or render change invalidates the review.
- A failed `build`, `audit`, or `deliver` means the workbook is not deliverable. Do not copy a raw/debug workbook, remove requested features, append `|| true`, or claim success after a gate fails.
- Use the bundled helpers for conditional formatting and native charts. Do not replace them with unsupported ExcelJS chart APIs or unvalidated low-level conditional-formatting objects.
- Use `helpers.addTableFromRange` after populating worksheet cells. Do not call `worksheet.addTable` with placeholder rows over existing data; the runtime rejects destructive table writes.
- Resolve every audit warning or add a task-specific `warningDispositions` entry with a concrete rationale. Undisposed warnings block `deliver`.
- If a standard helper is insufficient, follow the controlled fallback ladder. Never run an untracked package-mutating script or deliver its output directly.

## Read the relevant references

- Read [api-quick-start.md](references/api-quick-start.md) before writing or modifying a builder.
- Read [formulas-and-data.md](references/formulas-and-data.md) for every formula-driven workbook or data conversion.
- Read [formatting.md](references/formatting.md) before creating or visually editing a workbook.
- Read [chinese-and-cross-platform.md](references/chinese-and-cross-platform.md) for Chinese, bilingual, or unspecified-language net-new workbooks.
- Read [charts-and-compatibility.md](references/charts-and-compatibility.md) before editing an existing XLSX or handling charts and advanced Excel objects.
- Read [requirements-and-delivery.md](references/requirements-and-delivery.md) for every non-trivial workbook.
- Read [numeric-integrity.md](references/numeric-integrity.md) for every source-backed task that copies, merges, maps, aggregates, calculates, or reads numeric values from images.
- Read [qa-checklist.md](references/qa-checklist.md) before delivery.
- Read [capabilities-and-fallbacks.md](references/capabilities-and-fallbacks.md) before declaring a feature unavailable or writing package-level code.

## Prepare the runtime

Resolve the directory containing this file as `SPREADSHEET_SKILL_ROOT`, then run:

```bash
SHEET="$SPREADSHEET_SKILL_ROOT/scripts/spreadsheet.sh"
bash "$SHEET" check || bash "$SHEET" fix
bash "$SHEET" capabilities
```

Use the turn-scoped PilotDeck work directory for every intermediate. The host must set `PILOTDECK_WORK_DIR`:

```bash
WORKSPACE="${PILOTDECK_WORK_DIR:?PILOTDECK_WORK_DIR is required}/spreadsheets"
```

Keep builders, converted inputs, source notes, inspections, candidates, renders, recalculation files, and QA reports in `WORKSPACE`. Put only requested deliverables in the project or user-selected output directory. Never create `.pilotdeck_build.mjs`, QA directories, or other intermediates beside the user's files.

The CLI enforces this boundary whenever `PILOTDECK_WORK_DIR` is set:
`scaffold`, `build`, `convert-legacy`, `recalculate`, JSON reports, and render
outputs must stay under the work directory. Only `deliver --out` may create the
project-visible final workbook. A boundary failure must be corrected by moving
the intermediate path; do not bypass the command or copy the file manually.

## Route the request

Choose one route:

1. Read-only question or analysis: inspect the relevant workbook ranges and formulas; do not export or modify a file.
2. Net-new XLSX: scaffold a builder, create the workbook, recalculate, audit, render, and inspect it.
3. Existing XLSX edit: inspect and render first, review compatibility risks, then make the smallest scoped edit.
4. Legacy XLS: convert to a temporary XLSX, inspect and render the conversion, then use the XLSX workflow and deliver `.xlsx`.
5. CSV or TSV task: preserve delimiter, encoding, identifiers, and text semantics. Convert to XLSX only when formulas, formatting, tables, images, or other workbook features are requested.

Before an existing-workbook route, resolve the latest session version:

```bash
bash "$SHEET" resolve-latest --input "$INPUT_XLSX"
```

Use the returned `resolved` path. Use `--use-exact-input` only when the current user explicitly asks to restart from an older/original version.

Do not accept `.xlsm`, Google Sheets, or a live Excel session through this skill. Never rename `.xls` to `.xlsx`.

Convert a legacy workbook without modifying the source:

```bash
bash "$SHEET" convert-legacy \
  --input "$INPUT_XLS" \
  --out "$WORKSPACE/tmp/converted.xlsx"
```

## Inspect before acting

Get a compact workbook overview:

```bash
bash "$SHEET" inspect \
  --input "$INPUT" \
  --out "$WORKSPACE/tmp/inspection.json"
```

Inspect exact ranges and styles when needed:

```bash
bash "$SHEET" inspect \
  --input "$INPUT" \
  --sheet "Summary" \
  --range "A1:H30" \
  --styles \
  --out "$WORKSPACE/tmp/summary.json"
```

For an existing XLSX, review `package.unsafeForRoundTrip` and `package.roundTripRisks`. If either reports risky objects, stop before editing and follow [charts-and-compatibility.md](references/charts-and-compatibility.md).

Render an existing XLSX before changing its visual layout:

```bash
bash "$SHEET" render \
  --input "$INPUT" \
  --out-dir "$WORKSPACE/tmp/source-render"
```

## Create or edit a workbook

Prepare the task first. Generic words such as “professional”, “formal”, or “business” do not authorize a colored theme:

```bash
bash "$SHEET" prepare \
  --final-out "$FINAL_XLSX" \
  --workbook-type data
```

When fact sources exist, include each one independently of `--input` in that same `prepare` call:

```bash
bash "$SHEET" prepare \
  --final-out "$FINAL_XLSX" \
  --workbook-type data \
  --source "$SOURCE_A" \
  --source "$SOURCE_B"
```

For an existing workbook, add `--input "$INPUT_XLSX"`; the default style mode becomes `preserve-source`. Use `--style-mode user-template --style-source "$TEMPLATE_XLSX"` only for a concrete user-supplied style source. For a dashboard/report, select that workbook type explicitly. Use `selected-sheets` visual review only for bounded data workbooks and name every sheet.

`prepare` creates the canonical requirements and returns builder, candidate, render, QA, and delivery-report paths. Complete the declarative checks in that requirements file, then create one executable builder:

Do not rerun `prepare` merely to update acceptance checks; edit the prepared requirements arrays. If the user changes task policy and `prepare --overwrite` is necessary, omit `--source` only to preserve the original frozen sources and project snapshot. The command returns numeric integrity to `prepared`; run `integrity-status` and bind again. Use `--clear-sources` only when the user explicitly changes the task to a non-source-backed workbook.

```bash
bash "$SHEET" scaffold \
  --out "$WORKSPACE/tmp/workbook.mjs"
```

Write `$WORKSPACE/qa/requirements.json` from the user's requested sheets, formulas, native charts, images, validations, conditional formatting, expected cells/ranges, and relevant print-page constraints. Keep the prepared `task` policy unchanged. A sheet list plus a formula count is not sufficient coverage.

For a task based on input facts:

1. Pass every source through `prepare --source`; do not manually copy its hash into requirements.
2. Inspect the exact source ranges, table grain, candidate keys, units, and ambiguous regions.
3. Run `integrity-scaffold --requirements "$WORKSPACE/qa/requirements.json" --operation <copy|union|join|aggregate|formula|ocr>`. Select inputs with repeatable `--source-id`. For a multi-step transformation, add each dependent step with `--append --from-operation <id>`; never use the candidate workbook as a source. Edit the generated draft instead of inventing a plan shape.
4. For image facts, record independent observations with `evidence-observe`; when they disagree, stop unless the user explicitly confirms the value and region.
5. Resolve placeholders, set `draft` to `false`, then run `integrity-status --requirements "$WORKSPACE/qa/requirements.json"`. Fix only its listed blockers; do not inspect the CLI implementation. Run `integrity-bind` only when status reports `readyToBind: true`. Do not build while numeric integrity remains `prepared`.
6. Add `expectedRanges` only for additional user-visible acceptance matrices and `expectedCells` for important checkpoints; do not duplicate a complete reconciliation as hand-authored expectations.
7. If a source omits a value or the mapping is ambiguous, keep it blank, label it unconfirmed, or ask the user. Never invent a fact to make integrity pass.

Patch and rerun that builder instead of creating duplicate scripts. Build a net-new workbook:

```bash
bash "$SHEET" build \
  --builder "$WORKSPACE/tmp/workbook.mjs" \
  --requirements "$WORKSPACE/qa/requirements.json" \
  --out "$WORKSPACE/tmp/candidate.xlsx"
```

Edit an existing safe workbook:

```bash
bash "$SHEET" build \
  --builder "$WORKSPACE/tmp/workbook.mjs" \
  --input "$INPUT_XLSX" \
  --requirements "$WORKSPACE/qa/requirements.json" \
  --out "$WORKSPACE/tmp/candidate.xlsx"
```

`build` preserves the input, validates builder structures and requirements, blocks unsafe round trips, recalculates formula-driven XLSX files, and performs a compact formula audit. It stages output and updates the requested candidate only after audit passes, so a failed build must be fixed and rerun. Every build writes `<candidate>.build-report.json`; a post-serialization failure also preserves its latest raw/staged files and full audit under `<candidate>.failed/` for diagnosis only. Never deliver those failed artifacts. Fix the reported `stage`, worksheet, range, and field instead of disabling requested features or switching to a second builder. Never add `--allow-risky-roundtrip` unless the user has explicitly accepted the listed compatibility risks.

For a net-new `neutral-built-in` workbook, `build` performs a final CJK-only font pass after the builder returns. It replaces only missing or Latin-only fallback font names and preserves size, bold, color, and all non-CJK cells. This makes typography independent of whether rows were added before or after a helper call.

## Built-in style policy

- `neutral-built-in`: use white/light-gray headers, neutral borders, ordinary body text, and no decorative merged title for data, tracker, or model workbooks.
- `preserve-source`: keep the source workbook's fills, fonts, widths, heights, tables, and visual conventions; make the smallest scoped change.
- `user-template`: derive formatting only from the frozen template or concrete user instructions.
- Use colors only for requested branding or semantic states. Do not turn ordinary headers blue, add KPI cards, or create a dashboard layout unless the workbook type or user request requires it.
- Use `helpers.styleHeader` and `TableStyleLight1`. The audit blocks unrequested chromatic fills, other table themes, and oversized top-of-sheet titles in neutral data/tracker/model workbooks.

## Formula and data rules

- Separate assumptions/raw data from derived outputs.
- Write derived values as formulas and use visible helper ranges for complex logic.
- Use bounded ranges instead of entire-column references in large calculations.
- Use typed numbers, booleans, and dates rather than display-formatted strings.
- Preserve identifiers as text. Strict numeric comparison rejects strings such as `"100"` when a numeric cell is required.
- Declare decimal scale, currency/unit, key columns, duplicate policy, missing-match policy, rounding, and business invariants in the integrity plan when they affect correctness.
- Apply explicit number formats for currency, percentages, counts, and dates.
- Keep cross-sheet references quoted, for example `'Revenue Model'!B6`.
- In ExcelJS formula objects, omit the leading `=`. See [formulas-and-data.md](references/formulas-and-data.md).
- For CSV and TSV, preserve identifiers with leading zeroes as text and do not infer dates or numbers unless the task requires it.
- Preserve identifiers longer than 15 digits as text. Detect UTF-8/UTF-8 BOM/GBK/GB18030 and default new delimited exports to UTF-8 BOM.
- Preserve source facts exactly when translating labels or reorganizing tables. Never substitute plausible KPIs, channels, action items, owners, dates, or statuses.
- Point charts at the actual source or derived worksheet ranges. Do not duplicate values into a hidden hardcoded range merely to make chart validation pass; fix the upstream table or formulas instead.

## Validate and review

Run the final structural audit:

```bash
bash "$SHEET" audit \
  --input "$WORKSPACE/tmp/candidate.xlsx" \
  --requirements "$WORKSPACE/qa/requirements.json" \
  --out "$WORKSPACE/qa/audit.json"
```

Initialize the SHA-bound review:

```bash
bash "$SHEET" qa-init \
  --input "$WORKSPACE/tmp/candidate.xlsx" \
  --requirements "$WORKSPACE/qa/requirements.json" \
  --report "$WORKSPACE/qa/visual-review.json"
```

Inspect every page returned by `qa-init` at full resolution. Immediately record that exact sheet/page with a specific note:

```bash
bash "$SHEET" qa-record \
  --report "$WORKSPACE/qa/visual-review.json" \
  --sheet "Summary" --page 1 --status passed \
  --notes "Headers, values, chart labels, units, and page bounds are visible."

bash "$SHEET" qa-finalize \
  --report "$WORKSPACE/qa/visual-review.json"
```

Revise the builder and rerun `qa-init --overwrite` whenever the candidate changes. Do not hand-edit the QA report or copy image hashes.

After modifying this skill or its runtime, run:

```bash
bash "$SHEET" self-test --out "$WORKSPACE/self-test"
```

## Deliver

Seal an XLSX only after inspecting the candidate pages:

```bash
bash "$SHEET" deliver \
  --input "$WORKSPACE/tmp/candidate.xlsx" \
  --out "$FINAL_XLSX" \
  --requirements "$WORKSPACE/qa/requirements.json" \
  --qa-report "$WORKSPACE/qa/visual-review.json" \
  --report "$WORKSPACE/qa/delivery.json"
```

Return the final `.xlsx`, `.csv`, or `.tsv` and a concise summary grounded in the delivery report. Mention deliberate compatibility limitations. Do not claim a native chart when package inspection reports zero charts. Describe coverage as only the checks actually declared; never turn a shallow structural pass into “100% task coverage.” Do not deliver builders, requirements JSON, PDFs, renders, runtime files, or QA reports unless the user requests them.
