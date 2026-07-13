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
