---
name: docx
description: Create, inspect, edit, review, compare, sanitize, render, audit, preflight, and finalize professional Microsoft Word .docx documents through an explicit capability, execution, controlled-fallback, and acceptance protocol. Use whenever PilotDeck must produce or modify a Word document, preserve an existing document while making targeted changes, add comments or tracked replacements, analyze structure or metadata, verify accessibility and layout quality, compare revisions, remove review data, or deliver a visually checked DOCX. Use only for .docx files, not legacy .doc, macro-enabled .docm, or Google Docs operations.
---

# Professional Word DOCX

Treat a Word document as both structured content and a paginated visual artifact. The bundled CLI is the authority for what the skill can do. Never infer missing capability from examples, silently ignore unsupported fields, or bypass the CLI with an ad hoc Python program. Use the controlled fallback protocol when the declared operation is insufficient. Do not deliver a mutated DOCX until structural, rendered-text, warning-disposition, and visual-review gates pass.

## Resolve and invoke the skill

Resolve the directory containing this `SKILL.md` as `DOCX_SKILL_ROOT`. Common locations are:

```bash
DOCX_SKILL_ROOT="${PILOT_HOME:-$HOME/.pilotdeck}/skills/docx"
# In a source checkout: <repo>/skills/docx
```

Invoke all deterministic operations through:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" <command> [options]
```

Use the turn-scoped PilotDeck work directory for every intermediate. The host sets `PILOTDECK_WORK_DIR`; the fallback keeps manual runs internal to the project:

```bash
WORKSPACE="${PILOTDECK_WORK_DIR:-$PWD/.pilotdeck/work/manual/<task-slug>}/docx"
mkdir -p "$WORKSPACE/tmp" "$WORKSPACE/qa"
```

Keep JSON specifications, inspections, comparisons, rendered pages, optional QA PDFs, and temporary candidates in `WORKSPACE`. Keep source documents in place and put only requested final DOCX deliverables in the project or user-selected output directory. Never create inspection JSON, render directories, or other intermediates beside the user's files. Do not write task artifacts into the skill directory.

## Route the request

| User intent | Primary command | Read first |
|---|---|---|
| Discover exact support or JSON fields | `capabilities`, `schema` | [capabilities-and-fallbacks.md](references/capabilities-and-fallbacks.md) |
| Read, summarize, or inspect a DOCX | `inspect` | [workflows.md](references/workflows.md) |
| Create a new document or substantially redesign one | `create` | [design-and-layout.md](references/design-and-layout.md), then [specifications.md](references/specifications.md) |
| Make targeted edits while preserving the source | `edit` | [workflows.md](references/workflows.md), then [specifications.md](references/specifications.md) |
| Add reviewer comments or tracked replacements | `review` | [ooxml-and-safety.md](references/ooxml-and-safety.md), then [specifications.md](references/specifications.md) |
| Accept/reject changes or strip comments | `finalize` | [workflows.md](references/workflows.md) |
| Compare two document versions | `compare` | [workflows.md](references/workflows.md) |
| Remove personal metadata and revision identifiers | `sanitize` | [ooxml-and-safety.md](references/ooxml-and-safety.md) |
| Check package integrity | `validate` | This file |
| Audit styles, hierarchy, tables, accessibility, or finalization | `audit` | [design-and-layout.md](references/design-and-layout.md) |
| Convert every page to PNG for visual QA | `render` | [workflows.md](references/workflows.md) |
| Run the final delivery gate | `preflight` | [workflows.md](references/workflows.md) |
| Perform an operation outside the standard schema | `fallback-patch` or `fallback-create` | [capabilities-and-fallbacks.md](references/capabilities-and-fallbacks.md), then [ooxml-and-safety.md](references/ooxml-and-safety.md) |

## Non-negotiable operating contract

1. Run `check`, then `capabilities`, before the first DOCX operation in a session. Run `fix` only if dependencies are missing and installation is allowed.
2. Run `schema --command <create|edit|review>` before writing a JSON specification. Unknown fields and operations are errors; never assume they were applied.
3. Validate and inspect every existing input before changing it. Read package features and inspection coverage, not only extracted paragraph text. Never bypass declared document/write protection.
4. If the operation is declared supported, use the bundled command first. Do not replace it with `python-docx`, direct ZIP/XML mutation, or another library.
5. If the standard operation returns `partial`, `unsupported`, or `blocked`, stop and follow the decision ladder in [capabilities-and-fallbacks.md](references/capabilities-and-fallbacks.md). Never turn those statuses into success.
6. Every fallback must be explicit: state the unmet capability and reason, keep its program under `WORKSPACE/tmp`, execute `fallback-patch` or `fallback-create`, and retain the generated manifest in `WORKSPACE/qa`.
7. Apply the smallest change that satisfies an edit request. Preserve the original and write every mutation to a new `.docx` path. Existing outputs are blocked by default; pass `--overwrite` only when the user explicitly requests replacement. `fallback-create` never overwrites.
8. Use `preflight` as the delivery gate. Every warning must be fixed or assigned a concrete disposition. Inspect every generated PNG, then rerun preflight with `--visual-review-status passed` or `--visual-review-status failed`. A failed visual review is blocking and cannot be dispositioned.
9. Return only requested deliverables. Keep specifications, manifests, audits, PNG pages, optional PDFs, and other intermediates internal unless requested.

## Capability and result protocol

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" capabilities
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" schema --command create
```

