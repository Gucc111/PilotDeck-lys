from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .audit import audit_docx
from .common import (
    DocxSkillError,
    assert_valid_docx,
    prepare_json_artifact_path,
    write_json,
)
from .core import inspect_docx
from .protocol import load_dispositions
from .render import render_docx


def _normalize_text(value: str) -> str:
    return re.sub(r"\s+", "", value).casefold()


def _issue_counts(items: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in items:
        code = str(item.get("code", "unknown"))
        counts[code] = counts.get(code, 0) + 1
    return dict(sorted(counts.items()))


def _compact_issues(
    items: list[dict[str, Any]],
    *,
    limit: int = 8,
) -> dict[str, Any]:
    return {
        "total": len(items),
        "by_code": _issue_counts(items),
        "items": items[:limit],
        "truncated": len(items) > limit,
    }


def preflight_docx(
    input_path: str | Path,
    output_dir: str | Path,
    *,
    report_path: str | Path | None = None,
    profile: str = "final",
    dispositions_path: str | Path | None = None,
    required_text: list[str] | None = None,
    min_pages: int | None = None,
    max_pages: int | None = None,
    visual_review_status: str = "not-reviewed",
    timeout_seconds: int = 120,
) -> dict[str, Any]:
    if min_pages is not None and min_pages < 1:
        raise DocxSkillError("min_pages must be positive", code="invalid-preflight")
    if max_pages is not None and max_pages < 1:
        raise DocxSkillError("max_pages must be positive", code="invalid-preflight")
    if min_pages and max_pages and min_pages > max_pages:
        raise DocxSkillError("min_pages cannot exceed max_pages", code="invalid-preflight")
    if visual_review_status not in {"not-reviewed", "passed", "failed"}:
        raise DocxSkillError(
            "visual_review_status must be not-reviewed, passed, or failed",
            code="invalid-preflight",
        )
    report_output = (
        prepare_json_artifact_path(
            report_path,
            protected_paths=(input_path,),
            purpose="Preflight report",
        )
        if report_path
        else None
    )

    validation = assert_valid_docx(input_path)
    inspection = inspect_docx(input_path)
    audit = audit_docx(input_path, profile=profile)
    dispositions = load_dispositions(dispositions_path)

    audit_issues: list[dict[str, Any]] = []
    unknown_dispositions = set(dispositions)
    for issue in audit["issues"]:
        item = dict(issue)
        code = str(item.get("code", ""))
        if code in dispositions and item.get("severity") != "error":
            item["disposition"] = dispositions[code]
            item["resolved"] = True
            unknown_dispositions.discard(code)
        else:
            item["resolved"] = False
        audit_issues.append(item)

    render_result = render_docx(
        input_path,
        output_dir,
        dpi=150,
        emit_pdf=True,
        include_text=True,
        timeout_seconds=timeout_seconds,
    )
    rendered_text = "\n".join(
        str(item.get("text", "")) for item in render_result.get("page_text", [])
    )
    normalized_rendered = _normalize_text(rendered_text)
    for item in render_result.get("page_text", []):
        item.pop("text", None)
    coverage_checks = []
    for value in required_text or []:
        present = _normalize_text(value) in normalized_rendered
        coverage_checks.append({"text": value, "present": present})

    gate_issues: list[dict[str, Any]] = []
    for warning in validation.get("warnings", []):
        gate_issues.append(
            {
                "severity": "warning",
                "code": "package-validation-warning",
                "message": str(warning),
            }
        )
    inspection_coverage = inspection.get("inspection_coverage", {})
    if inspection_coverage.get("status") != "complete":
        gate_issues.append(
            {
                "severity": "warning",
                "code": "inspection-coverage-partial",
                "message": "Some package features are inventoried but not fully interpreted.",
                "limitations": list(inspection_coverage.get("limitations", [])),
            }
        )
    pages = int(render_result["pages"])
    if min_pages is not None and pages < min_pages:
        gate_issues.append(
            {
                "severity": "error",
                "code": "page-count-below-minimum",
                "message": f"Rendered {pages} page(s), below the required minimum {min_pages}.",
            }
        )
    if max_pages is not None and pages > max_pages:
        gate_issues.append(
            {
                "severity": "error",
                "code": "page-count-above-maximum",
                "message": f"Rendered {pages} page(s), above the allowed maximum {max_pages}.",
            }
        )
    missing_text = [item["text"] for item in coverage_checks if not item["present"]]
    if missing_text:
        gate_issues.append(
            {
                "severity": "error",
                "code": "rendered-text-coverage",
                "message": "Required text is missing from the rendered PDF.",
                "missing": missing_text,
            }
        )
    if int(render_result.get("text_characters", 0)) == 0 and inspection["paragraph_count"]:
        gate_issues.append(
            {
                "severity": "error",
                "code": "rendered-text-empty",
                "message": "The document has text, but the rendered PDF exposes no text.",
            }
        )
    if visual_review_status == "failed":
        gate_issues.append(
            {
                "severity": "error",
                "code": "visual-review-failed",
                "message": "One or more rendered pages failed visual inspection.",
            }
        )
    for item in gate_issues:
        code = str(item.get("code", ""))
        if code in dispositions and item.get("severity") != "error":
            item["disposition"] = dispositions[code]
            item["resolved"] = True
            unknown_dispositions.discard(code)
        else:
            item["resolved"] = False

    if unknown_dispositions:
        gate_issues.append(
            {
                "severity": "warning",
                "code": "unused-warning-disposition",
                "message": "Some warning disposition codes did not match current audit issues.",
                "codes": sorted(unknown_dispositions),
                "resolved": False,
            }
        )

    unresolved_audit = [item for item in audit_issues if not item["resolved"]]
    unresolved_gate = [item for item in gate_issues if not item.get("resolved", False)]
    unresolved_errors = [
        item
        for item in [*unresolved_audit, *unresolved_gate]
        if item.get("severity") == "error"
    ]
    unresolved_warnings = [
        item
        for item in [*unresolved_audit, *unresolved_gate]
        if item.get("severity") == "warning"
    ]
    automated_passed = not unresolved_errors and not unresolved_warnings
    passed = automated_passed and visual_review_status == "passed"
    result: dict[str, Any] = {
        "status": "ok" if passed else "partial",
        "passed": passed,
        "input": str(Path(input_path).expanduser().resolve()),
        "profile": profile,
        "checks": {
            "package_validation": "passed",
            "audit": "passed" if not unresolved_audit else "needs-attention",
            "render": "passed",
            "text_coverage": "passed" if not missing_text else "failed",
            "visual_review": visual_review_status,
        },
        "coverage": {
            "status": "passed" if not missing_text else "failed",
            "required_text": coverage_checks,
            "inspection": inspection.get("inspection_coverage"),
        },
        "visual_review": {
            "status": visual_review_status,
            "required": visual_review_status == "not-reviewed",
        },
        "render": render_result,
        "audit": {
            "summary": audit["summary"],
            "issues": audit_issues,
        },
        "gate_issues": gate_issues,
        "unresolved": {
            "errors": unresolved_errors,
            "warnings": unresolved_warnings,
        },
        "validation": validation,
    }
    if report_output:
        write_json(report_output, result)
        result["report"] = str(report_output)

    compact = dict(result)
    compact["audit"] = {
        "summary": audit["summary"],
        "issues": _compact_issues(audit_issues),
    }
    compact["unresolved"] = {
        "errors": unresolved_errors,
        "warnings": _compact_issues(unresolved_warnings, limit=0),
    }
    return compact
