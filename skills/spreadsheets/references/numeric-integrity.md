# Numeric integrity

Use the numeric-integrity protocol whenever source files supply important numeric facts to an output workbook. The protocol proves faithful transfer and declared calculations; it cannot prove that an unchanged source value is true in the real world.

## Contents

- [Trust boundary](#trust-boundary)
- [Workflow](#workflow)
- [Plan model](#plan-model)
- [Field semantics](#field-semantics)
- [Structured operations](#structured-operations)
- [Aggregation and formulas](#aggregation-and-formulas)
- [Row invariants](#row-invariants)
- [Image evidence](#image-evidence)
- [Failure policy](#failure-policy)
- [Claims](#claims)

## Trust boundary

- Treat the frozen source files, their SHA-256 hashes, and the runtime's direct reread as the authority.
- When a malformed XLSX requires LibreOffice normalization, retain both authorities: the untouched origin hash and the internal derived hash. The plan reads the derived path, while audit verifies that neither origin nor derived file changed.
- Treat `source-evidence.json` as a generated inventory and image-region ledger. Never hand-edit it.
- Treat `integrity-plan.json` as the declared transformation, not as a list of model-authored answers.
- Let the build audit reread the frozen files and independently recompute the expected records and values.
- Bind that result in the build attestation. QA reuses the attested result, and delivery verifies the attestation plus current source/evidence hashes. A stale plan, stale evidence file, changed source, unverified image fact, or mismatched output blocks delivery.

The protocol prevents silent copying, join, aggregation, formula, and transcription errors. It does not establish the external authenticity of a source document.

## Workflow

Pass every fact source in the original `prepare` call:

```bash
bash "$SHEET" prepare \
  --final-out "$FINAL_XLSX" \
  --workbook-type data \
  --source "$SOURCE_A" \
  --source "$SOURCE_B" \
  --source "$SCAN"
```

`prepare` freezes the source hashes and creates:

- `$WORKSPACE/qa/source-evidence.json`
- `$WORKSPACE/qa/integrity-plan.json`
- `$WORKSPACE/qa/requirements.json`

Inspect the source ranges, then declare the plan once in the builder with `helpers.integrity.register(workbook, plan)`. Query the authoritative schema instead of guessing fields:

```bash
bash "$SHEET" schema --command numeric-integrity
```

The preferred workflow is:

1. Use exact effective source paths from `source-evidence.json`.
2. Describe every source-to-output operation in one non-draft plan.
3. Register it on the returned workbook.
4. Run build once. Build validates, writes, binds, and audits the plan before updating the candidate.

```js
helpers.integrity.register(workbook, {
  protocol: "pilotdeck-numeric-integrity/v1",
  mode: "strict",
  draft: false,
  operations,
  invariants,
});
```

For difficult multi-step plans, generate an operation-shaped draft as a legacy/debug authoring aid:

```bash
bash "$SHEET" integrity-scaffold \
  --requirements "$WORKSPACE/qa/requirements.json" \
  --operation union \
  --id union-orders \
  --source-id source-1 \
  --source-id source-2
```

Append dependent transformations without treating the unverified candidate as a source:

```bash
bash "$SHEET" integrity-scaffold \
  --requirements "$WORKSPACE/qa/requirements.json" \
  --operation join \
  --id join-products \
  --source-id source-3 \
  --from-operation union-orders \
  --append
```

The scaffold uses exact effective source paths and copies a prior operation's output mapping into dependent inputs. It sets `draft: true` and may use explicit `REPLACE_WITH_*` placeholders. Review the grain, map real columns and semantic types, correct exact header-excluding ranges, set output ranges and keys, then set `draft` to `false`. Move the finished plan into the builder registration.

Check the state without reading runtime source code:

```bash
bash "$SHEET" integrity-status \
  --requirements "$WORKSPACE/qa/requirements.json"
```

Fix only the returned source, placeholder, dependency, field, or range blockers. A mapped column outside its declared range is rejected before binding.

Manual binding remains available only for legacy/debug state:

```bash
bash "$SHEET" integrity-bind \
  --requirements "$WORKSPACE/qa/requirements.json"
```

Normal builders do not need this command: build performs the same validation and binding from `helpers.integrity.register`. Binding derives `sourceBackedSheets` and required formula ranges. Any later plan or evidence change requires a new build and attestation.

## Plan model

Use one operation per independently explainable transformation:

```json
{
  "protocol": "pilotdeck-numeric-integrity/v1",
  "mode": "strict",
  "operations": [],
  "invariants": []
}
```

Use absolute source paths. Use exact source and output A1 ranges excluding header rows. Map logical field names to absolute Excel columns:

```json
{
  "source": "/absolute/source.xlsx",
  "sheet": "订单明细",
  "range": "A2:G101",
  "columns": {
    "orderId": "A",
    "amount": "G"
  }
}
```

For a downstream operation, replace `source` with `operation` and reuse the referenced operation's exact output sheet, range, and selected column mappings:

```json
{
  "operation": "union-orders",
  "sheet": "订单明细",
  "range": "A4:F27",
  "columns": {
    "orderId": "A",
    "amount": "F"
  }
}
```

Dependencies must point backward in the plan. Their expected rows come from the prior source-derived transformation, not from candidate cells.

Ranges are evidence boundaries, not approximate hints. Include every intended record. The runtime skips rows whose mapped fields are all blank unless `skipBlankRows` is `false`.

## Field semantics

Declare every logical field once per operation:

```json
{
  "orderId": { "semanticType": "identifier" },
  "amount": {
    "semanticType": "decimal",
    "scale": 2,
    "currency": "CNY"
  }
}
```

Supported semantic types are:

- `decimal`: require a numeric cell and a scale from 0 to 12; compare through fixed-point integers.
- `integer`: require a safe integer numeric cell.
- `number`: require a finite numeric cell; use an explicit non-negative tolerance only when exact comparison is inappropriate.
- `identifier`: require text, preserving leading zeroes and long identifiers.
- `string`, `boolean`, `date`: require the matching cell type.

Do not declare identifiers as numbers. Do not accept a text value such as `"100"` for a numeric field. Declare `unit` or `currency` when it disambiguates otherwise identical values. Use `allowBlank` only when blanks are valid source facts.

## Structured operations

### Copy

Use `copy` for a positional or key-preserving transfer from one source region. It requires exactly one input. Declare `keyColumns` whenever a stable key exists.

### Union

Use `union` to append same-grain records from multiple regions. The runtime checks:

- record count;
- key coverage;
- missing and unexpected records;
- duplicate keys when `duplicatePolicy` is `error`;
- all declared output fields;
- order when `preserveOrder` is `true`.

Example skeleton:

```json
{
  "id": "merge-orders",
  "type": "union",
  "fields": {
    "orderId": { "semanticType": "identifier" },
    "amount": { "semanticType": "decimal", "scale": 2, "currency": "CNY" }
  },
  "inputs": [
    {
      "source": "/absolute/january.xlsx",
      "sheet": "订单",
      "range": "A2:C50",
      "columns": { "orderId": "A", "amount": "C" }
    },
    {
      "source": "/absolute/february.xlsx",
      "sheet": "订单",
      "range": "A2:C40",
      "columns": { "orderId": "A", "amount": "C" }
    }
  ],
  "output": {
    "sheet": "订单明细",
    "range": "A2:B90",
    "columns": { "orderId": "A", "amount": "B" }
  },
  "keyColumns": ["orderId"],
  "duplicatePolicy": "error"
}
```

### Join

Use `join` for key-based filling or horizontal merges. Put the base input first and lookup inputs after it. Declare `keyColumns`. The runtime rejects duplicate lookup keys, missing matches, conflicting fields, and many-to-many expansion. Use `missingMatchPolicy: "allow-blank"` only when an unmatched row is explicitly valid.

## Aggregation and formulas

Use `aggregate` for `sum`, `count`, `min`, `max`, or `average`. Declare `groupBy` and one or more measures:

```json
{
  "groupBy": ["department"],
  "measures": [
    {
      "source": "amount",
      "target": "totalAmount",
      "operator": "sum",
      "rounding": "half-up"
    }
  ]
}
```

The runtime recomputes aggregates from source records with rational arithmetic, then quantizes to the target field's declared scale. Supported rounding is `half-up`, `half-even`, or `truncate`.

Use `formula` for row-level derived values:

```json
{
  "calculations": [
    {
      "target": "amount",
      "expression": "quantity * unitPrice",
      "rounding": "half-up",
      "requireFormula": true
    }
  ]
}
```

Expressions support declared field names, decimal literals, parentheses, unary signs, and `+`, `-`, `*`, `/`. They use a parser and rational arithmetic; they never use JavaScript `eval`. Division by zero blocks delivery. Unless `requireFormula` is `false`, a correct hardcoded result still fails because derived logic must remain inspectable.

## Row invariants

Use invariants for stable business equations rather than plausible thresholds:

```json
{
  "id": "tax-balance",
  "type": "row-expression",
  "operation": "calculate-invoices",
  "expression": "gross - net - tax",
  "expected": "0",
  "scale": 2
}
```

Good invariants include quantity times unit price, net plus tax equals gross, opening plus movements equals closing, and debit equals credit. Do not invent an invariant when the business definition is ambiguous.

## Image evidence

The runtime binds and judges image evidence; it does not bundle an OCR model. Record observations produced by genuinely different methods against one exact image region:

```bash
bash "$SHEET" evidence-observe \
  --evidence "$WORKSPACE/qa/source-evidence.json" \
  --source "$SCAN" \
  --fact-id invoice-total \
  --region 120,380,260,80 \
  --method vision-model-a \
  --raw-text '1,250.00' \
  --value 1250.00 \
  --confidence 0.96
```

Record a second independent observation with a different method. Then declare an `ocr` operation and policy:

```json
{
  "ocrPolicy": {
    "minConfidence": 0.9,
    "minIndependentObservations": 2,
    "allowExplicitUserConfirmation": true
  }
}
```

The runtime accepts automatic evidence only when enough distinct methods meet the confidence threshold and agree on the normalized value. Method names are audit labels; do not relabel the same recognition pass as two independent methods.

When observations disagree, stop and show the bound crop or source region to the user. Only after the user explicitly confirms the value may you run:

```bash
bash "$SHEET" evidence-confirm \
  --evidence "$WORKSPACE/qa/source-evidence.json" \
  --fact-id invoice-total \
  --value 1250.00 \
  --confirmed-by user
```

Never infer confirmation from silence, prior context, a model's confidence, or a balancing equation. After any observation or confirmation change, rebuild so the registered plan, evidence, audit, and attestation are rebound together. Use `integrity-bind` directly only when repairing legacy/debug state.

## Failure policy

Block build, QA, and delivery for:

- a changed or missing source;
- stale evidence or plan hashes;
- a plan referencing an unfrozen source;
- incomplete keys, missing records, unexpected records, duplicate lookup keys, or conflicting joins;
- a numeric field written as text;
- a mismatched aggregate, calculation, formula cache, or invariant;
- a required formula replaced by a hardcoded result;
- an image-region hash mismatch;
- insufficient, low-confidence, or disagreeing image observations without explicit user confirmation;
- an output value that differs from trusted image evidence.

Fix the source selection, plan, builder, or evidence. Do not weaken the plan, widen tolerance, mark a duplicate as allowed, or invoke user confirmation merely to make a gate pass.

## Claims

State only what the delivery report proves. Prefer:

- "All declared source rows and numeric fields reconciled."
- "Aggregates and formulas were independently recomputed at the declared scale."
- "Two independent observations agreed," or "the user explicitly confirmed the bound image value."

Do not claim that the source document itself is authentic, that OCR is infallible, or that undeclared business intent was validated.
