# Requirements coverage and delivery

> Legacy protocol reference. The model-guided workflow uses `build`, multimodal `review`, optional task-specific `evaluate`, and direct `deliver`. Use this requirements/attestation/QA protocol only when an existing task already depends on it or when its frozen acceptance contract is deliberately requested.

Create a task-specific `requirements.json` for every non-trivial workbook. Requirements turn user-visible promises into checks that cannot be satisfied by a look-alike image or an unrelated worksheet object.

Run `prepare` first. It creates the canonical file and freezes its `task` section. Add workbook checks without rewriting that policy.

## Schema

Use only fields that the task needs:

```json
{
  "task": {
    "protocol": "pilotdeck-spreadsheet-task/v2",
    "workbookType": "data",
    "styleMode": "neutral-built-in",
    "validationProfile": "strict",
    "minimumValidationProfile": "strict",
    "dataOperation": "transform",
    "profileReasons": ["transform requires at least strict validation"],
    "finalOutput": "/absolute/path/final.xlsx",
    "visualReview": { "mode": "adaptive" },
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
  "numericIntegrity": {
    "protocol": "pilotdeck-numeric-integrity/v1",
    "mode": "strict",
    "state": "bound",
    "evidence": {
      "path": "/absolute/internal/source-evidence.json",
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    },
    "plan": {
      "path": "/absolute/internal/integrity-plan.json",
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    },
    "blockOnUnverified": true
  },
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
- `dataOperation` is `create`, `presentation-only`, `copy`, `union`, `transform`, or `ocr`.
- `validationProfile` is `fast`, `standard`, or `strict` and cannot be below the operation's minimum. The runtime may escalate a formula- or chart-bearing `fast` build to `standard`.
- `preserve-source` includes the resolved latest input path and SHA-256.
- `user-template` includes the exact template path and SHA-256.
- `visualReview.mode` normally is `adaptive`; `all-pages`, `selected-sheets`, and explicitly authorized `structural-only` remain available for exceptional scopes.
- `finalOutput` is the exact new `.xlsx` path authorized for delivery. Source replacement is currently blocked.

Do not add decorative-title or accent-color permission because the builder already used them. Those fields reflect the current user's requirements, not a post-build exception.

## Source-backed workbooks

Set `sourceBacked: true` whenever one or more files supply facts for the output. Prefer repeatable `prepare --source`, which records absolute paths and SHA-256 values, generates source evidence, and prevents manual hash transcription. Build and delivery reject missing or changed sources. Register the plan once with `helpers.integrity.register(workbook, plan)`; build validates, stores, binds, and audits it automatically.

Each source-backed sheet must have either a bound numeric-integrity operation or at least one `expectedCells`/`expectedRanges` assertion. Use numeric integrity for complete copied, unioned, joined, aggregated, calculated, or image-derived numeric facts. Use `expectedRanges` for additional user-critical non-numeric matrices rather than checking one convenient cell.

The requirements schema rejects a source-backed sheet with neither form of fact coverage. A numeric-integrity task remains `prepared` until the builder registers a complete plan; the same build binds it before candidate validation. The build also checks declared sheets, formula ranges, tables, validations, non-formula facts, and neutral-style policy before expensive recalculation, so correct the plan, requirements, or builder instead of waiting for a late failure.

Build the expected matrices from actual `inspect` output or exact text/JSON extraction. Do not type them from memory. Requirements prove that the output matches the frozen fact matrix; source hashes prove the inputs were not changed during the task.

Numeric expected values are type-strict: the text `"100"` does not satisfy the number `100`. For comprehensive numeric source reconciliation, use [numeric-integrity.md](numeric-integrity.md) instead of duplicating source values into requirements.

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

The successful build writes one attestation containing the candidate SHA, requirements SHA, builder SHA, source/evidence bindings, and complete audit. Do not repeat the audit before QA.

Initialize adaptive QA, inspect every selected page, and finalize them in one batch:

```bash
bash "$SHEET" qa-init \
  --input "$WORKSPACE/tmp/candidate.xlsx" \
  --requirements "$WORKSPACE/qa/requirements.json" \
  --report "$WORKSPACE/qa/visual-review.json"

bash "$SHEET" qa-complete \
  --report "$WORKSPACE/qa/visual-review.json" \
  --reviews "$WORKSPACE/qa/observations.json"
```

`qa-init` verifies and reuses the build attestation, renders the required sheets, and binds a normalized decoded-pixel digest for every selected page. `qa-complete` requires exactly one page-specific observation for every selected page. Any candidate, requirements, attestation, or page-image mutation makes the review stale.

Then seal that exact candidate:

```bash
bash "$SHEET" deliver \
  --input "$WORKSPACE/tmp/candidate.xlsx" \
  --out "$FINAL_XLSX" \
  --requirements "$WORKSPACE/qa/requirements.json" \
  --qa-report "$WORKSPACE/qa/visual-review.json" \
  --report "$WORKSPACE/qa/delivery.json"
```

`deliver` requires finalized SHA-bound QA, verifies the attestation plus current source/evidence hashes and the exact prepared output path, atomically copies the already-audited candidate bytes, verifies the final SHA, records lineage, and reports its SHA-256. It does not rerun the complete workbook audit for v2 tasks.

Warnings block delivery until they are fixed or explicitly dispositioned. Formula errors, invalid dates, missing required objects, blank print pages, failed coverage, and hash mismatches are hard failures. A failed build does not update the requested candidate; never recover by copying a raw or debug workbook to the final path.

Every build writes `<candidate>.build-report.json`. When serialization has started, a failed build also writes `<candidate>.failed/` with the available raw workbook, staged workbook, full audit, and failure report. These are internal diagnostic artifacts, not alternative deliverables.

## Claims

Base the final response on `delivery.json` and the final package inspection. Do not claim:

- a native chart when `package.features.charts` is zero;
- formula-driven logic when the required formula ranges did not pass;
- a one-page layout when the sheet render has multiple pages;
- a clean final artifact when the reported SHA refers to a different file.
- complete task coverage when requirements contain only structural checks or omit critical source facts.
