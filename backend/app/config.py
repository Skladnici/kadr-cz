"""Configuration for the simplified, stateless version of the system."""
import os
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


class Settings:
    APP_NAME = "KADR.CZ — Rychlé vyplnění dokumentů"

    GOOGLE_VISION_API_KEY: str = os.getenv("GOOGLE_VISION_API_KEY", "")
    OCR_SPACE_API_KEY: str = os.getenv("OCR_SPACE_API_KEY", "")
    SUPABASE_URL: str = os.getenv("SUPABASE_URL", "")
    SUPABASE_KEY: str = os.getenv("SUPABASE_KEY", "")

    # HTTP Basic Auth guarding the shared /api/companies endpoints (this
    # data is shared across every visitor and feeds directly into real
    # employment contracts, so it must not be world-writable). Leave unset
    # to keep those endpoints disabled with a clear 503 rather than open.
    COMPANIES_USERNAME: str = os.getenv("COMPANIES_USERNAME", "")
    COMPANIES_PASSWORD: str = os.getenv("COMPANIES_PASSWORD", "")
    # Engine priority:
    # "live"     = Google Vision — best accuracy, needs billing account
    # "ocrspace" = OCR.space free API — no card, no billing, processing
    #              happens on their servers (not this weak free instance),
    #              so it's both faster and lighter than local Tesseract
    # "local"    = Tesseract running on this server — free, no signup at
    #              all, but slow/heavy on a free-tier instance
    _override = os.getenv("OCR_MODE_OVERRIDE", "")
    if _override in ("live", "ocrspace", "local", "mock"):
        OCR_MODE: str = _override
    elif GOOGLE_VISION_API_KEY:
        OCR_MODE: str = "live"
    elif OCR_SPACE_API_KEY:
        OCR_MODE: str = "ocrspace"
    else:
        OCR_MODE: str = "local"

    UPLOAD_DIR: Path = BASE_DIR / "uploads"
    GENERATED_DIR: Path = BASE_DIR / "generated"
    TEMPLATES_DIR: Path = BASE_DIR / "app" / "templates"

    MAX_UPLOAD_SIZE_MB: int = 20
    ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".heic", ".pdf"}

    CORS_ORIGINS: list = os.getenv("CORS_ORIGINS", "*").split(",")


settings = Settings()

for d in (settings.UPLOAD_DIR, settings.GENERATED_DIR, settings.TEMPLATES_DIR):
    d.mkdir(parents=True, exist_ok=True)
