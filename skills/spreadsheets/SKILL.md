---
name: spreadsheets
description: Create, edit, inspect, analyze, recalculate, render, and verify standalone .xlsx, .xls, .csv, and .tsv files. Use for spreadsheet generation, formatting, formulas, charts, merges, source-data transformations, numeric reconciliation, legacy XLS conversion, and spreadsheet visual QA. Do not use for Google Sheets, macro-enabled .xlsm files, or live control of Microsoft Excel.
---

# Spreadsheets

Build standalone spreadsheets with one reproducible JavaScript `.mjs` builder. Match validation effort to the data operation, preserve every source, and deliver only the candidate whose structural audit and visual review are SHA-bound.

## Non-negotiable rules

- Use the bundled JavaScript runtime. Do not use `openpyxl`, `xlsxwriter`, `pandas.ExcelWriter`, Google Sheets APIs, or private runtime paths.
- Run `capabilities` once before the first spreadsheet operation in a session. Use `schema` when a command or plan field is unclear; never inspect runtime implementation to reverse-engineer it.
- Run `prepare` before every modifying XLSX task. Use the canonical paths it returns.
- Keep builders, candidates, renders, normalized inputs, reports, and debug files under `PILOTDECK_WORK_DIR`. Only `deliver --out` may create the requested project-visible workbook.
- Preserve every input. Do not overwrite a source unless the user explicitly requests replacement and the command supports it.
- Keep derived values as inspectable formulas. Use typed numbers, dates, booleans, and text identifiers; never replace formulas or unknown facts with plausible hardcoded values.
- Pass every fact-providing file through `prepare --source`. The builder must declare how source facts reach output cells.
- Use neutral formatting unless the user supplies branding, a template, or a concrete style request. Ordinary data sheets must not gain decorative title rows, colored headers, KPI cards, or dashboard styling by default.
- Use native Excel chart objects for requested line, column, and bar charts. An inserted image does not satisfy a chart requirement.
- Treat only `status: ok` as success. Fix `partial`, `blocked`, `unsupported`, or `error`; do not bypass a gate or deliver failed artifacts.
- A successful v2 `build` already performs the complete structural, formula, coverage, compatibility, and numeric audit and writes a SHA-bound attestation. Do not run a second standalone `audit` in the normal workflow.
- Use adaptive visual QA and batch completion. Review only the pages selected by `qa-init`, then use `qa-complete`; do not record pages one command at a time unless debugging legacy state.
- Seal the unchanged candidate with `deliver`. Do not manually copy it to the final path.

## Choose the data operation and profile

Validation is based on what happens to data, not on how many files exist.

| Data operation | Minimum profile | Use when |
|---|---|---|
| `create` | `fast` | Creating facts supplied directly by the user, without fact source files |
| `presentation-only` | `fast` | Changing only layout/style in an existing workbook; values and formulas must remain identical |
| `copy` | `standard` | Copying records or values from one frozen source |
| `union` | `standard` | Appending same-grain records from frozen sources |
| `transform` | `strict` | Joining, mapping, aggregating, calculating, deduplicating, or otherwise changing meaning/grain |
| `ocr` | `strict` | Reading any fact from an image or scan |

The runtime may automatically escalate `fast` to `standard` when a generated workbook contains formulas or native charts. A requested profile may be stricter than the minimum but never weaker. When `--source` is present and no operation is specified, the safe default is `transform`; image sources always require `ocr`.

Profile behavior:

- `fast`: structural validity, required sheets, lightweight formula/chart checks, style policy, compatibility, and adaptive visual QA.
- `standard`: all fast checks plus source-to-output reconciliation for copy/union and formula-count coverage where applicable.
- `strict`: full field typing, ranges, keys, calculations, invariants, source/evidence hashes, and OCR consensus rules.

## Read only the relevant references

- Read [api-quick-start.md](references/api-quick-start.md) before writing a builder.
- Read [formatting.md](references/formatting.md) for net-new or visual changes.
- Read [formulas-and-data.md](references/formulas-and-data.md) when formulas, imports, CSV, or TSV are involved.
- Read [numeric-integrity.md](references/numeric-integrity.md) for `copy`, `union`, `transform`, or `ocr`.
- Read [charts-and-compatibility.md](references/charts-and-compatibility.md) for existing XLSX files, charts, drawings, or advanced objects.
- Read [chinese-and-cross-platform.md](references/chinese-and-cross-platform.md) for Chinese, bilingual, or unspecified-language net-new workbooks.
- Read [requirements-and-delivery.md](references/requirements-and-delivery.md) for acceptance checks and delivery.
- Read [qa-checklist.md](references/qa-checklist.md) before reviewing rendered pages.
- Read [capabilities-and-fallbacks.md](references/capabilities-and-fallbacks.md) only when a declared helper cannot express a requested feature.

## Initialize the runtime

