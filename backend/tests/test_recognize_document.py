"""
Regression test for the missing top-level `import asyncio` bug in
ocr_service.py: recognize_document()'s "local" OCR mode (the default when
no OCR API key is configured) called `await asyncio.to_thread(...)`
without `asyncio` imported at module level. The resulting NameError was
swallowed by a broad `except Exception` *inside* recognize_document()
itself, so it never propagates to a caller — a black-box "does calling
this raise NameError" test cannot detect the bug, since the visible
symptom (silent fallback to mock data) is identical to Tesseract
legitimately not being installed. Instead we replace _tesseract_ocr with
a stub and check whether its result actually made it through: if
asyncio.to_thread(...) had raised anything (NameError included), this
would come back as the generic mock fallback instead.
"""
import time

from app.config import settings
from app.ocr_service import recognize_document

# Smallest possible valid JPEG (1x1 pixel) — content doesn't matter, only
# that recognize_document() gets far enough to call the OCR step.
_TINY_JPEG = (
    b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    b"\xff\xdb\x00C\x00" + b"\x01" * 64 + b"\xff\xd9"
)


async def test_recognize_document_local_mode_uses_tesseract_result(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "OCR_MODE", "local")
    monkeypatch.setattr(
        "app.ocr_service._tesseract_ocr",
        lambda image_bytes: "CESTOVNÍ PAS\nČ. dokladu: 123456789",
    )
    file_path = tmp_path / "test.jpg"
    file_path.write_bytes(_TINY_JPEG)

    result = await recognize_document(file_path, "test.jpg")

    # ocr_mode == "mock" here would mean the (stubbed) Tesseract call
    # never actually ran and the pipeline silently fell back — exactly
    # what the missing-import bug caused for every real request.
    assert result["ocr_mode"] == "local"
    assert result["doc_number"] == "123456789"


async def test_recognize_document_local_mode_bounded_by_tesseract_timeout(tmp_path, monkeypatch):
    """A hung/adversarial image must not hold the request hostage —
    recognize_document() should give up and fall back to mock data once
    TESSERACT_TIMEOUT_SECONDS elapses, well before Tesseract itself
    "finishes" (asyncio.wait_for can't kill the underlying OS thread, so
    it keeps running in the background, but the request doesn't wait
    for it)."""
    monkeypatch.setattr(settings, "OCR_MODE", "local")
    monkeypatch.setattr("app.ocr_service.TESSERACT_TIMEOUT_SECONDS", 0.2)

    def hung_tesseract(image_bytes):
        time.sleep(1.0)  # simulates Tesseract hanging on a bad image
        return "should never be seen"

    monkeypatch.setattr("app.ocr_service._tesseract_ocr", hung_tesseract)

    file_path = tmp_path / "test.jpg"
    file_path.write_bytes(_TINY_JPEG)

    start = time.monotonic()
    result = await recognize_document(file_path, "test.jpg")
    elapsed = time.monotonic() - start

    assert elapsed < 0.9, f"request took {elapsed:.2f}s — timeout was not enforced"
    assert result["ocr_mode"] == "mock"
