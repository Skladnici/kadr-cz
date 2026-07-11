"""Configuration for the simplified, stateless version of the system."""
import os
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


class Settings:
    APP_NAME = "KADR.CZ — Rychlé vyplnění dokumentů"

    GOOGLE_VISION_API_KEY: str = os.getenv("GOOGLE_VISION_API_KEY", "")
    # "live" = Google Vision (needs API key + billing account)
    # "local" = free Tesseract OCR running on the server, no key/card needed (default)
    # "mock" = fixed demo data, only used if explicitly forced via OCR_MODE_OVERRIDE
    _override = os.getenv("OCR_MODE_OVERRIDE", "")
    if _override in ("live", "local", "mock"):
        OCR_MODE: str = _override
    elif GOOGLE_VISION_API_KEY:
        OCR_MODE: str = "live"
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
