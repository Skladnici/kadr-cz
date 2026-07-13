# KADR.CZ — vyplnění pracovněprávních dokumentů

Nahrajete doklad (pas, ID kartu, povolení k pobytu, vízum) → systém
rozpozná údaje → vyberete formulář → vygenerujete Word/PDF ke stažení
nebo tisku. Přístup na celý web je chráněný jedním sdíleným
uživatelským jménem a heslem.

## Struktura

```
kadr-cz/
├── backend/
│   ├── app/
│   │   ├── main.py           API endpointy (viz níže)
│   │   ├── ocr_service.py    rozpoznávání dokladů (Google Vision / OCR.space / Tesseract / mock)
│   │   ├── blank_service.py  vyplňování .docx šablon, úklid starých souborů
│   │   ├── config.py         nastavení ze systémových proměnných
│   │   └── templates/        *.docx šablony — přidejte novou = objeví se automaticky
│   ├── tests/                pytest
│   ├── requirements.txt
│   └── requirements-dev.txt  + pytest pro lokální testy
└── frontend/
    └── src/
        └── SimpleDocFiller.jsx   celé frontendové UI (přihlášení + vyplnění), jeden soubor
```

## Spuštění backendu lokálně

```bash
cd backend
python -m venv venv && venv\Scripts\activate   # nebo source venv/bin/activate na Linuxu/macOS
pip install -r requirements-dev.txt
uvicorn app.main:app --reload --port 8000
```

Bez `SITE_USERNAME`/`SITE_PASSWORD` v prostředí vrátí všechny `/api/*`
routy `503` (přístup je záměrně vypnutý, ne otevřený). Bez
`GOOGLE_VISION_API_KEY` ani `OCR_SPACE_API_KEY` běží rozpoznávání
lokálně přes Tesseract; pokud selže i to, spadne do MOCK režimu
(ukázková data) — vyplnění, stažení a tisk fungují i tak.

### Proměnné prostředí

| Proměnná | Účel |
|---|---|
| `SITE_USERNAME`, `SITE_PASSWORD` | Přihlašovací údaje pro celý web (vyžadováno) |
| `CORS_ORIGINS` | Čárkou oddělený seznam povolených originů frontendu (produkce) |
| `GOOGLE_VISION_API_KEY` | Přepne rozpoznávání do režimu "live" (Google Cloud Vision) |
| `OCR_SPACE_API_KEY` | Přepne do režimu "ocrspace" (zdarma, bez billing účtu) |
| `SUPABASE_URL`, `SUPABASE_KEY` | Sdílená databáze firem (bez nich `/api/companies` vrací `503`) |
| `OCR_MODE_OVERRIDE` | Vynutí konkrétní režim (`live`/`ocrspace`/`local`/`mock`), např. pro testování |

## Spuštění testů

```bash
cd backend
pytest
```

## Jak přidat nový typ formuláře

Stačí přidat nový `.docx` soubor do `backend/app/templates/` s poli ve
formátu `{{JMENO}}`, `{{PRIJMENI}}`, `{{ADRESA}}` atd. (viz existující
šablony pro seznam podporovaných polí). Formulář se automaticky objeví
v rozbalovacím seznamu v aplikaci — žádná úprava kódu není potřeba.

## API endpointy

Všechny kromě `GET /` vyžadují přihlášení (`Authorization: Basic ...`).

- `GET /api/blanks` — seznam dostupných formulářů
- `POST /api/recognize` — nahraje fotku/PDF, vrátí rozpoznaná data (soubor se hned maže)
- `POST /api/recognize-text` — stejné rozpoznávání, ale nad ručně vloženým textem
- `POST /api/fill` — vyplní zvolenou šablonu, vrátí token ke stažení
- `GET /api/download/{token}` — stáhne vygenerovaný dokument; token je jednorázový, soubor se po stažení smaže
- `GET/POST/PUT/DELETE /api/companies` — sdílený seznam firem (Supabase) pro opakované použití IČO/DIČ/adresy

## Co se ukládá a co ne

- Nahraná fotka dokladu — smaže se ihned po rozpoznání
- Vygenerovaný dokument — smaže se ihned po stažení, nebo automaticky po 24 hodinách, pokud si ho nikdo nestáhne
- Seznam firem — ukládá se trvale v Supabase, sdílený mezi všemi, kdo web používají
