from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import warnings
import zipfile
from xml.etree import ElementTree as ET
from pathlib import Path
from typing import Any, Callable

from .audit import audit_docx
from .common import (
    DocxSkillError,
    assert_valid_docx,
    pack_docx,
    unpacked_copy,
)
from .core import (
    compare_docx,
    create_docx,
    edit_docx,
    filter_inspection,
    inspect_docx,
    sanitize_docx,
)
from .fallback import _fallback_environment, fallback_create, fallback_patch
from .preflight import preflight_docx
from .protocol import capabilities, schema_for
from .render import find_soffice
from .review import finalize_docx, review_docx


def _dump(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def _expect_error(
    function: Callable[..., Any],
    expected_status: str,
    expected_code: str,
    *args: Any,
    **kwargs: Any,
) -> None:
    try:
        function(*args, **kwargs)
    except DocxSkillError as exc:
        assert exc.status == expected_status, (exc.status, str(exc))
        assert exc.code == expected_code, (exc.code, str(exc))
        return
    raise AssertionError(f"Expected {expected_status}/{expected_code}")


def run_smoke_test() -> dict[str, Any]:
    steps: list[str] = []
    negative_checks: list[str] = []
    smoke_parent_value = os.environ.get("PILOTDECK_WORK_DIR", "").strip()
    smoke_parent = (
        Path(smoke_parent_value).expanduser().resolve()
        if smoke_parent_value
        else None
    )
    if smoke_parent:
        smoke_parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="pilotdeck_docx_smoke_",
        dir=str(smoke_parent) if smoke_parent else None,
    ) as temp_dir:
        root = Path(temp_dir)

        capability_result = capabilities()
        assert capability_result["protocol_version"] == 1
        assert len(capability_result["capability_states"]) == len(
            set(capability_result["capability_states"])
        )
        assert capability_result["output_policy"][
            "atomic_validation_before_replace"
        ]
        os.environ["PILOTDECK_DOCX_TEST_SECRET"] = "must-not-leak"
        try:
            fallback_environment = _fallback_environment("test")
        finally:
            os.environ.pop("PILOTDECK_DOCX_TEST_SECRET", None)
        assert "PILOTDECK_DOCX_TEST_SECRET" not in fallback_environment
        assert fallback_environment["DOCX_FALLBACK_MODE"] == "test"
        create_schema = schema_for("create")["schema"]
        edit_schema = schema_for("edit")["schema"]
        review_schema = schema_for("review")["schema"]
        assert create_schema["additionalProperties"] is False
        assert (
            create_schema["$defs"]["block_image"]["properties"]["path"]["type"]
            == "string"
        )
        assert (
            edit_schema["properties"]["operations"]["items"]["oneOf"][0][
                "additionalProperties"
            ]
            is False
        )
        assert review_schema["properties"]["comments"]["items"]["additionalProperties"] is False
        steps.append("capability-contract")

        invalid_spec = root / "invalid-create.json"
        _dump(invalid_spec, {"content": [], "unsupported_magic": True})
        _expect_error(
            create_docx,
            "error",
            "unknown-spec-fields",
            invalid_spec,
            root / "invalid.docx",
        )
        negative_checks.append("unknown-create-field")

        create_spec = root / "create.json"
        _dump(
            create_spec,
            {
                "preset": "business-report",
                "locale": "zh-CN",
                "fonts": {"latin": "Arial"},
                "metadata": {
                    "title": "2026 项目复盘报告",
                    "author": "PilotDeck Test",
                },
                "header": {"text": "内部资料", "alignment": "right"},
                "footer": {"text": "第 {PAGE} 页 / 共 {NUMPAGES} 页", "alignment": "center"},
                "content": [
                    {"type": "title", "text": "2026 项目复盘报告"},
                    {"type": "subtitle", "text": "能力声明—执行—降级—验收"},
                    {
                        "type": "toc",
                        "title": "目录",
                        "levels": [1, 2],
                        "page_break_after": True,
                    },
                    {"type": "heading", "level": 1, "text": "项目概览"},
                    {
                        "type": "paragraph",
                        "text": "计划于五月发布，目标增长 20%。",
                    },
                    {
                        "type": "paragraph",
                        "runs": [
                            {"text": "跨", "bold": True},
                            {"text": "运行修订", "italic": True},
                        ],
                    },
                    {"type": "bullet", "text": "完成需求分析"},
                    {
                        "type": "callout",
                        "label": "决策",
                        "text": "最终就绪评审通过后继续。",
                    },
                    {
                        "type": "checklist",
                        "items": ["确认负责人", "确认发布日期"],
                    },
                    {
                        "type": "table",
                        "headers": ["工作流", "状态"],
                        "rows": [["需求", "完成"], ["开发", "进行中"]],
                        "column_widths": [3, 1],
                        "alignments": ["left", "center"],
                    },
                ],
            },
        )
        created = root / "created.docx"
        creation = create_docx(create_spec, created)
        assert creation["fonts"]["east_asia"]
        _expect_error(
            create_docx,
            "blocked",
            "output-exists",
            create_spec,
            created,
        )
        create_docx(create_spec, created, overwrite=True)
        negative_checks.append("output-overwrite-guard")
        _expect_error(
            inspect_docx,
            "error",
            "invalid-json-artifact-path",
            created,
            root / "inspection.txt",
        )
        control_collision = root / "control-collision.docx"
        control_collision.write_text(
            create_spec.read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        control_before = control_collision.read_bytes()
        _expect_error(
            create_docx,
            "blocked",
            "artifact-path-collision",
            control_collision,
            control_collision,
            overwrite=True,
        )
        assert control_collision.read_bytes() == control_before
        negative_checks.append("artifact-path-separation")
        steps.append("create-cjk-fields")

        partial_inspection_docx = root / "partial-inspection.docx"
        with unpacked_copy(created) as (_, package):
            document_xml = package / "word" / "document.xml"
            tree = ET.parse(document_xml)
            namespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            body = tree.getroot().find(f"{{{namespace}}}body")
            assert body is not None
            first_paragraph = body.find(f"{{{namespace}}}p")
            assert first_paragraph is not None
            body.remove(first_paragraph)
            content_control = ET.Element(f"{{{namespace}}}sdt")
            content = ET.SubElement(content_control, f"{{{namespace}}}sdtContent")
            content.append(first_paragraph)
            body.insert(0, content_control)
            tree.write(document_xml, encoding="utf-8", xml_declaration=True)
            pack_docx(package, partial_inspection_docx)
        partial_inspection = inspect_docx(partial_inspection_docx)
        assert partial_inspection["status"] == "partial"
        assert partial_inspection["inspection_coverage"]["status"] == "partial"
        assert partial_inspection["package_features"]["content_controls"] == 1
        negative_checks.append("partial-inspection-is-not-success")
        partial_comparison = compare_docx(
            created,
            partial_inspection_docx,
            root / "partial-comparison.json",
        )
        assert partial_comparison["status"] == "partial"
        assert (
            partial_comparison["inspection_coverage"]["after"]["status"]
            == "partial"
        )
        negative_checks.append("partial-comparison-is-not-success")

        signed_docx = root / "signed.docx"
        with unpacked_copy(created) as (_, package):
            signature_dir = package / "_xmlsignatures"
            signature_dir.mkdir()
            (signature_dir / "sig1.xml").write_text(
                "<Signature xmlns='http://www.w3.org/2000/09/xmldsig#'/>",
                encoding="utf-8",
            )
            pack_docx(package, signed_docx)
        signed_inspection = inspect_docx(signed_docx)
        assert signed_inspection["status"] == "partial"
        assert signed_inspection["package_features"]["digital_signatures"]
        signed_edit_patch = root / "signed-edit.json"
        _dump(
            signed_edit_patch,
            {
                "operations": [
                    {"action": "append_paragraph", "text": "不得修改已签名文档"}
                ]
            },
        )
        _expect_error(
            edit_docx,
            "blocked",
            "digital-signature-blocked",
            signed_docx,
            signed_edit_patch,
            root / "signed-edit-output.docx",
            allow_lossy=True,
        )
        signed_review_spec = root / "signed-review.json"
        _dump(
            signed_review_spec,
            {
                "comments": [
                    {
                        "match": "2026 项目复盘报告",
                        "text": "不得修改已签名文档",
                    }
                ]
            },
        )
        _expect_error(
            review_docx,
            "blocked",
            "digital-signature-blocked",
            signed_docx,
            signed_review_spec,
            root / "signed-review-output.docx",
        )
        _expect_error(
            finalize_docx,
            "blocked",
            "digital-signature-blocked",
            signed_docx,
            root / "signed-finalize-output.docx",
            remove_comments=True,
        )
        _expect_error(
            sanitize_docx,
            "blocked",
            "digital-signature-blocked",
            signed_docx,
            root / "signed-sanitize-output.docx",
        )
        negative_checks.append("signed-document-mutations-blocked")

        protected_docx = root / "protected.docx"
        with unpacked_copy(created) as (_, package):
            settings_xml = package / "word" / "settings.xml"
            tree = ET.parse(settings_xml)
            namespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            protection = ET.Element(f"{{{namespace}}}documentProtection")
            protection.set(f"{{{namespace}}}edit", "readOnly")
            protection.set(f"{{{namespace}}}enforcement", "1")
            tree.getroot().append(protection)
            tree.write(settings_xml, encoding="utf-8", xml_declaration=True)
            pack_docx(package, protected_docx)
        protected_inspection = inspect_docx(protected_docx)
        assert protected_inspection["status"] == "partial"
        assert protected_inspection["package_features"]["document_protection"]
        _expect_error(
            edit_docx,
            "blocked",
            "document-protection-blocked",
            protected_docx,
            signed_edit_patch,
            root / "protected-edit-output.docx",
            allow_lossy=True,
        )
        _expect_error(
            review_docx,
            "blocked",
            "document-protection-blocked",
            protected_docx,
            signed_review_spec,
            root / "protected-review-output.docx",
        )
        _expect_error(
            finalize_docx,
            "blocked",
            "document-protection-blocked",
            protected_docx,
            root / "protected-finalize-output.docx",
            remove_comments=True,
        )
        _expect_error(
            sanitize_docx,
            "blocked",
            "document-protection-blocked",
            protected_docx,
            root / "protected-sanitize-output.docx",
        )
        negative_checks.append("protected-document-mutations-blocked")

        disabled_protection_docx = root / "disabled-protection.docx"
        with unpacked_copy(created) as (_, package):
            settings_xml = package / "word" / "settings.xml"
            tree = ET.parse(settings_xml)
            namespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            protection = ET.Element(f"{{{namespace}}}documentProtection")
            protection.set(f"{{{namespace}}}edit", "readOnly")
            protection.set(f"{{{namespace}}}enforcement", "0")
            tree.getroot().append(protection)
            tree.write(settings_xml, encoding="utf-8", xml_declaration=True)
            pack_docx(package, disabled_protection_docx)
        disabled_protection_inspection = inspect_docx(disabled_protection_docx)
        assert disabled_protection_inspection["package_features"][
            "document_protection_settings"
        ]
        assert not disabled_protection_inspection["package_features"][
            "document_protection"
        ]
        disabled_protection_output = root / "disabled-protection-edit.docx"
        disabled_protection_edit = edit_docx(
            disabled_protection_docx,
            signed_edit_patch,
            disabled_protection_output,
        )
        assert disabled_protection_edit["status"] == "ok"
        steps.append("protection-state-semantics")

        active_content_docx = root / "active-content.docx"
        with unpacked_copy(created) as (_, package):
            active_dir = package / "word" / "activeX"
            active_dir.mkdir()
            (active_dir / "activeX1.bin").write_bytes(b"untrusted-control")
            pack_docx(package, active_content_docx)
        active_inspection = inspect_docx(active_content_docx)
        assert active_inspection["status"] == "partial"
        assert active_inspection["package_features"]["active_content"]
        _expect_error(
            edit_docx,
            "blocked",
            "active-content-blocked",
            active_content_docx,
            signed_edit_patch,
            root / "active-content-edit-output.docx",
            allow_lossy=True,
        )
        negative_checks.append("active-content-mutation-blocked")

        duplicate_package = root / "duplicate-package.docx"
        with zipfile.ZipFile(created) as source_archive:
            document_xml = source_archive.read("word/document.xml")
            with zipfile.ZipFile(
                duplicate_package, "w", compression=zipfile.ZIP_DEFLATED
            ) as destination_archive:
                for member in source_archive.infolist():
                    destination_archive.writestr(
                        member, source_archive.read(member.filename)
                    )
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", UserWarning)
                    destination_archive.writestr(
                        "word/document.xml", document_xml
                    )
        _expect_error(
            assert_valid_docx,
            "error",
            "operation-failed",
            duplicate_package,
        )
        negative_checks.append("duplicate-package-parts")

        unknown_edit = root / "unknown-edit.json"
        _dump(
            unknown_edit,
            {
                "operations": [
                    {
                        "action": "append_paragraph",
                        "text": "不会执行",
                        "unsupported_magic": True,
                    }
                ]
            },
        )
        _expect_error(
            edit_docx,
            "error",
            "unknown-spec-fields",
            created,
            unknown_edit,
            root / "unknown-edit.docx",
        )
        negative_checks.append("unknown-edit-field")

        unknown_review = root / "unknown-review.json"
        _dump(
            unknown_review,
            {
                "comments": [
                    {
                        "match": "项目",
                        "text": "不会执行",
                        "replacement": "schema 不允许",
                    }
                ]
            },
        )
        _expect_error(
            review_docx,
            "error",
            "unknown-spec-fields",
            created,
            unknown_review,
            root / "unknown-review.docx",
        )
        negative_checks.append("unknown-review-field")

        reentrant_spec = root / "reentrant-create.json"
        _dump(
            reentrant_spec,
            {
                "preset": "simple-document",
                "content": [{"type": "paragraph", "text": "aba aba"}],
            },
        )
        reentrant_source = root / "reentrant-source.docx"
        create_docx(reentrant_spec, reentrant_source)
        reentrant_patch = root / "reentrant-patch.json"
        _dump(
            reentrant_patch,
            {
                "operations": [
                    {
                        "action": "replace_text",
                        "match": "aba",
                        "replacement": "aba+",
                        "occurrence": "all",
                    }
                ]
            },
        )
        reentrant_output = root / "reentrant-output.docx"
        reentrant_result = edit_docx(
            reentrant_source, reentrant_patch, reentrant_output
        )
        assert reentrant_result["operations"][0]["affected"] == 2
        assert any(
            item["text"] == "aba+ aba+"
            for item in inspect_docx(reentrant_output)["paragraphs"]
        )
        negative_checks.append("replace-all-does-not-rematch-output")

        ambiguous_repeated_patch = root / "ambiguous-repeated-patch.json"
        _dump(
            ambiguous_repeated_patch,
            {
                "operations": [
                    {
                        "action": "replace_text",
                        "match": "aba",
                        "replacement": "changed",
                    }
                ]
            },
        )
        _expect_error(
            edit_docx,
            "partial",
            "ambiguous-edit-target",
            reentrant_source,
            ambiguous_repeated_patch,
            root / "ambiguous-repeated-output.docx",
        )
        assert not (root / "ambiguous-repeated-output.docx").exists()
        negative_checks.append("replace-text-detects-repeated-occurrences")

        second_replacement_patch = root / "second-replacement-patch.json"
        _dump(
            second_replacement_patch,
            {
                "operations": [
                    {
                        "action": "replace_text",
                        "match": "aba",
                        "replacement": "changed",
                        "occurrence": 2,
                    }
                ]
            },
        )
        second_replacement_output = root / "second-replacement-output.docx"
        second_replacement = edit_docx(
            reentrant_source,
            second_replacement_patch,
            second_replacement_output,
        )
        assert second_replacement["operations"][0]["affected"] == 1
        assert any(
            item["text"] == "aba changed"
            for item in inspect_docx(second_replacement_output)["paragraphs"]
        )
        negative_checks.append("replace-text-counts-text-occurrences")

        repeated_review_spec = root / "repeated-review.json"
        _dump(
            repeated_review_spec,
            {
                "tracked_replacements": [
                    {
                        "match": "aba",
                        "replacement": "changed",
                        "occurrence": 2,
                    }
                ]
            },
        )
        repeated_review = root / "repeated-review.docx"
        review_docx(
            reentrant_source, repeated_review_spec, repeated_review
        )
        repeated_final = root / "repeated-final.docx"
        finalize_docx(repeated_review, repeated_final, accept_changes=True)
        assert any(
            item["text"] == "aba changed"
            for item in inspect_docx(repeated_final)["paragraphs"]
        )
        negative_checks.append("tracked-replacement-counts-run-occurrences")

        inspected = inspect_docx(created, root / "created-inspect.json")
        assert inspected["table_count"] == 1
        assert any("项目概览" in item["text"] for item in inspected["headings"])
        instructions = " ".join(item["instruction"] for item in inspected["fields"])
        assert "TOC" in instructions and "PAGE" in instructions and "NUMPAGES" in instructions
        filtered = filter_inspection(inspected, search="目标增长", max_items=5)
        assert filtered["query"]["total_matches"] == 1
        steps.append("inspect-fields-and-filters")

        audit = audit_docx(created, root / "created-audit.json", profile="accessible")
        assert not any(item["code"] == "table-width-not-explicit" for item in audit["issues"])
        steps.append("audit")

        patch = root / "patch.json"
        _dump(
            patch,
            {
                "operations": [
                    {
                        "action": "replace_text",
                        "match": "2026 项目",
                        "replacement": "2027 项目",
                        "occurrence": "all",
                    },
                    {"action": "set_table_cell", "table": 1, "row": 3, "column": 2, "text": "已完成"},
                    {"action": "append_table_row", "table": 1, "values": ["验收", "待确认"]},
                    {"action": "set_header", "text": "受控文件", "alignment": "right"},
                    {"action": "append_paragraph", "text": "附加说明。"},
                ]
            },
        )
        edited = root / "edited.docx"
        edit_result = edit_docx(created, patch, edited)
        assert sum(item["affected"] for item in edit_result["operations"]) >= 5
        edited_info = inspect_docx(edited)
        assert edited_info["tables"][0]["cells"][2][1] == "已完成"
        assert edited_info["tables"][0]["cells"][-1] == ["验收", "待确认"]
        edited_fields = " ".join(item["instruction"] for item in edited_info["fields"])
        assert "TOC" in edited_fields and "NUMPAGES" in edited_fields
        steps.append("edit-structured-targets")

        missing_patch = root / "missing-patch.json"
        _dump(
            missing_patch,
            {"operations": [{"action": "replace_text", "match": "不存在", "replacement": "x"}]},
        )
        _expect_error(
            edit_docx,
            "partial",
            "edit-target-not-found",
            edited,
            missing_patch,
            root / "missing.docx",
        )
        negative_checks.append("zero-match-edit")

        cross_run_review = root / "cross-run-review.json"
        _dump(
            cross_run_review,
            {
                "tracked_replacements": [
                    {"match": "跨运行", "replacement": "跨段运行", "author": "PilotDeck"}
                ]
            },
        )
        _expect_error(
            review_docx,
            "unsupported",
            "cross-run-redline",
            edited,
            cross_run_review,
            root / "cross-run.docx",
        )
        negative_checks.append("cross-run-redline")

        review_spec = root / "review.json"
        _dump(
            review_spec,
            {
                "comments": [
                    {
                        "match": "目标增长 20%",
                        "text": "请补充数据来源。",
                        "author": "PilotDeck",
                    }
                ],
                "tracked_replacements": [
                    {
                        "match": "五月发布",
                        "replacement": "六月发布",
                        "author": "PilotDeck",
                    }
                ],
            },
        )
        reviewed = root / "reviewed.docx"
        review_docx(edited, review_spec, reviewed)
        reviewed_info = inspect_docx(reviewed)
        assert reviewed_info["status"] == "partial"
        assert reviewed_info["inspection_coverage"]["status"] == "partial"
        assert len(reviewed_info["comments"]) == 1
        assert reviewed_info["tracked_changes"]["insertions"] == 1
        assert reviewed_info["tracked_changes"]["deletions"] == 1
        reviewed_audit = audit_docx(reviewed, profile="final")
        assert reviewed_audit["status"] == "partial"
        assert not reviewed_audit["passed"]
        assert any(
            item["code"] == "tracked-changes-remain"
            for item in reviewed_audit["issues"]
        )
        negative_checks.append("failed-audit-is-not-success")
        steps.append("review")

        final = root / "final.docx"
        finalize_docx(reviewed, final, accept_changes=True, remove_comments=True)
        final_info = inspect_docx(final)
        assert not final_info["comments"]
        assert not any(
            final_info["tracked_changes"][key]
            for key in ("insertions", "deletions", "moves_from", "moves_to", "property_changes")
        )
        assert any("六月发布" in item["text"] for item in final_info["paragraphs"])
        steps.append("finalize")

        _expect_error(
            finalize_docx,
            "error",
            "finalize-action-required",
            reviewed,
            root / "finalize-no-action.docx",
        )
        assert not (root / "finalize-no-action.docx").exists()
        negative_checks.append("finalize-action-required")

        patch_script = root / "patch_package.py"
        patch_script.write_text(
            """\
import argparse
from pathlib import Path
from xml.etree import ElementTree as ET
p = argparse.ArgumentParser()
p.add_argument("--package-dir", required=True)
a = p.parse_args()
path = Path(a.package_dir) / "word" / "document.xml"
tree = ET.parse(path)
changed = False
for node in tree.getroot().iter():
    if node.text and "附加说明" in node.text:
        node.text = node.text.replace("附加说明", "受控降级说明")
        changed = True
if not changed:
    raise SystemExit(2)
tree.write(path, encoding="utf-8", xml_declaration=True)
""",
            encoding="utf-8",
        )
        fallback_output = root / "fallback.docx"
        fallback_manifest = root / "fallback-manifest.json"
        _expect_error(
            fallback_patch,
            "blocked",
            "digital-signature-blocked",
            signed_docx,
            patch_script,
            root / "signed-fallback-output.docx",
            root / "signed-fallback-manifest.json",
            allow_parts=["word/document.xml"],
            reason="Signed packages must remain immutable.",
        )
        _expect_error(
            fallback_patch,
            "blocked",
            "fallback-allowlist-required",
            final,
            patch_script,
            root / "no-allowlist.docx",
            root / "no-allowlist-manifest.json",
            reason="Negative explicit allowlist test.",
        )
        negative_checks.append("fallback-explicit-allowlist")
        fallback_patch(
            final,
            patch_script,
            fallback_output,
            fallback_manifest,
            allow_parts=["word/document.xml"],
            reason="Bundled edit does not expose this run-level preservation test.",
        )
        assert "word/document.xml" in json.loads(
            fallback_manifest.read_text(encoding="utf-8")
        )["changed_parts"]
        assert any(
            "受控降级说明" in item["text"]
            for item in inspect_docx(fallback_output)["paragraphs"]
        )
        cli_output = root / "fallback-cli.docx"
        cli_manifest = root / "fallback-cli-manifest.json"
        cli = Path(__file__).resolve().parents[1] / "docx_cli.py"
        cli_process = subprocess.run(
            [
                sys.executable,
                str(cli),
                "fallback-patch",
                "--input",
                str(final),
                "--script",
                str(patch_script),
                "--out",
                str(cli_output),
                "--manifest",
                str(cli_manifest),
                "--allow-part",
                "word/document.xml",
                "--reason",
                "Exercise the public CLI fallback wiring.",
            ],
            capture_output=True,
            text=True,
            errors="replace",
            timeout=30,
            check=False,
        )
        assert cli_process.returncode == 0, (
            cli_process.stdout,
            cli_process.stderr,
        )
        cli_result = json.loads(cli_process.stdout)
        assert cli_result["status"] == "ok"
        assert cli_output.is_file()
        assert cli_manifest.is_file()
        steps.append("public-cli-dispatch")
        steps.append("controlled-ooxml-fallback")

        violating_script = root / "violating_patch.py"
        violating_script.write_text(
            """\
import argparse
from pathlib import Path
p = argparse.ArgumentParser()
p.add_argument("--package-dir", required=True)
a = p.parse_args()
(Path(a.package_dir) / "unexpected.bin").write_bytes(b"not allowed")
""",
            encoding="utf-8",
        )
        _expect_error(
            fallback_patch,
            "blocked",
            "fallback-scope-violation",
            final,
            violating_script,
            root / "violating.docx",
            root / "violating-manifest.json",
            allow_parts=["word/document.xml"],
            reason="Negative scope test.",
        )
        negative_checks.append("fallback-scope")

        active_patch_script = root / "active_patch.py"
        active_patch_script.write_text(
            """\
import argparse
from pathlib import Path
p = argparse.ArgumentParser()
p.add_argument("--package-dir", required=True)
a = p.parse_args()
active = Path(a.package_dir) / "word" / "activeX"
active.mkdir()
(active / "activeX1.bin").write_bytes(b"untrusted-control")
""",
            encoding="utf-8",
        )
        _expect_error(
            fallback_patch,
            "blocked",
            "fallback-scope-violation",
            final,
            active_patch_script,
            root / "active-patch-output.docx",
            root / "active-patch-manifest.json",
            allow_parts=["word/*"],
            reason="ActiveX additions must remain forbidden despite a broad allowlist.",
        )
        negative_checks.append("fallback-patch-active-content-blocked")

        corrupting_script = root / "corrupting_patch.py"
        corrupting_script.write_text(
            """\
import argparse
from pathlib import Path
p = argparse.ArgumentParser()
p.add_argument("--package-dir", required=True)
a = p.parse_args()
(Path(a.package_dir) / "word" / "document.xml").write_text("<broken", encoding="utf-8")
""",
            encoding="utf-8",
        )
        invalid_patch_manifest = root / "invalid-patch-manifest.json"
        _expect_error(
            fallback_patch,
            "error",
            "fallback-validation-failed",
            final,
            corrupting_script,
            root / "invalid-patch-output.docx",
            invalid_patch_manifest,
            allow_parts=["word/document.xml"],
            reason="Negative fallback validation test.",
        )
        assert invalid_patch_manifest.is_file()
        assert not (root / "invalid-patch-output.docx").exists()
        negative_checks.append("fallback-patch-validation")

        creator_script = root / "full_create.py"
        creator_script.write_text(
            """\
import argparse
from docx import Document
p = argparse.ArgumentParser()
p.add_argument("--out", required=True)
a = p.parse_args()
d = Document()
d.add_heading("受控完整创建", 0)
d.add_paragraph("只有标准 create 无法满足需求时才允许。")
d.save(a.out)
""",
            encoding="utf-8",
        )
        custom = root / "custom.docx"
        fallback_create(
            creator_script,
            custom,
            root / "custom-manifest.json",
            reason="Exercise the declared full-create fallback contract.",
        )
        assert inspect_docx(custom)["paragraph_count"] >= 2
        _expect_error(
            fallback_create,
            "blocked",
            "fallback-output-exists",
            creator_script,
            custom,
            root / "overwrite-manifest.json",
            reason="Negative overwrite test.",
        )
        negative_checks.append("fallback-create-no-overwrite")

        invalid_creator_script = root / "invalid_full_create.py"
        invalid_creator_script.write_text(
            """\
import argparse
from pathlib import Path
p = argparse.ArgumentParser()
p.add_argument("--out", required=True)
a = p.parse_args()
Path(a.out).write_bytes(b"not a docx")
""",
            encoding="utf-8",
        )
        invalid_create_manifest = root / "invalid-create-manifest.json"
        _expect_error(
            fallback_create,
            "error",
            "fallback-validation-failed",
            invalid_creator_script,
            root / "invalid-create-output.docx",
            invalid_create_manifest,
            reason="Negative full-create validation test.",
        )
        assert invalid_create_manifest.is_file()
        assert not (root / "invalid-create-output.docx").exists()
        negative_checks.append("fallback-create-validation")

        signed_creator_script = root / "signed_full_create.py"
        signed_creator_script.write_text(
            """\
import argparse
import zipfile
from docx import Document
p = argparse.ArgumentParser()
p.add_argument("--out", required=True)
a = p.parse_args()
d = Document()
d.add_paragraph("Unsigned content with an unverifiable signature marker.")
d.save(a.out)
with zipfile.ZipFile(a.out, "a", compression=zipfile.ZIP_DEFLATED) as archive:
    archive.writestr(
        "_xmlsignatures/sig1.xml",
        "<Signature xmlns='http://www.w3.org/2000/09/xmldsig#'/>",
    )
""",
            encoding="utf-8",
        )
        signed_create_manifest = root / "signed-create-manifest.json"
        _expect_error(
            fallback_create,
            "blocked",
            "fallback-signature-blocked",
            signed_creator_script,
            root / "signed-create-output.docx",
            signed_create_manifest,
            reason="Unverifiable signature output must be blocked.",
        )
        assert signed_create_manifest.is_file()
        assert not (root / "signed-create-output.docx").exists()
        negative_checks.append("fallback-create-signature-blocked")

        protected_creator_script = root / "protected_full_create.py"
        protected_creator_script.write_text(
            """\
import argparse
from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
p = argparse.ArgumentParser()
p.add_argument("--out", required=True)
a = p.parse_args()
d = Document()
d.add_paragraph("Protected fallback output.")
protection = OxmlElement("w:documentProtection")
protection.set(qn("w:edit"), "readOnly")
protection.set(qn("w:enforcement"), "1")
d.settings.element.append(protection)
d.save(a.out)
""",
            encoding="utf-8",
        )
        protected_create_manifest = root / "protected-create-manifest.json"
        _expect_error(
            fallback_create,
            "blocked",
            "fallback-protection-blocked",
            protected_creator_script,
            root / "protected-create-output.docx",
            protected_create_manifest,
            reason="Unverifiable protected output must be blocked.",
        )
        assert protected_create_manifest.is_file()
        assert not (root / "protected-create-output.docx").exists()
        negative_checks.append("fallback-create-protection-blocked")

        active_creator_script = root / "active_full_create.py"
        active_creator_script.write_text(
            """\
import argparse
import zipfile
from docx import Document
p = argparse.ArgumentParser()
p.add_argument("--out", required=True)
a = p.parse_args()
d = Document()
d.add_paragraph("Active content must not be accepted.")
d.save(a.out)
with zipfile.ZipFile(a.out, "a", compression=zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("word/activeX/activeX1.bin", b"untrusted-control")
""",
            encoding="utf-8",
        )
        active_create_manifest = root / "active-create-manifest.json"
        _expect_error(
            fallback_create,
            "blocked",
            "fallback-active-content-blocked",
            active_creator_script,
            root / "active-create-output.docx",
            active_create_manifest,
            reason="Active content output must be blocked.",
        )
        assert active_create_manifest.is_file()
        assert not (root / "active-create-output.docx").exists()
        negative_checks.append("fallback-create-active-content-blocked")

        macro_creator_script = root / "macro_full_create.py"
        macro_creator_script.write_text(
            """\
import argparse
import zipfile
from docx import Document
p = argparse.ArgumentParser()
p.add_argument("--out", required=True)
a = p.parse_args()
d = Document()
d.add_paragraph("Macro content must not be accepted.")
d.save(a.out)
with zipfile.ZipFile(a.out, "a", compression=zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("word/vbaProject.bin", b"untrusted-macro")
""",
            encoding="utf-8",
        )
        macro_create_manifest = root / "macro-create-manifest.json"
        _expect_error(
            fallback_create,
            "blocked",
            "fallback-active-content-blocked",
            macro_creator_script,
            root / "macro-create-output.docx",
            macro_create_manifest,
            reason="Macro output must be blocked.",
        )
        assert macro_create_manifest.is_file()
        assert not (root / "macro-create-output.docx").exists()
        negative_checks.append("fallback-create-macro-blocked")
        steps.append("controlled-full-create")

        clean = root / "clean.docx"
        sanitize_docx(fallback_output, clean, remove_comments=True)
        clean_info = inspect_docx(clean)
        assert clean_info["metadata"]["author"] in {"", None}
        steps.append("sanitize")

        comparison = compare_docx(created, clean, root / "diff.json")
        assert comparison["diff"]
        assert "metadata_changes" in comparison
        steps.append("compare-structure")

        rendered_pages = 0
        preflight_status = "not-run"
        if find_soffice():
            preflight = preflight_docx(
                clean,
                root / "rendered",
                report_path=root / "preflight.json",
                profile="final",
                required_text=["受控降级说明", "项目概览"],
                min_pages=1,
                visual_review_status="passed",
            )
            rendered_pages = preflight["render"]["pages"]
            preflight_status = preflight["status"]
            assert preflight["coverage"]["status"] == "passed"
            assert preflight["passed"]
            assert all(
                "text" not in item for item in preflight["render"]["page_text"]
            )
            assert all(
                item["ratio"] is None
                or item["characters"] < 8
                or item["ratio"] >= 0.7
                for item in preflight["render"]["cjk_glyph_coverage"]
            )
            steps.append("preflight-render-coverage")

            failed_visual = preflight_docx(
                clean,
                root / "rendered-failed",
                profile="final",
                required_text=["受控降级说明"],
                min_pages=1,
                visual_review_status="failed",
            )
            assert failed_visual["status"] == "partial"
            assert not failed_visual["passed"]
            assert any(
                item["code"] == "visual-review-failed"
                for item in failed_visual["unresolved"]["errors"]
            )
            assert failed_visual["unresolved"]["warnings"]["total"] == 0
            negative_checks.append("visual-review-failure")

    return {
        "status": "ok",
        "steps": steps,
        "negative_checks": negative_checks,
        "rendered_pages": rendered_pages,
        "preflight_status": preflight_status,
    }
