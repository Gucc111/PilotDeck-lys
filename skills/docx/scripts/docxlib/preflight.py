from __future__ import annotations

import json
import hashlib
import re
from pathlib import Path
from typing import Any

from PIL import Image

from .audit import audit_docx
from .common import (
    DocxSkillError,
    assert_internal_control_path,
    assert_valid_docx,
    file_sha256,
    prepare_json_artifact_path,
    write_json,
)
from .core import inspect_docx
from .protocol import load_dispositions
from .render import render_docx
from .toc import toc_status


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


def _page_image_sha256(path: str | Path) -> str:
    """Hash decoded pixels rather than unstable PNG container metadata."""
    with Image.open(path) as image:
        normalized = image.convert("RGB")
        digest = hashlib.sha256()
        digest.update(f"{normalized.width}x{normalized.height}:RGB\0".encode())
        digest.update(normalized.tobytes())
        return digest.hexdigest()


def _load_json_object(
    path: str | Path | None,
    *,
    label: str,
) -> tuple[Path | None, dict[str, Any]]:
    if not path:
        return None, {}
    source = assert_internal_control_path(path, purpose=label)
    try:
        value = json.loads(source.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise DocxSkillError(
            f"{label} not found: {source}",
            code=f"{label.lower().replace(' ', '-')}-not-found",
        ) from exc
    except json.JSONDecodeError as exc:
        raise DocxSkillError(
            f"Invalid {label} JSON: {exc}",
            code=f"invalid-{label.lower().replace(' ', '-')}",
        ) from exc
    if not isinstance(value, dict):
        raise DocxSkillError(
            f"{label} must be a JSON object",
            code=f"invalid-{label.lower().replace(' ', '-')}",
        )
    return source, value


def _acceptance_requirements(
    acceptance: dict[str, Any],
) -> dict[str, Any]:
    allowed = {
        "required_text",
        "required_headings",
        "page_count",
        "toc",
        "protected_sources",
    }
    unknown = sorted(set(acceptance) - allowed)
    if unknown:
        raise DocxSkillError(
            f"Unknown acceptance field(s): {', '.join(unknown)}",
            code="invalid-acceptance-manifest",
            details={"unknown": unknown},
        )
    required_text = acceptance.get("required_text", [])
    if not isinstance(required_text, list) or any(
        not isinstance(value, str) or not value.strip() for value in required_text
    ):
        raise DocxSkillError(
            "acceptance.required_text must be an array of non-empty strings",
            code="invalid-acceptance-manifest",
        )
    required_headings = acceptance.get("required_headings", [])
    if not isinstance(required_headings, list):
        raise DocxSkillError(
            "acceptance.required_headings must be an array",
            code="invalid-acceptance-manifest",
        )
    normalized_headings: list[dict[str, Any]] = []
    for item in required_headings:
        if isinstance(item, str):
            if not item.strip():
                raise DocxSkillError(
                    "acceptance.required_headings cannot contain empty text",
                    code="invalid-acceptance-manifest",
                )
            normalized_headings.append({"text": item.strip(), "level": None})
            continue
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("text"), str)
            or not item["text"].strip()
            or set(item) - {"text", "level"}
        ):
            raise DocxSkillError(
                "Each required heading must be a string or {text, optional level}",
                code="invalid-acceptance-manifest",
            )
        level = item.get("level")
        if level is not None and (
            not isinstance(level, int)
            or isinstance(level, bool)
            or level < 1
            or level > 9
        ):
            raise DocxSkillError(
                "required_headings.level must be an integer from 1 to 9",
                code="invalid-acceptance-manifest",
            )
        normalized_headings.append(
            {"text": item["text"].strip(), "level": level}
        )
    page_count = acceptance.get("page_count", {})
    if not isinstance(page_count, dict) or set(page_count) - {"min", "max"}:
        raise DocxSkillError(
            "acceptance.page_count may contain only min and max",
            code="invalid-acceptance-manifest",
        )
    for name, value in page_count.items():
        if not isinstance(value, int) or isinstance(value, bool) or value < 1:
            raise DocxSkillError(
                f"acceptance.page_count.{name} must be a positive integer",
                code="invalid-acceptance-manifest",
            )
    if page_count.get("min") and page_count.get("max"):
        if page_count["min"] > page_count["max"]:
            raise DocxSkillError(
                "acceptance.page_count.min cannot exceed max",
                code="invalid-acceptance-manifest",
            )
    toc = acceptance.get("toc", {})
    if not isinstance(toc, dict) or set(toc) - {"required", "populated"}:
        raise DocxSkillError(
            "acceptance.toc may contain only required and populated",
            code="invalid-acceptance-manifest",
        )
    if any(not isinstance(value, bool) for value in toc.values()):
        raise DocxSkillError(
            "acceptance.toc values must be boolean",
            code="invalid-acceptance-manifest",
        )
    protected_sources = acceptance.get("protected_sources", [])
    if not isinstance(protected_sources, list):
        raise DocxSkillError(
            "acceptance.protected_sources must be an array",
            code="invalid-acceptance-manifest",
        )
    normalized_sources: list[dict[str, str]] = []
    for item in protected_sources:
        if (
            not isinstance(item, dict)
            or set(item) != {"path", "sha256"}
            or not isinstance(item["path"], str)
            or not isinstance(item["sha256"], str)
            or not re.fullmatch(r"[0-9a-fA-F]{64}", item["sha256"])
        ):
            raise DocxSkillError(
                "Each protected source must contain path and a 64-character sha256",
                code="invalid-acceptance-manifest",
            )
        normalized_sources.append(
            {
                "path": str(Path(item["path"]).expanduser().resolve()),
                "sha256": item["sha256"].lower(),
            }
        )
    return {
        "required_text": required_text,
        "required_headings": normalized_headings,
        "page_count": page_count,
        "toc": toc,
        "protected_sources": normalized_sources,
    }


