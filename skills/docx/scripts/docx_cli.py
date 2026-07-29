#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from docxlib.audit import audit_docx
from docxlib.common import (
    DocxSkillError,
    prepare_json_artifact_path,
    validate_docx,
    write_json,
)
from docxlib.core import (
    compare_docx,
    create_docx,
    edit_docx,
    filter_inspection,
    inspect_docx,
    sanitize_docx,
)
from docxlib.fallback import fallback_create, fallback_patch
from docxlib.preflight import preflight_docx
from docxlib.protocol import capabilities, schema_for
from docxlib.render import render_docx
from docxlib.review import finalize_docx, review_docx


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="docx.sh",
        description="Create, inspect, edit, review, render, and validate Word DOCX files.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("capabilities", help="Report exact supported, fallback, and blocked capabilities")

    schema_parser = sub.add_parser("schema", help="Emit the strict JSON schema for an operation")
    schema_parser.add_argument(
        "--command",
        dest="schema_command",
        required=True,
        choices=("create", "edit", "review"),
    )

    inspect_parser = sub.add_parser("inspect", help="Extract DOCX structure and metadata")
    inspect_parser.add_argument("--input", required=True)
    inspect_parser.add_argument("--out")
    inspect_parser.add_argument("--summary", action="store_true")
    inspect_parser.add_argument("--search")
    inspect_parser.add_argument("--location")
    inspect_parser.add_argument("--max-items", type=int, default=200)

    create_parser = sub.add_parser("create", help="Create a DOCX from a JSON specification")
    create_parser.add_argument("--spec", required=True)
    create_parser.add_argument("--out", required=True)
    create_parser.add_argument("--overwrite", action="store_true")

    edit_parser = sub.add_parser("edit", help="Apply local edits from a JSON patch")
    edit_parser.add_argument("--input", required=True)
    edit_parser.add_argument("--patch", required=True)
    edit_parser.add_argument("--out", required=True)
    edit_parser.add_argument("--overwrite", action="store_true")
    edit_parser.add_argument(
        "--allow-lossy",
        action="store_true",
        help="Explicitly allow a python-docx round trip on a package-sensitive document",
    )

    review_parser = sub.add_parser("review", help="Add comments and tracked replacements")
    review_parser.add_argument("--input", required=True)
    review_parser.add_argument("--spec", required=True)
    review_parser.add_argument("--out", required=True)
    review_parser.add_argument("--overwrite", action="store_true")

    finalize_parser = sub.add_parser("finalize", help="Accept/reject changes and remove comments")
    finalize_parser.add_argument("--input", required=True)
    finalize_parser.add_argument("--out", required=True)
    finalize_parser.add_argument("--overwrite", action="store_true")
    changes = finalize_parser.add_mutually_exclusive_group()
    changes.add_argument("--accept-changes", action="store_true")
    changes.add_argument("--reject-changes", action="store_true")
    finalize_parser.add_argument("--remove-comments", action="store_true")

    compare_parser = sub.add_parser("compare", help="Compare paragraph text between two DOCX files")
    compare_parser.add_argument("--before", required=True)
    compare_parser.add_argument("--after", required=True)
    compare_parser.add_argument("--out", required=True)

    sanitize_parser = sub.add_parser("sanitize", help="Remove personal metadata and revision IDs")
    sanitize_parser.add_argument("--input", required=True)
    sanitize_parser.add_argument("--out", required=True)
    sanitize_parser.add_argument("--overwrite", action="store_true")
    sanitize_parser.add_argument("--remove-comments", action="store_true")

    render_parser = sub.add_parser("render", help="Render DOCX pages to PNG through LibreOffice")
    render_parser.add_argument("--input", required=True)
    render_parser.add_argument("--out-dir", required=True)
    render_parser.add_argument("--dpi", type=int, default=150)
    render_parser.add_argument("--emit-pdf", action="store_true")
    render_parser.add_argument("--timeout", type=int, default=120)

    validate_parser = sub.add_parser("validate", help="Validate DOCX ZIP and OOXML integrity")
    validate_parser.add_argument("--input", required=True)

    audit_parser = sub.add_parser(
        "audit", help="Audit structure, layout risk, accessibility, and finalization state"
    )
    audit_parser.add_argument("--input", required=True)
    audit_parser.add_argument("--out")
    audit_parser.add_argument(
        "--profile", choices=("draft", "final", "accessible"), default="draft"
    )

    fallback_patch_parser = sub.add_parser(
        "fallback-patch",
        help="Run a declared OOXML patch and enforce the allowed package-part scope",
    )
    fallback_patch_parser.add_argument("--input", required=True)
    fallback_patch_parser.add_argument("--script", required=True)
    fallback_patch_parser.add_argument("--out", required=True)
    fallback_patch_parser.add_argument("--manifest", required=True)
    fallback_patch_parser.add_argument("--allow-part", action="append")
    fallback_patch_parser.add_argument("--reason", required=True)
    fallback_patch_parser.add_argument("--timeout", type=int, default=120)
    fallback_patch_parser.add_argument("--overwrite", action="store_true")

    fallback_create_parser = sub.add_parser(
        "fallback-create",
        help="Run a declared custom creator and validate the resulting DOCX",
    )
    fallback_create_parser.add_argument("--script", required=True)
    fallback_create_parser.add_argument("--out", required=True)
    fallback_create_parser.add_argument("--manifest", required=True)
    fallback_create_parser.add_argument("--reason", required=True)
    fallback_create_parser.add_argument("--timeout", type=int, default=120)

    preflight_parser = sub.add_parser(
        "preflight",
        help="Gate package integrity, audit warnings, render coverage, and visual review",
    )
    preflight_parser.add_argument("--input", required=True)
    preflight_parser.add_argument("--out-dir", required=True)
    preflight_parser.add_argument("--report")
    preflight_parser.add_argument(
        "--profile", choices=("draft", "final", "accessible"), default="final"
    )
    preflight_parser.add_argument("--dispositions")
    preflight_parser.add_argument("--require-text", action="append")
    preflight_parser.add_argument("--min-pages", type=int)
    preflight_parser.add_argument("--max-pages", type=int)
    visual_review = preflight_parser.add_mutually_exclusive_group()
    visual_review.add_argument(
        "--visual-review-status",
        choices=("passed", "failed"),
        help="Record the explicit result after inspecting every current page image",
    )
    visual_review.add_argument(
        "--visual-reviewed",
        action="store_true",
        help="Deprecated alias for --visual-review-status passed",
    )
    preflight_parser.add_argument("--timeout", type=int, default=120)

    sub.add_parser("self-test", help="Run the bundled end-to-end smoke test")
    return parser


