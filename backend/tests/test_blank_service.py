"""
Regression tests for blank_service.py — mainly the path-traversal fix
(template_id whitelist + filename sanitizing), the stale-file cleanup,
and the list_templates() caching, since all were hand-fixes with no
prior test coverage.
"""
import os
import time

import pytest

from app.config import settings
import app.blank_service as blank_service
from app.blank_service import (
    _safe_filename_part,
    _cleanup_stale_generated_files,
    list_templates,
    fill_blank,
)


@pytest.fixture(autouse=True)
def _reset_templates_cache():
    """list_templates() caches at module level, keyed by a signature of
    the real TEMPLATES_DIR by default — reset around every test so one
    test's monkeypatched settings.TEMPLATES_DIR can't leak a stale cache
    into another."""
    blank_service._templates_cache = None
    blank_service._templates_cache_signature = None
    yield
    blank_service._templates_cache = None
    blank_service._templates_cache_signature = None


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


def test_list_templates_does_not_reparse_when_nothing_changed(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "TEMPLATES_DIR", tmp_path)
    (tmp_path / "a_template.docx").write_bytes(b"fake docx bytes")

    call_count = {"n": 0}

    def fake_read_title(path):
        call_count["n"] += 1
        return "A Title"

    monkeypatch.setattr(blank_service, "_read_title", fake_read_title)

    first = list_templates()
    second = list_templates()

    assert first == second == [{"id": "a_template", "title": "A Title"}]
    # The (expensive, python-docx-based) title read must only happen
    # once — the second call should be served entirely from cache.
    assert call_count["n"] == 1


def test_list_templates_picks_up_a_newly_added_file(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "TEMPLATES_DIR", tmp_path)
    monkeypatch.setattr(blank_service, "_read_title", lambda path: None)

    (tmp_path / "a_template.docx").write_bytes(b"fake")
    assert len(list_templates()) == 1

    (tmp_path / "b_template.docx").write_bytes(b"fake")
    assert len(list_templates()) == 2


def test_list_templates_picks_up_an_edited_file(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "TEMPLATES_DIR", tmp_path)

    titles = {"n": 0}

    def fake_read_title(path):
        titles["n"] += 1
        return f"Title {titles['n']}"

    monkeypatch.setattr(blank_service, "_read_title", fake_read_title)

    f = tmp_path / "a_template.docx"
    f.write_bytes(b"v1")
    first = list_templates()
    assert first[0]["title"] == "Title 1"

    # Force the mtime forward explicitly rather than relying on real
    # wall-clock time passing between writes, which can be flaky on
    # filesystems with coarse mtime resolution.
    f.write_bytes(b"v2, longer content than before")
    os.utime(f, (f.stat().st_mtime + 1, f.stat().st_mtime + 1))

    second = list_templates()
    assert second[0]["title"] == "Title 2"
