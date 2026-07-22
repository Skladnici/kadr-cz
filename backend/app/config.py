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

    # HTTP Basic Auth guarding the entire site — every /api/* route except
    # the unauthenticated "/" health check requires this. Anonymous
    # visitors must not be able to upload documents, run OCR, generate
    # contracts, or touch the shared companies list. Leave unset to keep
    # those endpoints disabled with a clear 503 rather than open.
    SITE_USERNAME: str = os.getenv("SITE_USERNAME", "")
    SITE_PASSWORD: str = os.getenv("SITE_PASSWORD", "")
    # Guards /api/ping/supabase (the keep-alive cron hits this unattended,
    # without the site login) — see main.py's _require_ping_token. Leave
    # unset to keep the endpoint open; it's a single cheap, read-only
    # Supabase query with no PII, so that's an acceptable default for a
    # small internal tool.
    PING_TOKEN: str = os.getenv("PING_TOKEN", "")
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

    # Controls verbosity of the OCR pipeline's logging (ocr_service.py) —
    # defaults to INFO so the per-request timing/diagnostic messages it
    # already relied on stay visible in Render's log viewer by default,
    # same as when they were plain print() calls. Set to WARNING to quiet
    # the timing noise down, or DEBUG for more detail.
    LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO")

    # No wildcard default. Production deployments MUST set CORS_ORIGINS to
    # the real frontend origin(s), e.g. "https://kadr-cz.example.com" —
    # with nothing set, only the local Vite dev server is allowed.
    # (CORS here doesn't gate credentials — allow_credentials is always
    # off in main.py, since the site login is a manually-attached
    # Authorization header, not a browser-managed cookie.)
    _raw_cors_origins = os.getenv("CORS_ORIGINS", "")
    CORS_ORIGINS: list = (
        [o.strip() for o in _raw_cors_origins.split(",") if o.strip()]
        if _raw_cors_origins.strip()
        else ["http://localhost:5173", "http://127.0.0.1:5173"]
    )


settings = Settings()

for d in (settings.UPLOAD_DIR, settings.GENERATED_DIR, settings.TEMPLATES_DIR):
    d.mkdir(parents=True, exist_ok=True)
