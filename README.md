# KADR.CZ — jednoduché vyplnění dokumentů

Nejjednodušší varianta: nahrajete doklad → systém rozpozná údaje → vyberete
formulář → vygenerujete Word/PDF ke stažení nebo tisku. Žádná databáze,
žádné uživatelské účty, žádná historie — každé použití je samostatné.

## Struktura

```
hr-simple/
├── backend/
│   ├── app/
│   │   ├── main.py           2 hlavní endpointy: /api/recognize, /api/fill
│   │   ├── ocr_service.py    rozpoznávání dokladů (Google Vision / mock)
│   │   ├── blank_service.py  vyplňování .docx šablon
│   │   ├── config.py
│   │   └── templates/        *.docx šablony — přidejte novou = objeví se automaticky
│   ├── requirements.txt
│   └── .env.example
└── src/
    └── SimpleDocFiller.jsx   celé frontendové UI, jedna obrazovka
```

## Spuštění

```bash
cd backend
cp .env.example .env
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Bez `GOOGLE_VISION_API_KEY` v `.env` běží rozpoznávání v MOCK režimu
(ukázková data) — vše ostatní (vyplnění, stažení, tisk) funguje na 100 %
i bez klíče a bez placení.

## Jak přidat nový typ formuláře

Stačí přidat nový `.docx` soubor do `backend/app/templates/` s poli ve
formátu `{{JMENO}}`, `{{PRIJMENI}}`, `{{ADRESA}}` atd. (viz existující
šablony pro seznam podporovaných polí). Formulář se automaticky objeví
v rozbalovacím seznamu v aplikaci — žádná úprava kódu není potřeba.

## Jak to funguje (bez databáze)

- `/api/recognize` — přijme fotku/PDF, vrátí rozpoznaná data, soubor hned smaže
- `/api/fill` — vyplní zvolenou šablonu, vrátí odkaz ke stažení
- `/api/download/{soubor}` — stáhne vygenerovaný dokument

Vygenerované soubory zůstávají ve složce `backend/generated/` — pro
čistě jednorázové použití je možné je periodicky mazat (cron/cleanup),
protože appka na ně dál neodkazuje po stažení.
