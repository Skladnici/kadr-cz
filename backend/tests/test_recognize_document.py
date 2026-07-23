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


# ----------------------------------------------------------------------
# OCR.space auto-retry on a low-quality first read (see recognize_document's
# "ocrspace" branch). Each test below stubs _ocr_space_ocr with a
# call-counting closure so it can both assert *that* a retry happened and
# that it never happens more than once per file, regardless of how many
# low-quality signals fired on the first read.

# ICAO Doc 9303's own worked MRZ example (see test_ocr_service.py's
# test_extract_passport_number_from_mrz_self_verifies) — a real,
# checksum-valid TD3 name+number line pair to use as the "good" second
# read. Name (line 1) and doc-number/birth-date/checksum (line 2) are
# independent MRZ fields, which lets the fixtures below corrupt one
# without touching the other — isolating exactly one low-quality signal
# per test instead of accidentally tripping several at once.
_GOOD_NAME_LINE = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<"
_GOOD_NUMBER_LINE = "L898902C36UTO7408122F1204159ZE184226B<<<<<10"
_GOOD_MRZ_TEXT = f"{_GOOD_NAME_LINE}\n{_GOOD_NUMBER_LINE}"

# Same name shape as _GOOD_NAME_LINE ("SURNAME<<GIVEN"), but both parts
# collapse to 1-2 distinct letters — the same "Kk Kk Kkk" noise pattern
# _looks_like_garbage_name exists to catch.
_GARBLED_NAME_LINE = "P<UTOKK<<KK<KKK<<<<<<<<<<<<<<<"

# Same shape as _GOOD_NUMBER_LINE, but the 9-char document-number field is
# all "X" (not in the OCR-confusion table, so _verify_and_correct can
# never fix it) and its check digit deliberately doesn't match —
# guaranteed unverifiable.
_BAD_CHECKSUM_NUMBER_LINE = "XXXXXXXXX0UTO7408122F1204159ZE184226B<<<<<10"
_BAD_CHECKSUM_MRZ_TEXT = f"{_GOOD_NAME_LINE}\n{_BAD_CHECKSUM_NUMBER_LINE}"


def _counting_ocr_stub(responses):
    """Returns an async stand-in for _ocr_space_ocr that returns each of
    `responses` in turn and records how many times it was called."""
    calls = {"count": 0}

    async def stub(image_bytes, filename):
        calls["count"] += 1
        return responses[min(calls["count"], len(responses)) - 1]

    return stub, calls


async def test_recognize_document_retries_once_on_garbled_name(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "OCR_MODE", "ocrspace")
    stub, calls = _counting_ocr_stub([
        f"{_GARBLED_NAME_LINE}\n{_GOOD_NUMBER_LINE}",
        _GOOD_MRZ_TEXT,
    ])
    monkeypatch.setattr("app.ocr_service._ocr_space_ocr", stub)

    file_path = tmp_path / "test.jpg"
    file_path.write_bytes(_TINY_JPEG)
    result = await recognize_document(file_path, "test.jpg")

    assert calls["count"] == 2, "expected exactly one retry"
    assert (result["first_name"], result["last_name"]) == ("Anna Maria", "Eriksson")


async def test_recognize_document_retries_once_on_empty_important_field(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "OCR_MODE", "ocrspace")
    stub, calls = _counting_ocr_stub([
        "CESTOVNÍ PAS",  # no birth_date, no doc_number on the first read
        "CESTOVNÍ PAS\nDatum narození: 12.03.1994\nČ. dokladu: 123456789",
    ])
    monkeypatch.setattr("app.ocr_service._ocr_space_ocr", stub)

    file_path = tmp_path / "test.jpg"
    file_path.write_bytes(_TINY_JPEG)
    result = await recognize_document(file_path, "test.jpg")

    assert calls["count"] == 2, "expected exactly one retry"
    assert result["birth_date"] == "12.03.1994"
    assert result["doc_number"] == "123456789"


async def test_recognize_document_retries_once_on_invalid_mrz_checksum(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "OCR_MODE", "ocrspace")
    stub, calls = _counting_ocr_stub([_BAD_CHECKSUM_MRZ_TEXT, _GOOD_MRZ_TEXT])
    monkeypatch.setattr("app.ocr_service._ocr_space_ocr", stub)

    file_path = tmp_path / "test.jpg"
    file_path.write_bytes(_TINY_JPEG)
    result = await recognize_document(file_path, "test.jpg")

    assert calls["count"] == 2, "expected exactly one retry"
    assert result["doc_number"] == "L898902C3"
    assert result["doc_number_verified"] is True


async def test_recognize_document_does_not_retry_twice_for_multiple_bad_signals(tmp_path, monkeypatch):
    # First read has BOTH a garbled name and an invalid checksum, and the
    # (stubbed) second attempt comes back just as bad — still only one
    # extra OCR.space call total, never one retry per signal and never a
    # second retry when the first one didn't help.
    bad_text = f"{_GARBLED_NAME_LINE}\n{_BAD_CHECKSUM_NUMBER_LINE}"
    monkeypatch.setattr(settings, "OCR_MODE", "ocrspace")
    stub, calls = _counting_ocr_stub([bad_text, bad_text])
    monkeypatch.setattr("app.ocr_service._ocr_space_ocr", stub)

    file_path = tmp_path / "test.jpg"
    file_path.write_bytes(_TINY_JPEG)
    result = await recognize_document(file_path, "test.jpg")

    assert calls["count"] == 2, "must not retry more than once per file even with 2 bad signals"
    # Retry didn't fix either problem, so the (equally bad) retry result
    # must not silently replace the original.
    assert result["doc_number_verified"] is False


async def test_recognize_document_does_not_retry_on_a_clean_first_read(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "OCR_MODE", "ocrspace")
    stub, calls = _counting_ocr_stub([_GOOD_MRZ_TEXT])
    monkeypatch.setattr("app.ocr_service._ocr_space_ocr", stub)

    file_path = tmp_path / "test.jpg"
    file_path.write_bytes(_TINY_JPEG)
    await recognize_document(file_path, "test.jpg")

    assert calls["count"] == 1, "a clean first read must not trigger any retry"
