---
name: spreadsheets
description: Create, edit, inspect, review, and finalize standalone XLSX, XLS, CSV, and TSV spreadsheet files. Use for spreadsheet generation, formatting, formulas, charts, data consolidation, source-based calculations, numeric reconciliation, legacy conversion, and visual QA. Do not use for live Microsoft Excel control or macro-enabled workbook editing.
---

# Spreadsheets

Use three stages as a reasoning framework, not a fixed tool pipeline:

1. Understand the request and source materials.
2. Build or edit the spreadsheet using the approach best suited to the task.
3. Review the actual result before delivery.

The user's explicit requirements are the primary acceptance criteria.

## Understand

Determine what the final spreadsheet should accomplish, which sources contain authoritative facts, what must change, what must remain, and what evidence would demonstrate success.

- Preserve source files unless replacement is explicitly requested.
- Do not invent missing facts or replace unknown values with plausible ones.
- When editing, preserve content, formulas, structure, and formatting the user did not ask to change.
- Inspect only the files, sheets, ranges, and package features relevant to the requested outcome.

Resolve the optional CLI when its mechanical commands help:

```bash
SKILL_ROOT={{SKILL_ROOT_SHELL}}
SHEET="$SKILL_ROOT/scripts/spreadsheet.sh"
WORKSPACE="${PILOTDECK_WORK_DIR:?PILOTDECK_WORK_DIR is required}/spreadsheets"
mkdir -p "$WORKSPACE/tmp" "$WORKSPACE/review"
```

```bash
bash "$SHEET" inspect --input "$INPUT" --sheet "Sheet1" --range "A1:H30" --styles
```

Review package-sensitive features before modifying workbooks containing charts, drawings, pivots, external connections, signatures, or other advanced objects.

## Build

Write and run one task-specific, reproducible script for each workbook revision. Use `openpyxl`, `xlsxwriter`, pandas, ExcelJS, direct OOXML editing, LibreOffice UNO, or another suitable tool according to the task. Do not switch languages or adopt a wrapper merely to use this skill.

Keep task scripts, candidates, extracted assets, reports, renders, and debugging output under `PILOTDECK_WORK_DIR`. Put only the requested final deliverable in the project workspace.

Prefer localized edits to reconstruction when modifying an existing workbook. Keep identifiers as text when leading zeroes or long digits matter. Use real numbers, dates, and booleans, and retain derived values as formulas when the workbook should remain inspectable or reusable.

Follow supplied templates and explicit visual requirements. Without either, use restrained neutral presentation: readable typography, clear number formats, useful spacing, dark text, white backgrounds, and limited color for meaning. Do not add dashboard furniture, branding, or decorative formatting unrelated to the requested outcome.

For formula caches, Excel/LibreOffice differences, dates, package-sensitive objects, or CSV safety, read [spreadsheet-specifics.md](references/spreadsheet-specifics.md) only when relevant.

## Review

Judge the spreadsheet against the user's requested outcome, not whether a tool ran successfully. Choose evidence according to consequence and uncertainty:

- reread important cells, formulas, and types;
- reconcile source-dependent figures independently;
- compare a targeted edit with its source or template;
- inspect validations, conditional formatting, charts, relationships, or package structure;
- render and visually inspect the sheets or pages material to the request.

The optional CLI provides facts and images, never a content- or design-quality verdict:

```bash
bash "$SHEET" validate --input "$WORKSPACE/tmp/candidate.xlsx"
bash "$SHEET" render \
  --input "$WORKSPACE/tmp/candidate.xlsx" \
  --out-dir "$WORKSPACE/review/latest"
```

Open relevant full-size page images before making visual claims. After changing the candidate, prior renders no longer describe the current workbook. LibreOffice may paginate, calculate, or substitute fonts differently from Microsoft Excel.

For a simple task, direct inspection may be enough. When correctness depends on sources or non-trivial calculations, write a small task-specific checking script when it materially improves confidence.

## Deliver

When formulas or their dependencies changed and cached results matter to previewers or downstream readers, recalculate the final candidate once before delivery. Do not recalculate files without formulas, and do not bypass an unsupported or unsafe result. The command preserves the original package and merges only calculated formula caches:

```bash
bash "$SHEET" recalculate \
  --input "$WORKSPACE/tmp/candidate.xlsx" \
  --out "$WORKSPACE/tmp/recalculated.xlsx"
```

Publish the reviewed internal candidate through the delivery command:

```bash
bash "$SHEET" deliver \
  --input "$WORKSPACE/tmp/candidate.xlsx" \
  --out "$FINAL_OUTPUT"
```

For an edit, add `--source "$INPUT"`. Replace that exact source only when explicitly requested, using `--source "$INPUT" --out "$INPUT" --replace-source`; a recovery copy remains internal.

`deliver` protects the source, checks package validity, and publishes the exact candidate atomically. It does not decide whether the content, formulas, design, or requested outcome are good enough; that judgment belongs to the model's review.

Use optional mechanical commands such as `compare` and `convert-legacy` only when they directly serve the request. See [optional-tools.md](references/optional-tools.md) when one is needed.
