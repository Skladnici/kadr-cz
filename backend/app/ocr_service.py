"""
Document recognition pipeline.

Two modes, selected automatically by whether GOOGLE_VISION_API_KEY is set:

  - "live": calls the Google Cloud Vision API (free tier ~1000 units/month)
    to OCR the image, then runs it through field-extraction rules tuned
    for Czech, Ukrainian, and generic ICAO/EU documents.

  - "mock": returns realistic, deterministic sample data so the whole
    product can be developed, demoed and tested for free, with zero
    external dependency. The extraction/validation code path is IDENTICAL
    in both modes — only where the raw text comes from differs. This
    means switching to "live" later requires no changes anywhere else in
    the app: just set the API key.

To go live: put GOOGLE_VISION_API_KEY=... in backend/.env
(Get a free-tier key at https://console.cloud.google.com/apis/library/vision.googleapis.com)
"""
import base64
import re
import mimetypes
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional

import httpx

from app.config import settings

VISION_ENDPOINT = "https://vision.googleapis.com/v1/images:annotate"

# ---------------------------------------------------------------- doc type
DOC_TYPE_KEYWORDS = {
    "Občanský průkaz": ["občanský průkaz", "obcansky prukaz", "identity card czech"],
    "Cestovní pas": ["cestovní pas", "cestovni pas", "passport", "паспорт"],
    "Zaměstnanecká karta": ["zaměstnanecká karta", "zamestnanecka karta", "employee card"],
    "Modrá karta": ["modrá karta", "modra karta", "blue card"],
    "Povolení k pobytu": ["povolení k pobytu", "poboyt", "residence permit"],
    "Přechodný pobyt": ["přechodný pobyt", "prechodny pobyt", "temporary residence"],
    "Trvalý pobyt": ["trvalý pobyt", "trvaly pobyt", "permanent residence"],
    "Vízum": ["vízum", "vizum", "visa", "виза"],
    "Kartička zdravotní pojišťovny": ["zdravotní pojišťovna", "zdravotni pojistovna", "health insurance card"],
    "Řidičský průkaz": ["řidičský průkaz", "ridicsky prukaz", "driving licence", "driver licence"],
    "Biometrický pas": ["biometrichnyi pasport", "біометричний паспорт", "biometric passport"],
    "ID karta": ["id card", "identity card", "id-карта"],
}

COUNTRY_HINTS = {
    "Ukrajina": ["ukraine", "україна", "ukrajina", "ukr"],
    "Česká republika": ["czech republic", "česká republika", "ceska republika", "cze"],
    "Slovensko": ["slovakia", "slovensko", "svk"],
    "Polsko": ["poland", "polska", "pol"],
}


def _detect_doc_type(text: str) -> str:
    low = text.lower()
    for doc_type, keywords in DOC_TYPE_KEYWORDS.items():
        if any(k in low for k in keywords):
            return doc_type
    return "Neznámý dokument"


def _detect_country(text: str) -> Optional[str]:
    low = text.lower()
    for country, keywords in COUNTRY_HINTS.items():
        if any(k in low for k in keywords):
            return country
    return None


def _detect_language(text: str) -> str:
    if re.search(r"[а-яіїєґ]", text.lower()):
        return "ukrajinština"
    if re.search(r"[ěščřžýáíéůňťď]", text.lower()):
        return "čeština"
    return "angličtina"


DATE_PATTERNS = [
    r"(\d{2})[.\-/](\d{2})[.\-/](\d{4})",   # 12.03.1994 or 12-03-1994
    r"(\d{4})[.\-/](\d{2})[.\-/](\d{2})",   # 1994-03-12
]


def _find_dates(text: str) -> list[str]:
    found = []
    for pattern in DATE_PATTERNS:
        for m in re.finditer(pattern, text):
            found.append(m.group(0))
    return found


def _parse_mrz(text: str) -> Optional[str]:
    """Very lightweight MRZ line detector (two lines of 44 chars w/ '<')."""
    lines = [l.strip() for l in text.splitlines() if "<<" in l]
    if lines:
        return "\n".join(lines[-2:])
    return None


def _quality_score(image_bytes: bytes) -> int:
    """Rough heuristic placeholder — in production this reads Vision's
    imageProperties/faceAnnotation confidence. Here we approximate from
    file size as a stand-in signal so the UI has something real to show."""
    size_kb = len(image_bytes) / 1024
    if size_kb < 50:
        return 55
    if size_kb < 300:
        return 78
    return 92