Resolve the directory containing this file as `SPREADSHEET_SKILL_ROOT`:

```bash
SHEET="$SPREADSHEET_SKILL_ROOT/scripts/spreadsheet.sh"
bash "$SHEET" check || bash "$SHEET" fix
bash "$SHEET" capabilities
WORKSPACE="${PILOTDECK_WORK_DIR:?PILOTDECK_WORK_DIR is required}/spreadsheets"
```

Use `bash "$SHEET" capabilities --full` only when the concise response lacks a needed capability. Query a command schema instead of guessing:

```bash
bash "$SHEET" schema --command prepare
```

## Route the request

### Read-only analysis

Use `inspect` with the smallest relevant range. Do not create a modified workbook:

```bash
bash "$SHEET" inspect --input "$INPUT" --sheet "Summary" --range "A1:H30" --styles --out "$WORKSPACE/tmp/inspection.json"
```

### Existing XLSX edit

Resolve the latest session version, inspect the relevant range, and render the source before visual edits:

```bash
bash "$SHEET" resolve-latest --input "$INPUT_XLSX"
bash "$SHEET" inspect --input "$RESOLVED_XLSX" --out "$WORKSPACE/tmp/source.json"
bash "$SHEET" render --input "$RESOLVED_XLSX" --out-dir "$WORKSPACE/tmp/source-render"
```

Review `package.unsafeForRoundTrip` and `package.roundTripRisks`. Do not edit a risky package without the explicit fallback or user approval described in [charts-and-compatibility.md](references/charts-and-compatibility.md).

### Legacy XLS

Never rename `.xls` to `.xlsx`. Convert an internal copy and continue with the XLSX workflow:

```bash
bash "$SHEET" convert-legacy --input "$INPUT_XLS" --out "$WORKSPACE/tmp/converted.xlsx"
```

### CSV or TSV

Preserve delimiter, encoding, leading-zero identifiers, and text longer than 15 digits. Convert to XLSX only when formatting, formulas, tables, charts, or images are requested.

## Normal modifying workflow

### 1. Prepare once

```bash
bash "$SHEET" prepare \
  --final-out "$FINAL_XLSX" \
  --data-operation create \
  --workbook-type data
```

Add `--input "$INPUT_XLSX"` for an existing workbook. Add every independent fact source with repeated `--source`; `--input` is the workbook being edited and is not a substitute for fact-source declaration.

Examples:

```bash
# Pure formatting; values/formulas must not change
bash "$SHEET" prepare --final-out "$FINAL_XLSX" --input "$INPUT_XLSX" --data-operation presentation-only

# Append rows from multiple workbooks
bash "$SHEET" prepare --final-out "$FINAL_XLSX" --source "$JAN" --source "$FEB" --data-operation union

# Join, aggregate, calculate, or map
bash "$SHEET" prepare --final-out "$FINAL_XLSX" --source "$SOURCE_A" --source "$SOURCE_B" --data-operation transform
```

Do not rerun `prepare` merely to edit acceptance arrays. Edit the generated requirements file while keeping its frozen `task`, source, style, and project-guard bindings unchanged.

### 2. Write one builder

Use the builder path returned by `prepare`, or scaffold it once:

```bash
bash "$SHEET" scaffold --out "$WORKSPACE/tmp/workbook.mjs"
```

Return an ExcelJS workbook or `{ workbook, requirements }`. Use the bundled helpers for styles, tables, charts, images, conditional formatting, and numeric lineage. Patch and rerun the same builder; do not create dated or numbered duplicate scripts.

For source-backed work, declare lineage once inside the builder:

```js
export default async function build({ createWorkbook, helpers }) {
  const workbook = createWorkbook();
  const sheet = workbook.addWorksheet("明细");
  sheet.addRows([
    ["编号", "金额"],
    ["A-001", 125.50],
  ]);

  helpers.integrity.register(workbook, {
    protocol: "pilotdeck-numeric-integrity/v1",
    mode: "strict",
    draft: false,
    operations: [{
      id: "copy-detail",
      type: "copy",
      fields: {
        id: { semanticType: "identifier" },
        amount: { semanticType: "decimal", scale: 2, currency: "CNY" },
      },
      inputs: [{ source: "/frozen/effective/source.xlsx", sheet: "明细", range: "A2:B2", columns: { id: "A", amount: "B" } }],
      output: { sheet: "明细", range: "A2:B2", columns: { id: "A", amount: "B" } },
      keyColumns: ["id"],
    }],
    invariants: [],
  });
  return workbook;
}
```

Use exact effective source paths from the generated source evidence. The first build validates and binds this plan automatically. Do not separately run `integrity-bind` in the normal workflow.

### 3. Build once per revision

```bash
bash "$SHEET" build \
  --builder "$WORKSPACE/tmp/workbook.mjs" \
  --requirements "$WORKSPACE/qa/requirements.json" \
  --out "$WORKSPACE/tmp/candidate.xlsx"
```