def _execute(args: argparse.Namespace) -> dict[str, Any]:
    if args.command == "capabilities":
        return capabilities()
    if args.command == "schema":
        return schema_for(args.schema_command)
    if args.command == "inspect":
        result = inspect_docx(args.input)
        result = filter_inspection(
            result,
            summary=args.summary,
            search=args.search,
            location=args.location,
            max_items=args.max_items,
        )
        if args.out:
            json_output = prepare_json_artifact_path(
                args.out,
                protected_paths=(args.input,),
                purpose="Inspection output",
            )
            write_json(json_output, result)
            result["out"] = str(json_output)
        return result
    if args.command == "create":
        return create_docx(args.spec, args.out, overwrite=args.overwrite)
    if args.command == "edit":
        return edit_docx(
            args.input,
            args.patch,
            args.out,
            allow_lossy=args.allow_lossy,
            overwrite=args.overwrite,
        )
    if args.command == "review":
        return review_docx(
            args.input, args.spec, args.out, overwrite=args.overwrite
        )
    if args.command == "finalize":
        return finalize_docx(
            args.input,
            args.out,
            accept_changes=args.accept_changes,
            reject_changes=args.reject_changes,
            remove_comments=args.remove_comments,
            overwrite=args.overwrite,
        )
    if args.command == "compare":
        return compare_docx(args.before, args.after, args.out)
    if args.command == "sanitize":
        return sanitize_docx(
            args.input,
            args.out,
            remove_comments=args.remove_comments,
            overwrite=args.overwrite,
        )
    if args.command == "render":
        return render_docx(
            args.input,
            args.out_dir,
            dpi=args.dpi,
            emit_pdf=args.emit_pdf,
            timeout_seconds=args.timeout,
        )
    if args.command == "validate":
        return validate_docx(args.input)
    if args.command == "audit":
        return audit_docx(args.input, args.out, profile=args.profile)
    if args.command == "fallback-patch":
        return fallback_patch(
            args.input,
            args.script,
            args.out,
            args.manifest,
            allow_parts=args.allow_part,
            reason=args.reason,
            timeout_seconds=args.timeout,
            overwrite=args.overwrite,
        )
    if args.command == "fallback-create":
        return fallback_create(
            args.script,
            args.out,
            args.manifest,
            reason=args.reason,
            timeout_seconds=args.timeout,
        )
    if args.command == "preflight":
        visual_review_status = (
            "passed"
            if args.visual_reviewed
            else (args.visual_review_status or "not-reviewed")
        )
        return preflight_docx(
            args.input,
            args.out_dir,
            report_path=args.report,
            profile=args.profile,
            dispositions_path=args.dispositions,
            required_text=args.require_text,
            min_pages=args.min_pages,
            max_pages=args.max_pages,
            visual_review_status=visual_review_status,
            timeout_seconds=args.timeout,
        )
    if args.command == "self-test":
        from docxlib.smoke import run_smoke_test

        return run_smoke_test()
    raise DocxSkillError(f"Unsupported command: {args.command}")


def main() -> int:
    args = _parser().parse_args()
    try:
        result = _execute(args)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result.get("status") == "ok" else 3
    except DocxSkillError as exc:
        print(
            json.dumps(
                {
                    "status": exc.status,
                    "code": exc.code,
                    "error": str(exc),
                    "details": exc.details,
                    "command": args.command,
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 3
    except Exception as exc:
        print(
            json.dumps(
                {
                    "status": "error",
                    "error": f"Unexpected {type(exc).__name__}: {exc}",
                    "command": args.command,
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
