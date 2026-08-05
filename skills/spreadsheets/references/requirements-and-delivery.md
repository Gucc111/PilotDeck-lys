# Requirements coverage and delivery

Create a task-specific `requirements.json` for every non-trivial workbook. Requirements turn user-visible promises into checks that cannot be satisfied by a look-alike image or an unrelated worksheet object.

Run `prepare` first. It creates the canonical file and freezes its `task` section. Add workbook checks without rewriting that policy.

## Schema

Use only fields that the task needs:

```json
{
  "task": {
    "protocol": "pilotdeck-spreadsheet-task/v1",
    "workbookType": "data",
    "styleMode": "neutral-built-in",
    "finalOutput": "/absolute/path/final.xlsx",
    "visualReview": { "mode": "all-pages" },
    "allowDecorativeTitle": false,
    "allowedAccentColors": []
  },
  "sourceBacked": true,
  "sourceFiles": [
    {
      "path": "/absolute/path/source.xlsx",
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  ],
  "sourceBackedSheets": ["指标总览", "KPI趋势"],
  "requiredSheets": ["指标总览", "KPI趋势"],
  "exactSheetCount": 5,
  "minFormulaCount": 10,
  "requiredFormulaRanges": [
    { "sheet": "指标总览", "range": "F4:F10" }
  ],
  "requiredNonEmptyRanges": [
    { "sheet": "原始数据", "range": "A1:H20", "minCount": 80 }
  ],
  "expectedCells": [
    { "sheet": "指标总览", "cell": "F4", "value": 0.92, "tolerance": 0.0001 }
  ],
  "expectedRanges": [
    {
      "sheet": "KPI趋势",
      "range": "A4:C6",
      "values": [
        ["1月", 100, 90],
        ["2月", 110, 95],
        ["3月", 120, 105]
      ]
    }
  ],
  "requiredCellTypes": [
    { "sheet": "指标总览", "range": "B4:F10", "type": "number" },
    { "sheet": "行动项", "range": "A4:A20", "type": "string" },
    { "sheet": "行动项", "range": "H4:H20", "type": "date", "allowBlank": true, "minCount": 1 }
  ],
  "requiredNativeCharts": [
    {
      "sheet": "KPI趋势",
      "type": "line",
      "minCount": 1,
      "minPoints": 3,
      "sourceRanges": ["A4:A11", "B4:B11", "C4:C11"]
    }
  ],
  "requiredTables": [
    { "sheet": "原始数据", "minCount": 1 }
  ],
  "requiredConditionalFormatting": [
    { "sheet": "行动项", "range": "G4:G20" }
  ],
  "requiredDataValidations": [
    { "sheet": "行动项", "cell": "F4" }
  ],
  "requiredImages": [
    { "sheet": "指标总览", "minCount": 1 }
  ],
  "maxPagesPerSheet": [
    { "sheet": "指标总览", "max": 1 }
  ],
  "maxTotalPages": 8,
  "warningDispositions": [
    {
      "type": "large_used_ranges",
      "rationale": "原始明细包含 120,000 行，范围与已核对的源数据一致。"
    }
  ]
}
```

## Prepared task policy

- `workbookType` is `data`, `tracker`, `model`, `dashboard`, `report`, or `template`.
- `styleMode` is `neutral-built-in`, `preserve-source`, or `user-template`.
- `preserve-source` includes the resolved latest input path and SHA-256.
- `user-template` includes the exact template path and SHA-256.
- `visualReview.mode` is `all-pages`, `selected-sheets`, or explicitly authorized `structural-only` for a data workbook.
- `finalOutput` is the exact new `.xlsx` path authorized for delivery. Source replacement is currently blocked.

Do not add decorative-title or accent-color permission because the builder already used them. Those fields reflect the current user's requirements, not a post-build exception.

## Source-backed workbooks

Set `sourceBacked: true` whenever one or more files supply facts for the output. Record absolute input paths and their SHA-256 values before building; `audit` and `deliver` reject missing or changed sources. List every output sheet that materially reproduces source facts in `sourceBackedSheets`.

Each source-backed sheet must have at least one `expectedCells` or `expectedRanges` assertion. Use `expectedRanges` for complete user-critical tables rather than checking one convenient cell. This is especially important for KPI histories, channel/source tables, schedules, action registers, owners, dates, and other facts where a plausible replacement would still look polished.