Add `--input "$INPUT_XLSX"` only when `prepare` froze that input. Build validates the builder, recalculates formulas through LibreOffice, normalizes supported compatibility issues, audits the staged workbook, checks numeric integrity, atomically updates the candidate, and writes `attestation.json`. A failed build does not update the candidate.

Do not run `audit` after a successful build. If progress is unclear, ask the protocol for the exact next action:

```bash
bash "$SHEET" status --requirements "$WORKSPACE/qa/requirements.json"
```

### 4. Review selected pages in one batch

```bash
bash "$SHEET" qa-init \
  --input "$WORKSPACE/tmp/candidate.xlsx" \
  --requirements "$WORKSPACE/qa/requirements.json" \
  --report "$WORKSPACE/qa/visual-review.json"
```

Open every page listed in the report at full size. Adaptive QA renders representative sheets and selects all pages for small or presentation-heavy workbooks; for large data workbooks it selects bounded first/last pages per rendered sheet.

Write one internal observations file:

```json
{
  "reviews": [
    { "sheet": "Summary", "page": 1, "status": "passed", "notes": "Headers, values, chart labels, and page bounds are readable." }
  ]
}
```

Then finalize all selected pages at once:

```bash
bash "$SHEET" qa-complete \
  --report "$WORKSPACE/qa/visual-review.json" \
  --reviews "$WORKSPACE/qa/observations.json"
```

If any page fails, fix the builder and rebuild. The new candidate invalidates the old review by design.

### 5. Deliver the unchanged candidate

```bash
bash "$SHEET" deliver \
  --input "$WORKSPACE/tmp/candidate.xlsx" \
  --out "$FINAL_XLSX" \
  --requirements "$WORKSPACE/qa/requirements.json" \
  --qa-report "$WORKSPACE/qa/visual-review.json" \
  --report "$WORKSPACE/qa/delivery.json"
```

Delivery verifies the candidate, requirements, builder, source/evidence bindings, QA, and attestation hashes, checks only suspicious spreadsheet artifacts leaked into the project, copies the already-audited bytes atomically, and verifies the final SHA. Unrelated collaborator edits do not block delivery.

## Builder and presentation policy

- For `neutral-built-in`, use white or light-gray headers, dark text, restrained borders, and `TableStyleLight1`. Do not add a large merged title to ordinary data, tracker, or model sheets.
- For `preserve-source`, make the smallest edit and preserve the workbook's fills, fonts, sizes, widths, row heights, tables, and conventions.
- Use colors only for requested branding or semantic states. Do not default to blue headers.
- Use `helpers.styleHeader`, `helpers.applyStyle`, `helpers.setNumberFormat`, `helpers.autoFitColumns`, and `helpers.autoFitRows`; style objects must not be shared mutably across cells.
- Apply explicit formats for currency, percentage, counts, and dates. Keep identifiers as text.
- Use `helpers.addTableFromRange` only after populating the cells. Raw `worksheet.addTable()` may overwrite populated formulas and is rejected.
- Use `helpers.addNativeChart` for charts and `await helpers.addImage(...)` for local raster illustrations.
- For Chinese or bilingual content, use `helpers.applyChineseTypography`; the post-build pass preserves sizes, weights, colors, and non-CJK cells.

## Numeric integrity policy

- The frozen source bytes and runtime reread are authoritative. Model-authored totals are never the sole expected values.
- Describe each independently explainable step as `copy`, `union`, `join`, `aggregate`, `formula`, or `ocr`.
- Declare exact header-excluding ranges, mappings, types, keys, units/currency, rounding, duplicate policy, and missing-match policy.
- Keep identifiers as identifiers. Numeric-looking strings do not satisfy numeric facts.
- Downstream operations reference earlier operation IDs, never the unverified candidate as a source.
- OCR facts require bound regions and either independent high-confidence agreement or explicit user confirmation. If observations disagree, stop.
- If a plan is complex, use `integrity-scaffold`, `integrity-status`, and `integrity-bind` only as a legacy/debug authoring aid. The preferred final representation remains one `helpers.integrity.register` call in the builder.

## Failure and fallback

- Fix the exact reported stage, sheet, range, field, or page. Do not append `|| true`, remove requested features, or copy `.failed` artifacts.
- If a formula fails recalculation, repair the formula or workbook structure; do not replace it with a guessed value.
- If a source is ambiguous or incomplete, preserve blanks, label uncertainty, or ask the user.
- If ExcelJS cannot read a source but LibreOffice can, use the normalized copy returned by `prepare`; never create `.tmp_src` beside user files.
- If a standard helper cannot express a required package feature, follow the controlled fallback manifest in [capabilities-and-fallbacks.md](references/capabilities-and-fallbacks.md). The patched output must still pass build, attestation, QA, and delivery.
