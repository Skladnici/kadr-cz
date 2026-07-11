FROM python:3.11-slim

# LibreOffice converts generated .docx to PDF (for the "print" button).
# Tesseract provides free, local OCR (no API key or billing needed) —
# used automatically when GOOGLE_VISION_API_KEY is not set.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice \
    tesseract-ocr \
    tesseract-ocr-ces \
    tesseract-ocr-ukr \
    tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=8000
EXPOSE 8000

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
