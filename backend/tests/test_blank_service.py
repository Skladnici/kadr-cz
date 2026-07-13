"""
Regression tests for blank_service.py — mainly the path-traversal fix
(template_id whitelist + filename sanitizing) and the stale-file cleanup,
since both were security-relevant hand-fixes with no prior test coverage.
"""
import time

import pytest

from app.config import settings
from app.blank_service import (
    _safe_filename_part,
    _cleanup_stale_generated_files,
    fill_blank,
)


def test_safe_filename_part_strips_traversal_characters():
    assert _safe_filename_part("../../etc/passwd") == "etc_passwd"


def test_safe_filename_part_uses_fallback_when_empty():
    assert _safe_filename_part("", "dokument") == "dokument"


def test_safe_filename_part_keeps_normal_names_readable():
    assert _safe_filename_part("Novak Jan") == "Novak_Jan"


def test_fill_blank_rejects_template_id_outside_whitelist():
    # This is the exact exploit from the security audit: an absolute path
    # (or anything not in the discovered-templates set) must never reach
    # the filesystem join.
    with pytest.raises(FileNotFoundError):
        fill_blank("/etc/passwd", {"last_name": "x", "first_name": "y"})


def test_fill_blank_generates_document_within_generated_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "GENERATED_DIR", tmp_path)
    out_path = fill_blank("dpp_template", {"last_name": "Novak", "first_name": "Jan"})
    assert out_path.exists()
    assert out_path.parent == tmp_path.resolve()
    assert out_path.suffix == ".docx"


def test_fill_blank_sanitizes_traversal_in_name_fields(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "GENERATED_DIR", tmp_path)
    out_path = fill_blank(
        "dpp_template", {"last_name": "../../../../evil", "first_name": "y"}
    )
    # The generated file must land inside GENERATED_DIR, not escape via
    # traversal sequences smuggled through a name field.
    assert out_path.parent == tmp_path.resolve()
    assert list(tmp_path.iterdir()) == [out_path]


def test_cleanup_stale_generated_files_removes_only_old_files(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "GENERATED_DIR", tmp_path)

    old_file = tmp_path / "old.docx"
    old_file.write_text("stale")
    old_time = time.time() - 25 * 3600  # older than the 24h threshold
    import os
    os.utime(old_file, (old_time, old_time))

    fresh_file = tmp_path / "fresh.docx"
    fresh_file.write_text("fresh")

    _cleanup_stale_generated_files()

    remaining = {p.name for p in tmp_path.iterdir()}
    assert remaining == {"fresh.docx"}