All operation results use one of:

- `ok`: the requested operation completed within its declared fidelity.
- `partial`: output or inspection exists, but an unresolved target, warning, coverage gap, or review remains.
- `unsupported`: the requested capability is outside the standard operation; choose an approved fallback or report it.
- `blocked`: continuing would risk fidelity, signatures, protection, package scope, or safety.
- `error`: invalid input, invalid specification, execution failure, or invalid output.

Only `ok` is success. Do not use `|| true`, discard stderr, parse a failed result as a deliverable, or claim completion from the existence of a file.

## Prepare the environment

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" check
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" fix
```

`fix` creates an isolated Python environment in the user's cache directory and never installs packages globally. LibreOffice is detected but not installed automatically.

If LibreOffice is unavailable, `render` and `preflight` report `unsupported`; complete structural validation and auditing, disclose that visual QA was not completed, and do not claim delivery passed the full gate. If rendering fails for another reason, diagnose the environment before delivery.

## Inspect before reasoning or editing

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" inspect \
  --input "$INPUT_DOCX" --summary --out "$WORKSPACE/tmp/inspection-summary.json"

bash "$DOCX_SKILL_ROOT/scripts/docx.sh" inspect \
  --input "$INPUT_DOCX" --search "target phrase" --max-items 50 \
  --out "$WORKSPACE/tmp/inspection-target.json"
```

Review at least:

- metadata and personal fields;
- paragraph text, styles, run formatting, and locations;
- heading order and hierarchy;
- tables and cell content;
- sections, page dimensions, orientation, and margins;
- headers and footers;
- comments and tracked-change counts;
- fields, images, external relationships, and validation warnings.

`inspect` returns `partial` when it can inventory a package feature but cannot
interpret its complete reading order or behavior, such as text boxes, notes,
Office Math, SmartArt/diagrams, chart semantics, content controls, embedded
objects, protected-document behavior, or nonstandard custom XML.
Continue only within the explicitly covered scope; never describe a partial
inspection as a complete reading of the document.

For read-only questions, do not edit or re-export the source. Preserve qualifiers from headings, table labels, notes, and nearby context when answering.

## Create new documents deliberately

Before writing the JSON specification:

1. Identify the document archetype: brief, memo, report, proposal, SOP, reference guide, form, or simple document.
2. Choose one supported preset and define page geometry, hierarchy, content forms, tables, images, headers, and footers.
3. Read [design-and-layout.md](references/design-and-layout.md). Map each major information unit to prose, a list, steps, a checklist, a callout, a definition list, a real data table, an image, or sources.
4. Query `schema --command create`, read [specifications.md](references/specifications.md), and create a specification using only supported blocks.
5. Run standard `create`. If the schema cannot express a required feature, follow the controlled fallback decision before writing custom code.
6. Generate, inspect, compare when relevant, and run preflight.

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" create \
  --spec "$WORKSPACE/tmp/document.json" --out "$FINAL_DOCX"
```

Do not rely on Word defaults for page geometry, heading hierarchy, list semantics, table widths, or cell padding. Prefer reusable Word styles and real list definitions over manually formatted lookalikes. A chart may be generated as a local image and referenced by an image block without entering full-create fallback.

If the chosen output path already exists, choose a new versioned path. Use `--overwrite` only after explicit user authorization.

## Edit existing documents surgically

Use `edit` for supported local changes:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" edit \
  --input "$INPUT_DOCX" --patch "$WORKSPACE/tmp/edits.json" --out "$FINAL_DOCX"
```

Preserve structure and formatting unless the user requests redesign. Prefer inline replacement over paragraph replacement, and paragraph replacement over full-document reconstruction. Ambiguous targets require `occurrence` or `location`. A missing target returns `partial`; it is not a successful no-op.

The standard editor blocks a `python-docx` round trip when package-sensitive features could be lost. Prefer `fallback-patch` with a narrow OOXML part allowlist. Use `--allow-lossy` only when the user explicitly accepts the listed fidelity risk; record that decision.

`--overwrite` authorizes replacing an existing output file; it never authorizes using the input path as the output path.

Use comments or tracked replacements when the user requests reviewable changes. Do not silently turn a review task into a clean rewrite.

## Manage the review lifecycle

Add comments and tracked replacements:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" review \
  --input "$INPUT_DOCX" --spec "$WORKSPACE/tmp/review.json" --out "$FINAL_DOCX"
```

Finalize a reviewed document:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" finalize \
  --input "$INPUT_DOCX" --accept-changes --remove-comments --out "$FINAL_DOCX"
```

Use `--reject-changes` instead of `--accept-changes` when requested. Never pass both. Inspect after review and after finalization because page rendering does not reliably expose comment anchors.

## Validate and audit

