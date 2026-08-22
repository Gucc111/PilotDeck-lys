# Optional spreadsheet tools

The CLI commands below provide mechanical facts, transformations, images, and safe delivery. They do not replace task-specific construction or the model's review.

Resolve the entry point as shown in `SKILL.md` before using them.

## Inspect

Inspect workbook structure and a bounded range:

```bash
bash "$SHEET" inspect --input "$INPUT" --sheet "Sheet1" --range "A1:H30" --styles
```

Add `--out "$WORKSPACE/review/inspection.json"` to persist the report.

## Validate

Check package structure and report formula caches, error values, compatibility features, and delimited-file consistency:

```bash
bash "$SHEET" validate --input "$CANDIDATE" --out "$WORKSPACE/review/validation.json"
```

Findings describe the workbook; only malformed or unsafe file operations are command failures.

## Recalculate formula caches

Use once on a final XLSX candidate when formulas or their dependencies changed and cached values matter:

```bash
bash "$SHEET" recalculate --input "$CANDIDATE" --out "$RECALCULATED" --report "$WORKSPACE/review/recalculation.json"
```

The command runs LibreOffice only on a temporary copy, keeps the original formula and package structure, and merges supported cached results by worksheet and cell address. Do not retry `partial`, `unsupported`, or `blocked` results with a risky round-trip option.

## Compare

Report package, worksheet, formula, and cell-fact differences after a template or package-sensitive edit:

```bash
bash "$SHEET" compare --before "$INPUT" --after "$CANDIDATE" --out "$WORKSPACE/review/comparison.json"
```

The report does not decide whether a difference was requested or acceptable.

## Render

Render through LibreOffice and produce full-size page images:

```bash
bash "$SHEET" render --input "$CANDIDATE" --out-dir "$WORKSPACE/review/rendered"
```

Use `--pdf "$WORKSPACE/review/rendered.pdf"` to keep an explicit PDF path. Open the relevant images before making visual claims.

## Convert legacy XLS

Convert a legacy `.xls` source to an internal `.xlsx` candidate before editing:

```bash
bash "$SHEET" convert-legacy --input "$INPUT_XLS" --out "$WORKSPACE/tmp/converted.xlsx"
```

Conversion can change unsupported legacy behavior. Preserve the source and review the result.