def _visual_review_result(
    path: str | Path | None,
    *,
    rendered_pages: int,
    rendered_images: list[str],
    artifact_sha256: str,
    legacy_status: str,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    review_path, review = _load_json_object(path, label="Visual review")
    issues: list[dict[str, Any]] = []
    if not review:
        if legacy_status == "passed":
            issues.append(
                {
                    "severity": "error",
                    "code": "visual-review-evidence-missing",
                    "message": (
                        "A bare passed status is insufficient; provide a visual review "
                        "report covering every current rendered page."
                    ),
                }
            )
        elif legacy_status == "failed":
            issues.append(
                {
                    "severity": "error",
                    "code": "visual-review-failed",
                    "message": "One or more rendered pages failed visual inspection.",
                }
            )
        return (
            {
                "status": "failed" if legacy_status == "failed" else "not-reviewed",
                "required": True,
                "report": None,
                "pages_reviewed": [],
            },
            issues,
        )
    if set(review) - {"artifact_sha256", "status", "pages"}:
        raise DocxSkillError(
            "Visual review may contain only artifact_sha256, status, and pages",
            code="invalid-visual-review",
        )
    reviewed_sha256 = review.get("artifact_sha256")
    if (
        not isinstance(reviewed_sha256, str)
        or not re.fullmatch(r"[0-9a-fA-F]{64}", reviewed_sha256)
    ):
        raise DocxSkillError(
            "visual review artifact_sha256 must be a 64-character SHA-256 digest",
            code="invalid-visual-review",
        )
    if reviewed_sha256.lower() != artifact_sha256:
        issues.append(
            {
                "severity": "error",
                "code": "visual-review-artifact-mismatch",
                "message": "The visual review belongs to a different DOCX candidate.",
                "expected_sha256": artifact_sha256,
                "reviewed_sha256": reviewed_sha256.lower(),
            }
        )
    if review.get("status") not in {"passed", "failed"}:
        raise DocxSkillError(
            "visual review status must be passed or failed",
            code="invalid-visual-review",
        )
    pages = review.get("pages")
    if not isinstance(pages, list):
        raise DocxSkillError(
            "visual review pages must be an array",
            code="invalid-visual-review",
        )
    seen: set[int] = set()
    failed_pages: list[int] = []
    notes: list[str] = []
    expected_image_hashes = {
        index: _page_image_sha256(image)
        for index, image in enumerate(rendered_images, start=1)
    }
    for item in pages:
        if (
            not isinstance(item, dict)
            or set(item) - {"page", "status", "notes", "image_sha256"}
            or not isinstance(item.get("page"), int)
            or isinstance(item.get("page"), bool)
            or item["page"] < 1
            or item.get("status") not in {"passed", "failed"}
            or not isinstance(item.get("notes"), str)
            or not item["notes"].strip()
            or not isinstance(item.get("image_sha256"), str)
            or not re.fullmatch(r"[0-9a-fA-F]{64}", item["image_sha256"])
        ):
            raise DocxSkillError(
                "Each visual review page requires page, image_sha256, "
                "passed/failed status, and non-empty notes",
                code="invalid-visual-review",
            )
        if item["page"] in seen:
            raise DocxSkillError(
                f"Visual review page {item['page']} is duplicated",
                code="invalid-visual-review",
            )
        seen.add(item["page"])
        notes.append(re.sub(r"\s+", " ", item["notes"].strip()).casefold())
        expected_image_hash = expected_image_hashes.get(item["page"])
        if expected_image_hash != item["image_sha256"].lower():
            issues.append(
                {
                    "severity": "error",
                    "code": "visual-review-page-image-mismatch",
                    "message": (
                        "A page review belongs to a stale or different rendered image."
                    ),
                    "page": item["page"],
                    "expected_sha256": expected_image_hash,
                    "reviewed_sha256": item["image_sha256"].lower(),
                }
            )
        if item["status"] == "failed":
            failed_pages.append(item["page"])
    expected = set(range(1, rendered_pages + 1))
    if seen != expected:
        issues.append(
            {
                "severity": "error",
                "code": "visual-review-page-coverage",
                "message": "Visual review must cover every current rendered page exactly once.",
                "missing_pages": sorted(expected - seen),
                "unexpected_pages": sorted(seen - expected),
            }
        )
    if review["status"] == "failed" or failed_pages:
        issues.append(
            {
                "severity": "error",
                "code": "visual-review-failed",
                "message": "One or more rendered pages failed visual inspection.",
                "failed_pages": failed_pages,
            }
        )
    if rendered_pages > 1 and len(set(notes)) == 1:
        issues.append(
            {
                "severity": "error",
                "code": "visual-review-generic-duplication",
                "message": (
                    "Every page has the same visual-review note. Record a "
                    "page-specific observation for each rendered page."
                ),
            }
        )
    status = "passed" if not issues and review["status"] == "passed" else "failed"
    return (
        {
            "status": status,
            "required": status != "passed",
            "report": str(review_path),
            "artifact_sha256": reviewed_sha256.lower(),
            "pages_reviewed": sorted(seen),
        },
        issues,
    )


def preflight_docx(
    input_path: str | Path,
    output_dir: str | Path,
    *,
    report_path: str | Path | None = None,
    profile: str = "final",
    dispositions_path: str | Path | None = None,
    dispositions: dict[str, str] | None = None,
    acceptance_path: str | Path | None = None,
    visual_review_path: str | Path | None = None,
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

    acceptance_file, acceptance_raw = _load_json_object(
        acceptance_path,
        label="Acceptance manifest",
    )
    acceptance = _acceptance_requirements(acceptance_raw)
    manifest_min = acceptance["page_count"].get("min")
    manifest_max = acceptance["page_count"].get("max")
    min_pages = manifest_min if manifest_min is not None else min_pages
    max_pages = manifest_max if manifest_max is not None else max_pages
    if min_pages and max_pages and min_pages > max_pages:
        raise DocxSkillError(
            "Combined acceptance and CLI page constraints are inconsistent",
            code="invalid-preflight",
        )
    required_text = list(
        dict.fromkeys([*(required_text or []), *acceptance["required_text"]])
    )
    validation = assert_valid_docx(input_path)
    artifact_sha256 = file_sha256(input_path)
    inspection = inspect_docx(input_path)
    audit = audit_docx(input_path, profile=profile)
    warning_dispositions = load_dispositions(dispositions_path)
    for code, rationale in (dispositions or {}).items():
        if not isinstance(rationale, str) or not rationale.strip():
            raise DocxSkillError(
                f"Disposition for {code} must be a non-empty string",
                code="invalid-warning-disposition",
            )
        warning_dispositions[str(code)] = rationale.strip()

    audit_issues: list[dict[str, Any]] = []
    unknown_dispositions = set(warning_dispositions)
    for issue in audit["issues"]:
        item = dict(issue)
        code = str(item.get("code", ""))
        if code in warning_dispositions and item.get("severity") != "error":
            item["disposition"] = warning_dispositions[code]
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
    render_result["page_evidence"] = [
        {
            "page": page,
            "path": str(image),
            "image_sha256": _page_image_sha256(image),
        }
        for page, image in enumerate(render_result.get("images", []), start=1)
    ]
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
    visual_review, visual_issues = _visual_review_result(
        visual_review_path,
        rendered_pages=pages,
        rendered_images=list(render_result.get("images", [])),
        artifact_sha256=artifact_sha256,
        legacy_status=visual_review_status,
    )
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
    available_headings = [
        {
            "text": _normalize_text(str(item.get("text", ""))),
            "level": int(
                re.search(
                    r"(\d+)$",
                    str(item.get("style", "")),
                ).group(1)
            )
            if re.search(r"(\d+)$", str(item.get("style", "")))
            else None,
        }
        for item in inspection.get("headings", [])
    ]
    missing_headings: list[dict[str, Any]] = []
    for required_heading in acceptance["required_headings"]:
        normalized_heading = _normalize_text(required_heading["text"])
        if not any(
            item["text"] == normalized_heading
            and (
                required_heading["level"] is None
                or item["level"] == required_heading["level"]
            )
            for item in available_headings
        ):
            missing_headings.append(required_heading)
    if missing_headings:
        gate_issues.append(
            {
                "severity": "error",
                "code": "required-heading-missing",
                "message": "One or more required semantic headings are missing.",
                "missing": missing_headings,
            }
        )
    toc = toc_status(input_path)
    toc_requirement = acceptance["toc"]
    if toc_requirement.get("required") and not toc["present"]:
        gate_issues.append(
            {
                "severity": "error",
                "code": "toc-missing",
                "message": "The acceptance manifest requires a table of contents.",
            }
        )
    if toc_requirement.get("populated") and not toc["populated"]:
        gate_issues.append(
            {
                "severity": "error",
                "code": "toc-not-populated",
                "message": (
                    "The table of contents has no visible cached entries and page numbers; "
                    "run refresh-toc before preflight."
                ),
                "toc": toc,
            }
        )
    protected_source_checks: list[dict[str, Any]] = []
    for source in acceptance["protected_sources"]:
        path = Path(source["path"])
        actual = file_sha256(path) if path.is_file() else None
        unchanged = actual == source["sha256"]
        protected_source_checks.append(
            {
                "path": str(path),
                "expected_sha256": source["sha256"],
                "actual_sha256": actual,
                "unchanged": unchanged,
            }
        )
        if not unchanged:
            gate_issues.append(
                {
                    "severity": "error",
                    "code": "protected-source-changed",
                    "message": "A protected source file is missing or changed.",
                    "path": str(path),
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
    for metrics in render_result.get("layout_metrics", []):
        page_number = int(metrics.get("page", 0))
        if metrics.get("blank_body"):
            gate_issues.append(
                {
                    "severity": "error",
                    "code": "blank-body-page",
                    "message": (
                        "A rendered page has no meaningful ink in its body area; "
                        "remove the unintended blank page or repair pagination."
                    ),
                    "page": page_number,
                    "metrics": metrics,
                }
            )
        elif (
            page_number > 1
            and metrics.get("sparse_body")
            and int(metrics.get("text_characters", 0)) < 220
        ):
            gate_issues.append(
                {
                    "severity": "warning",
                    "code": "sparse-page-layout",
                    "message": (
                        "A rendered page contains unusually little body content. "
                        "Check for orphaned table rows, accidental page breaks, "
                        "or a stranded heading."
                    ),
                    "page": page_number,
                    "metrics": metrics,
                }
            )
    gate_issues.extend(visual_issues)
    for item in gate_issues:
        code = str(item.get("code", ""))
        if code in warning_dispositions and item.get("severity") != "error":
            item["disposition"] = warning_dispositions[code]
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
    coverage_error_codes = {
        "page-count-above-maximum",
        "page-count-below-minimum",
        "protected-source-changed",
        "rendered-text-coverage",
        "rendered-text-empty",
        "required-heading-missing",
        "toc-missing",
        "toc-not-populated",
        "blank-body-page",
    }
    coverage_passed = not any(
        item.get("code") in coverage_error_codes for item in unresolved_errors
    )
    automated_passed = not unresolved_errors and not unresolved_warnings
    passed = automated_passed and visual_review["status"] == "passed"
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
            "visual_review": visual_review["status"],
            "layout": (
                "passed"
                if not any(
                    item.get("code") in {"blank-body-page", "sparse-page-layout"}
                    for item in unresolved_gate
                )
                else "needs-attention"
            ),
        },
        "coverage": {
            "status": "passed" if coverage_passed else "failed",
            "required_text": coverage_checks,
            "required_headings": {
                "required": acceptance["required_headings"],
                "missing": missing_headings,
            },
            "protected_sources": protected_source_checks,
            "inspection": inspection.get("inspection_coverage"),
        },
        "visual_review": visual_review,
        "toc": toc,
        "acceptance": {
            "manifest": str(acceptance_file) if acceptance_file else None,
            "sha256": file_sha256(acceptance_file) if acceptance_file else None,
            "requirements": acceptance,
        },
        "artifact": {
            "sha256": artifact_sha256,
            "bytes": Path(input_path).expanduser().resolve().stat().st_size,
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