Validate the ZIP package, required OOXML parts, XML well-formedness, archive safety, and macro absence:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" validate --input "$FINAL_DOCX"
```

Audit semantic and layout risks:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" audit \
  --input "$FINAL_DOCX" --profile draft --out "$WORKSPACE/qa/draft-audit.json"

bash "$DOCX_SKILL_ROOT/scripts/docx.sh" audit \
  --input "$FINAL_DOCX" --profile final --out "$WORKSPACE/qa/final-audit.json"

bash "$DOCX_SKILL_ROOT/scripts/docx.sh" audit \
  --input "$FINAL_DOCX" --profile accessible --out "$WORKSPACE/qa/a11y-audit.json"
```

Interpret profiles as follows:

- `draft`: flag hierarchy, fake lists, small text, unstable table geometry, narrow margins, and formatting drift.
- `final`: include draft checks and fail the audit when comments or tracked changes remain; warn about personal metadata.
- `accessible`: include final checks and flag missing image alternative text or unmarked repeating table headers.

An audit can contain warnings even when `passed` is true. An audit with errors
or partial inspection coverage returns top-level `status: partial`; it must not
be treated as a successful audit. Final delivery is stricter: every warning
must be fixed or included in a disposition JSON mapping its issue code to a
specific rationale.

## Render and inspect every page

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" render \
  --input "$FINAL_DOCX" --out-dir "$WORKSPACE/qa/rendered" --emit-pdf
```

Inspect every PNG for:

- clipped, overlapping, missing, or substituted text;
- broken glyphs and inappropriate font fallback;
- headings stranded at page bottoms;
- awkward blank pages or large unexplained gaps;
- lists with incorrect wrapping or indentation;
- table overflow, narrow narrative columns, cramped cells, lost headers, or split rows;
- images outside margins, distorted scaling, or separated captions;
- inconsistent section geometry;
- misplaced headers, footers, and page breaks.

Rendering verifies visible layout but not all document semantics. Verify comments, revisions, relationships, fields, and metadata structurally with `inspect`, `audit`, or OOXML-aware commands.

## Run the final preflight

First run preflight without claiming visual review:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" preflight \
  --input "$FINAL_DOCX" \
  --out-dir "$WORKSPACE/qa/rendered" \
  --report "$WORKSPACE/qa/preflight.json" \
  --profile final \
  --require-text "critical phrase"
```

Resolve every error. Fix warnings or create a disposition file such as:

```json
{
  "personal-metadata": "The user explicitly requested the named author in document properties."
}
```

Inspect every latest PNG. Then rerun with the same requirements plus either `--visual-review-status passed` or `--visual-review-status failed` and, when used, `--dispositions`. Delivery passes only when the result is `status: ok`, `passed: true`, `visual_review.status: passed`, and `coverage.status: passed`. Never mark a visually incomplete page as passed merely because its PDF text layer contains the expected text.

## Compare and sanitize

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" compare \
  --before "$INPUT_DOCX" --after "$FINAL_DOCX" --out "$WORKSPACE/qa/comparison.json"

bash "$DOCX_SKILL_ROOT/scripts/docx.sh" sanitize \
  --input "$INPUT_DOCX" --out "$FINAL_DOCX" --remove-comments
```

`compare` reports paragraph-level textual differences and document counts; it is not a pixel diff and does not prove formatting equivalence. `sanitize` removes core personal metadata, custom properties, revision identifiers, and optionally comments; it does not redact sensitive words from visible document content.

## Safety and fidelity rules

- Accept `.docx` only. Reject `.doc`, `.docm`, `.dotm`, and unrelated ZIP archives.
- Reject unsafe archive paths, malformed XML, macro payloads, and suspiciously expanded packages.
- Never fetch remote images. Use local workspace files only.
- Preserve the source and avoid destructive overwrite by default.
- Do not claim that comments were visually verified from rendered pages.
- Do not bypass document or write protection. Do not claim full fidelity for digital signatures, embedded objects, notes, Office Math, SmartArt/diagrams, complex content controls, or custom XML without explicit inspection. Read [ooxml-and-safety.md](references/ooxml-and-safety.md) before touching package-sensitive documents.
- Never run a custom DOCX builder directly as the delivery path. Standard operations must be tried or declared insufficient first; custom code must run through the controlled fallback command and manifest.
- Keep citations and sources as ordinary human-readable document text. Never expose internal tool tokens, private paths, credentials, or hidden reasoning in the document.
- Do not present generated facts as sourced. Preserve existing citations and clearly distinguish supplied facts from drafted language.

## Delivery gate

Before returning a DOCX, confirm all of the following:

- the requested content and edits are complete;
- the output is a new, valid `.docx` file;
- preflight reports `status: ok`, `passed: true`, and `coverage.status: passed`, or the response explicitly states why full preflight was impossible;
- every warning is fixed or has a specific recorded disposition;
- every rendered page from the latest document was inspected;
- comments and revisions match the requested delivery state;
- metadata and privacy state match the request;
- only the final requested artifact is linked in the response.

Run the bundled end-to-end regression when changing this skill itself:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" self-test
```