def _extract_fields_from_text(raw_text: str, quality: int, mode: str) -> dict:
    doc_type = _detect_doc_type(raw_text)
    country = _detect_country(raw_text)
    language = _detect_language(raw_text)
    dates = _find_dates(raw_text)
    mrz = _parse_mrz(raw_text)

    issue_date = dates[0] if len(dates) >= 1 else None
    expiry_date = dates[1] if len(dates) >= 2 else None

    is_expired = False
    warnings = []
    if expiry_date:
        try:
            parsed = _parse_any_date(expiry_date)
            if parsed and parsed < date.today():
                is_expired = True
                warnings.append("Doklad je propadlý — platnost skončila.")
            elif parsed and parsed < date.today() + timedelta(days=60):
                warnings.append("Platnost dokladu vyprší do 60 dní.")
        except Exception:
            pass

    if quality < 60:
        warnings.append("Kvalita fotografie je nízká — doporučujeme nahrát nový sken.")

    confidence = "high" if quality > 85 else "medium" if quality > 65 else "low"

    return {
        "doc_type": doc_type,
        "issuing_country": country,
        "document_language": language,
        "issue_date": issue_date,
        "expiry_date": expiry_date,
        "mrz_raw": mrz,
        "ocr_quality_score": quality,
        "ocr_confidence": confidence,
        "ocr_mode": mode,
        "is_expired": is_expired,
        "warnings": warnings,
    }


def _parse_any_date(raw: str) -> Optional[date]:
    for fmt in ("%d.%m.%Y", "%d-%m-%Y", "%d/%m/%Y", "%Y-%m-%d", "%Y.%m.%d", "%Y/%m/%d"):
        try:
            return datetime.strptime(raw, fmt).date()
        except ValueError:
            continue
    return None


# ---------------------------------------------------------------- MOCK MODE
_MOCK_SAMPLES = [
    {
        "raw_text": "OBČANSKÝ PRŮKAZ\nCESTA JANA\nNOVÁK\n12.03.1994\nČeská republika\nČ.DOKL: 999123456",
        "first_name": "Jan", "last_name": "Novák", "gender": "Muž",
        "birth_date": "1994-03-12", "nationality": "Česká republika",
        "doc_number": "999123456", "address": "Vinohradská 45, Praha 2",
        "issuing_authority": "MV ČR",
    },
    {
        "raw_text": "БІОМЕТРИЧНИЙ ПАСПОРТ УКРАЇНА\nPETRENKO MYKOLA\n08.05.1992\nUkraine\nFK778899",
        "first_name": "Mykola", "last_name": "Petrenko", "gender": "Muž",
        "birth_date": "1992-05-08", "nationality": "Ukrajina",
        "doc_number": "FK778899", "address": None,
        "issuing_authority": "DMS Ukrajiny",
    },
]


def _mock_extract(filename: str) -> dict:
    import hashlib
    idx = int(hashlib.md5(filename.encode()).hexdigest(), 16) % len(_MOCK_SAMPLES)
    sample = _MOCK_SAMPLES[idx]
    quality = 88
    base = _extract_fields_from_text(sample["raw_text"], quality, mode="mock")
    base.update({
        "first_name": sample["first_name"],
        "last_name": sample["last_name"],
        "gender": sample["gender"],
        "birth_date": sample["birth_date"],
        "nationality": sample["nationality"],
        "doc_number": sample["doc_number"],
        "address": sample["address"],
        "issuing_authority": sample["issuing_authority"],
        # give the mock a plausible future expiry so nothing looks broken
        "issue_date": "2021-02-10",
        "expiry_date": "2031-02-10",
        "is_expired": False,
        "warnings": [],
    })
    return base


# ---------------------------------------------------------------- LIVE MODE
async def _vision_ocr(image_bytes: bytes) -> str:
    """Calls Google Cloud Vision's TEXT_DETECTION and returns raw text."""
    b64 = base64.b64encode(image_bytes).decode()
    payload = {
        "requests": [{
            "image": {"content": b64},
            "features": [{"type": "TEXT_DETECTION"}],
        }]
    }
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            VISION_ENDPOINT,
            params={"key": settings.GOOGLE_VISION_API_KEY},
            json=payload,
        )
        resp.raise_for_status()
        data = resp.json()

    try:
        return data["responses"][0]["fullTextAnnotation"]["text"]
    except (KeyError, IndexError):
        return ""


NAME_LABEL_PATTERNS = [
    # (label regex, group meaning)
    (r"(?:Příjmení|Surname)\s*[:\-]?\s*\n?\s*([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ\s]{1,30})", "last"),
    (r"(?:Jméno|Given name)s?\s*[:\-]?\s*\n?\s*([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ\s]{1,30})", "first"),
]


