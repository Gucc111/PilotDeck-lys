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
- Treat `source-evidence.json` as a generated inventory and image-region ledger. Never hand-edit it.
- Treat `integrity-plan.json` as the declared transformation, not as a list of model-authored answers.
- Let `audit` reread the frozen files and independently recompute the expected records and values.
- Require `deliver` to repeat the same audit. A stale plan, stale evidence file, changed source, unverified image fact, or mismatched output blocks delivery.

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

Inspect the source ranges, then complete the plan. Query the authoritative schema instead of guessing fields:

```bash
bash "$SHEET" schema --command numeric-integrity
```

Bind the completed plan:

```bash
bash "$SHEET" integrity-bind \
  --requirements "$WORKSPACE/qa/requirements.json"
```

Binding validates the plan, binds the current plan and evidence hashes, derives `sourceBackedSheets`, and derives required formula ranges. Any later plan or evidence change requires another `integrity-bind`.

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

Never infer confirmation from silence, prior context, a model's confidence, or a balancing equation. Re-run `integrity-bind` after any observation or confirmation change.

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