The requirements schema rejects a source-backed sheet with no fact assertion. The build also checks declared sheets, formula ranges, tables, validations, non-formula facts, and neutral-style policy before the expensive recalculation stage, so correct the requirements or builder instead of waiting for a late audit failure.

Build the expected matrices from actual `inspect` output or exact text/JSON extraction. Do not type them from memory. Requirements prove that the output matches the frozen fact matrix; source hashes prove the inputs were not changed during the task.

For non-trivial workbooks, structural checks alone are rejected. Formula-driven workbooks need `requiredFormulaRanges`. Native charts need `requiredNativeCharts` with exact `sourceRanges` and `minPoints`. Coverage means only that the declared checks passed; it is not a percentage of undeclared user intent.

Chart types are `line`, `column`, or `bar`. Source ranges are matched against native chart series formulas. `minPoints` is the minimum number of complete category/value observations required in every series. Blank categories, blank/non-numeric values, mismatched lengths, and one-point line charts are rejected. An inserted SVG or PNG never satisfies `requiredNativeCharts`.

`requiredCellTypes` supports `number`, `date`, `string`, and `boolean`. Unless `allowBlank` is true, every cell in the range must have the requested type. This catches accidental style sharing that causes ExcelJS or Excel to reinterpret ordinary KPI values as dates.

`warningDispositions` is not a wildcard bypass. Each entry must match a reported warning `type` and contain a concrete, task-specific rationale. Prefer fixing the warning; use a disposition only when the workbook is intentionally correct.

Requirements declare checks only. Do not write audit output such as `status` or `coverage` into `requirements.json`; the runtime calculates those fields. Keep `warningDispositions` as an array of `{ "type": "...", "rationale": "..." }` objects.

## Candidate workflow

Build to a scratch candidate, not the final destination:

```bash
bash "$SHEET" build \
  --builder "$WORKSPACE/tmp/workbook.mjs" \
  --requirements "$WORKSPACE/qa/requirements.json" \
  --out "$WORKSPACE/tmp/candidate.xlsx"
```

Initialize QA, inspect each returned page, and record it before finalizing:

```bash
bash "$SHEET" qa-init \
  --input "$WORKSPACE/tmp/candidate.xlsx" \
  --requirements "$WORKSPACE/qa/requirements.json" \
  --report "$WORKSPACE/qa/visual-review.json"

bash "$SHEET" qa-record \
  --report "$WORKSPACE/qa/visual-review.json" \
  --sheet "指标总览" --page 1 --status passed \
  --notes "Checked visible facts, formats, chart labels, and page bounds."

bash "$SHEET" qa-finalize \
  --report "$WORKSPACE/qa/visual-review.json"
```

`qa-init` binds the candidate SHA-256, requirements SHA-256, structural/calculation audit, render coverage, and normalized decoded-pixel digest for every required page. `qa-record` preserves those digests and adds one page-specific review. Any candidate, requirements, or page-image mutation makes the review stale.

Then seal that exact candidate:

```bash
bash "$SHEET" deliver \
  --input "$WORKSPACE/tmp/candidate.xlsx" \
  --out "$FINAL_XLSX" \
  --requirements "$WORKSPACE/qa/requirements.json" \
  --qa-report "$WORKSPACE/qa/visual-review.json" \
  --report "$WORKSPACE/qa/delivery.json"
```

`deliver` requires finalized SHA-bound QA, rechecks structural/formula/type/style coverage and source hashes, verifies the exact prepared output path, atomically copies the candidate, reopens the final artifact, records lineage, and reports its SHA-256.

Warnings block delivery until they are fixed or explicitly dispositioned. Formula errors, invalid dates, missing required objects, blank print pages, failed coverage, and hash mismatches are hard failures. A failed build does not update the requested candidate; never recover by copying a raw or debug workbook to the final path.

Every build writes `<candidate>.build-report.json`. When serialization has started, a failed build also writes `<candidate>.failed/` with the available raw workbook, staged workbook, full audit, and failure report. These are internal diagnostic artifacts, not alternative deliverables.

## Claims

Base the final response on `delivery.json` and the final package inspection. Do not claim:

- a native chart when `package.features.charts` is zero;
- formula-driven logic when the required formula ranges did not pass;
- a one-page layout when the sheet render has multiple pages;
- a clean final artifact when the reported SHA refers to a different file.
- complete task coverage when requirements contain only structural checks or omit critical source facts.