def _parse_name_from_text(text: str) -> tuple[Optional[str], Optional[str]]:
    """Best-effort name extraction, in order of reliability:
    1. MRZ 'SURNAME<<GIVEN' pattern (passports) — most reliable.
    2. Labelled fields 'Jméno'/'Příjmení' or 'Given name'/'Surname'
       (Czech ID cards, residence permits — bilingual labels).
    3. Nothing found — left for manual entry; the raw recognized text is
       still shown to the user so they can copy it themselves.
    """
    mrz_match = re.search(r"([A-Z]+)<<([A-Z<]+)", text)
    if mrz_match:
        last = mrz_match.group(1).replace("<", " ").strip().title()
        first = mrz_match.group(2).replace("<", " ").strip().title()
        return first, last

    first = last = None
    for pattern, kind in NAME_LABEL_PATTERNS:
        m = re.search(pattern, text, re.IGNORECASE)
        if m:
            value = m.group(1).strip().split("\n")[0].strip().title()
            if kind == "first":
                first = value
            else:
                last = value
    return first, last


def _tesseract_ocr(image_bytes: bytes) -> str:
    """Free, local, no-API-key OCR using Tesseract — no billing account or
    API key needed at all. Less accurate than Google Vision but works out
    of the box on any server. Requires the `tesseract-ocr` system package
    (installed via Dockerfile) and `pytesseract` + `Pillow` Python packages."""
    import pytesseract
    from PIL import Image
    import io

    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
    except ImportError:
        pass  # HEIC support unavailable; non-HEIC images still work fine.

    try:
        image = Image.open(io.BytesIO(image_bytes))
        image.load()
        # Always force a real conversion, even if mode is already "RGB" —
        # some loaders (e.g. HEIC) return a mode="RGB" wrapper object that
        # isn't a genuine PIL.Image and that pytesseract rejects. .convert()
        # always returns a fresh, plain PIL.Image regardless of source mode.
        image = image.convert("RGB")
    except Exception as e:
        print(f"[ocr] Failed to open image: {type(e).__name__}: {e}")
        return ""

    # Try Czech+Ukrainian+English combined if language packs are installed,
    # fall back to English-only, then to tesseract's bare default.
    for langs in ("ces+ukr+eng", "eng", None):
        try:
            if langs:
                return pytesseract.image_to_string(image, lang=langs)
            return pytesseract.image_to_string(image)
        except Exception as e:
            print(f"[ocr] Tesseract failed with lang={langs}: {type(e).__name__}: {e}")
            continue
    return ""


async def recognize_document(file_path: Path, original_filename: str) -> dict:
    """
    Main entry point used by the API layer.
    Returns a flat dict matching schemas.ExtractedFields.
    """
    image_bytes = file_path.read_bytes()
    quality = _quality_score(image_bytes)

    if settings.OCR_MODE == "mock":
        result = _mock_extract(original_filename)
        return result

    mime, _ = mimetypes.guess_type(str(file_path))

    if settings.OCR_MODE == "local":
        if mime == "application/pdf":
            result = _mock_extract(original_filename)
            result["warnings"] = result.get("warnings", []) + [
                "Rozpoznávání PDF v bezplatném režimu zatím není podporováno — zobrazena ukázková data."
            ]
            return result
        try:
            raw_text = _tesseract_ocr(image_bytes)
        except Exception:
            raw_text = ""
        if not raw_text.strip():
            result = _mock_extract(original_filename)
            result["warnings"] = ["Nepodařilo se přečíst text z dokumentu — zkuste ostřejší fotografii."]
            return result
        fields = _extract_fields_from_text(raw_text, quality, mode="local")
        first, last = _parse_name_from_text(raw_text)
        fields["first_name"] = first
        fields["last_name"] = last
        fields["ocr_raw_text"] = raw_text
        return fields

    # live mode (Google Vision)
    if mime == "application/pdf":
        # Vision's images:annotate needs a rasterized image; for PDFs a
        # production build should use files:asyncBatchAnnotate instead.
        # For MVP scope we OCR only image uploads live; PDFs fall back to mock
        # with a warning so the user isn't blocked.
        result = _mock_extract(original_filename)
        result["warnings"] = result.get("warnings", []) + [
            "Živé rozpoznávání PDF zatím není podporováno — zobrazena ukázková data."
        ]
        return result

    raw_text = await _vision_ocr(image_bytes)
    if not raw_text:
        result = _mock_extract(original_filename)
        result["warnings"] = ["Nepodařilo se přečíst text z dokumentu — zkontrolujte kvalitu skenu."]
        return result

    fields = _extract_fields_from_text(raw_text, quality, mode="live")
    first, last = _parse_name_from_text(raw_text)
    fields["first_name"] = first
    fields["last_name"] = last
    fields["ocr_raw_text"] = raw_text
    return fields
