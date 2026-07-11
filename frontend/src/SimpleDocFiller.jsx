import React, { useState, useCallback, useRef, useEffect } from "react";
import {
  Upload, FileText, Check, AlertTriangle, X, Download,
  Printer, Loader2, ArrowRight, ArrowLeft, ScanLine, RotateCcw
} from "lucide-react";

// Compresses/resizes an image in the browser before upload — this cuts
// the actual network transfer time (often the real bottleneck on mobile
// connections with multi-MB phone photos), on top of any server-side
// compression that happens afterwards. HEIC files are passed through
// unchanged since most browsers can't decode HEIC via <canvas>.
function compressImageInBrowser(file, maxDimension = 1800, quality = 0.82) {
  return new Promise((resolve) => {
    const isHeic = /heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
    if (isHeic || !file.type.startsWith("image/")) {
      resolve(file); // let the backend handle HEIC/unsupported types as-is
      return;
    }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let { width, height } = img;
      if (Math.max(width, height) > maxDimension) {
        const scale = maxDimension / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      canvas.toBlob(
        (blob) => {
          if (!blob) { resolve(file); return; }
          resolve(new File([blob], file.name.replace(/\.\w+$/, ".jpg"), { type: "image/jpeg" }));
        },
        "image/jpeg",
        quality
      );
    };
    img.onerror = () => resolve(file); // fall back to original on any decode issue
    img.src = url;
  });
}

const API_BASE = typeof window !== "undefined" && window.__HR_API_BASE__
  ? window.__HR_API_BASE__
  : "http://localhost:8000";

// Fields shown for review/editing after recognition, and sent to /api/fill.
const FIELD_DEFS = [
  ["first_name", "Jméno"],
  ["last_name", "Příjmení"],
  ["birth_date", "Datum narození"],
  ["nationality", "Národnost"],
  ["doc_number", "Číslo dokladu"],
  ["address", "Adresa"],
  ["position", "Pozice"],
  ["workplace", "Místo výkonu práce"],
  ["salary", "Mzda / odměna"],
  ["hours_per_week", "Hodin týdně"],
  ["start_date", "Datum nástupu"],
  ["end_date", "Datum ukončení"],
  ["bank_account", "Bankovní účet"],
  ["company_name", "Firma (zaměstnavatel)"],
  ["company_ico", "IČO"],
  ["company_dic", "DIČ"],
  ["company_address", "Adresa firmy"],
  ["company_representative", "Zástupce firmy"],
  ["visa_number", "Číslo víza (jen pro cizince)"],
  ["visa_validity", "Platnost víza do (jen pro cizince)"],
  ["residence_type", "Druh pobytu na území ČR (jen pro cizince)"],
  ["signing_place", "Místo podpisu (výchozí: Praze)"],
  ["termination_reason", "Důvod ukončení (jen pro ukončovák)"],
  ["last_working_day", "Poslední pracovní den (jen pro ukončovák)"],
  ["pay_period", "Zúčtovací období (jen pro výplatní pásku)"],
  ["gross_salary", "Hrubá mzda (jen pro výplatní pásku)"],
  ["health_insurance", "Zdravotní pojištění (jen pro výplatní pásku)"],
  ["social_insurance", "Sociální pojištění (jen pro výplatní pásku)"],
  ["income_tax", "Daň ze mzdy (jen pro výplatní pásku)"],
  ["net_salary", "Čistá mzda (jen pro výplatní pásku)"],
];

export default function SimpleDocFiller() {
  const [step, setStep] = useState(1); // 1 upload, 2 scanning, 3 form, 4 done
  const [fields, setFields] = useState({});
  const [warnings, setWarnings] = useState([]);
  const [rawText, setRawText] = useState("");
  const [ocrMode, setOcrMode] = useState(null);
  const [error, setError] = useState(null);
  const [blanks, setBlanks] = useState([]);
  const [templateId, setTemplateId] = useState(null);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/blanks`)
      .then((r) => r.json())
      .then((data) => {
        setBlanks(data);
        if (data.length > 0) setTemplateId(data[0].id);
      })
      .catch(() => setError(`Nepodařilo se načíst seznam formulářů. Zkontrolujte, zda backend běží na ${API_BASE}.`));
  }, []);

  const handleFile = useCallback(async (file) => {
    if (!file) return;
    setStep(2);
    setError(null);
    try {
      const compressed = await compressImageInBrowser(file);
      const formData = new FormData();
      formData.append("file", compressed);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s max
      const res = await fetch(`${API_BASE}/api/recognize`, {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) throw new Error("server error");
      const data = await res.json();
      setFields({
        first_name: data.first_name || "",
        last_name: data.last_name || "",
        birth_date: data.birth_date || "",
        nationality: data.nationality || "",
        doc_number: data.doc_number || "",
        address: data.address && data.address !== "—" ? data.address : "",
        position: "",
        workplace: "",
        salary: "",
        hours_per_week: "",
        start_date: "",
        end_date: "",
        bank_account: "",
        company_name: "",
        company_ico: "",
        company_dic: "",
        company_address: "",
        company_representative: "",
      });
      setWarnings(data.warnings || []);
      setRawText(data.ocr_raw_text || "");
      setOcrMode(data.ocr_mode);
      setStep(3);
    } catch (e) {
      if (e.name === "AbortError") {
        setError("Rozpoznávání trvá příliš dlouho (přes 60 s) — server je pravděpodobně přetížený. Zkuste to znovu za chvíli, nebo nahrajte menší/ostřejší fotografii.");
      } else {
        setError(`Nepodařilo se rozpoznat dokument. Zkontrolujte, zda backend běží na ${API_BASE}.`);
      }
      setStep(1);
    }
  }, []);

  const skipUpload = () => {
    setFields(Object.fromEntries(FIELD_DEFS.map(([k]) => [k, ""])));
    setWarnings([]);
    setOcrMode(null);
    setStep(3);
  };

  const handleGenerate = async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/fill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template_id: templateId, ...fields }),
      });
      if (!res.ok) throw new Error("server error");
      const data = await res.json();
      setResult(data);
      setStep(4);
    } catch (e) {
      setError(`Nepodařilo se vygenerovat dokument. Zkontrolujte, zda backend běží na ${API_BASE}.`);
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setStep(1);
    setFields({});
    setWarnings([]);
    setResult(null);
    setError(null);
  };

  const downloadUrl = (token) => `${API_BASE}/api/download/${token}`;

  return (
    <div className="min-h-screen w-full bg-[#F7F8FA] flex items-start justify-center py-10 px-4" style={{ fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif" }}>
      <div className="w-full max-w-xl">
        {/* Header */}
        <div className="flex items-center gap-2.5 mb-6">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-[#C0392B] text-white">
            <ScanLine size={18} strokeWidth={2.25} />
          </div>
          <div>
            <div className="text-[15px] font-semibold text-[#101826]">KADR.CZ</div>
            <div className="text-[11.5px] text-slate-500">Rychlé vyplnění dokumentů</div>
          </div>
        </div>

        {/* Step tracker */}
        <div className="flex items-center gap-2 mb-6">
          {["Nahrát", "Rozpoznání", "Vyplnit", "Hotovo"].map((label, i) => {
            const n = i + 1;
            const state = step > n ? "done" : step === n ? "active" : "todo";
            return (
              <div key={label} className="flex items-center gap-2 flex-1">
                <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-medium
                  ${state === "done" ? "bg-emerald-500 text-white" : state === "active" ? "bg-[#101826] text-white" : "bg-slate-200 text-slate-400"}`}>
                  {state === "done" ? <Check size={12} /> : n}
                </div>
                <span className={`text-[11.5px] ${state === "todo" ? "text-slate-400" : "text-[#101826] font-medium"} hidden sm:inline`}>{label}</span>
                {n < 4 && <div className="flex-1 h-px bg-slate-200" />}
              </div>
            );
          })}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          {error && (
            <div className="m-5 mb-0 flex items-start gap-2 rounded-lg bg-red-50 p-3 text-[12.5px] text-red-700">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
            </div>
          )}

          {/* Step 1: upload */}
          {step === 1 && (
            <div className="p-7">
              <h2 className="text-[16px] font-semibold text-[#101826]">Nahrajte doklad</h2>
              <p className="mt-1 text-[13px] text-slate-500">
                Pas, ID karta, povolení k pobytu — systém rozpozná a předvyplní údaje automaticky.
              </p>

              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); handleFile(e.dataTransfer.files?.[0]); }}
                className="mt-5 flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-slate-200 bg-slate-50/50 py-12 cursor-pointer hover:border-slate-300 hover:bg-slate-50 transition-colors"
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white border border-slate-200">
                  <Upload size={18} className="text-slate-400" />
                </div>
                <div className="text-center">
                  <div className="text-[13px] font-medium text-[#101826]">Přetáhněte soubor nebo klikněte</div>
                  <div className="text-[11.5px] text-slate-400 mt-0.5">JPG, PNG, HEIC, PDF</div>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".jpg,.jpeg,.png,.heic,.pdf"
                  className="hidden"
                  onChange={(e) => handleFile(e.target.files?.[0])}
                />
              </div>

              <button
                onClick={skipUpload}
                className="mt-4 w-full text-center text-[12.5px] text-slate-500 hover:text-[#101826] py-1"
              >
                Přeskočit a vyplnit ručně →
              </button>
            </div>
          )}

          {/* Step 2: scanning */}
          {step === 2 && (
            <div className="p-7">
              <div className="flex flex-col items-center justify-center gap-4 py-14">
                <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-50 border border-slate-200 overflow-hidden">
                  <FileText size={26} className="text-slate-300" />
                  <div className="absolute left-0 right-0 h-0.5 bg-[#C0392B]/70 animate-[scan_1.6s_ease-in-out_infinite]" />
                </div>
                <div className="flex items-center gap-2 text-[13px] font-medium text-[#101826]">
                  <Loader2 size={14} className="animate-spin text-slate-400" /> Rozpoznávám dokument…
                </div>
              </div>
              <style>{`@keyframes scan { 0% { top: 4px; } 50% { top: 60px; } 100% { top: 4px; } }`}</style>
            </div>
          )}

          {/* Step 3: form */}
          {step === 3 && (
            <div className="p-7">
              {ocrMode === "mock" && (
                <div className="mb-4 flex items-center justify-between rounded-lg bg-emerald-50 px-3 py-2">
                  <span className="text-[12px] text-emerald-700 font-medium">Údaje rozpoznány (demo data)</span>
                </div>
              )}
              {warnings.length > 0 && (
                <div className="mb-4 space-y-2">
                  {warnings.map((w, i) => (
                    <div key={i} className="flex items-start gap-2 rounded-lg bg-amber-50 p-2.5 text-[12px] text-amber-700">
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {w}
                    </div>
                  ))}
                </div>
              )}

              {rawText && rawText.trim() && (
                <details className="mb-4 rounded-lg border border-slate-200 bg-slate-50/60">
                  <summary className="cursor-pointer px-3 py-2 text-[12px] font-medium text-slate-600">
                    Zobrazit rozpoznaný text z dokumentu (pro ruční kopírování)
                  </summary>
                  <textarea
                    readOnly
                    value={rawText}
                    className="w-full h-24 px-3 py-2 text-[11.5px] font-mono text-slate-600 bg-white border-t border-slate-200 resize-none focus:outline-none"
                  />
                </details>
              )}

              <div className="mb-4">
                <label className="text-[11px] uppercase tracking-wide text-slate-400">Typ dokumentu</label>
                <select
                  value={templateId || ""}
                  onChange={(e) => setTemplateId(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2.5 text-[13.5px] text-[#101826] focus:outline-none focus:ring-2 focus:ring-[#101826]/10"
                >
                  {blanks.map((b) => (
                    <option key={b.id} value={b.id}>{b.title}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-x-4 gap-y-3 max-h-[360px] overflow-y-auto pr-1">
                {FIELD_DEFS.map(([key, label]) => (
                  <label key={key} className="block">
                    <span className="text-[11px] uppercase tracking-wide text-slate-400">{label}</span>
                    <input
                      value={fields[key] || ""}
                      onChange={(e) => setFields((f) => ({ ...f, [key]: e.target.value }))}
                      className="mt-1 w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] text-[#101826] focus:outline-none focus:ring-2 focus:ring-[#101826]/10 focus:border-slate-300"
                    />
                  </label>
                ))}
              </div>

              <div className="mt-6 flex justify-between items-center">
                <button onClick={() => setStep(1)} className="inline-flex items-center gap-1.5 text-[13px] text-slate-500 hover:text-[#101826]">
                  <ArrowLeft size={14} /> Zpět
                </button>
                <button
                  onClick={handleGenerate}
                  disabled={loading || !templateId}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#C0392B] px-5 py-2.5 text-[13px] font-medium text-white hover:bg-[#A93226] disabled:opacity-60"
                >
                  {loading ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
                  {loading ? "Generuji…" : "Vytvořit dokument"}
                </button>
              </div>
            </div>
          )}

          {/* Step 4: done */}
          {step === 4 && result && (
            <div className="p-8 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500 text-white">
                <Check size={24} />
              </div>
              <h2 className="mt-4 text-[16px] font-semibold text-[#101826]">Dokument je hotový</h2>
              <p className="mt-1 text-[13px] text-slate-500">Stáhněte si soubor nebo ho rovnou vytiskněte.</p>

              <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <a
                  href={downloadUrl(result.docx_token)}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-4 py-3 text-[13px] font-medium text-slate-700 hover:bg-slate-50"
                >
                  <Download size={15} /> Stáhnout Word
                </a>
                {result.pdf_token && (
                  <a
                    href={downloadUrl(result.pdf_token)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-4 py-3 text-[13px] font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <Printer size={15} /> Otevřít / Tisk (PDF)
                  </a>
                )}
                <button
                  onClick={reset}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#101826] px-4 py-3 text-[13px] font-medium text-white hover:bg-[#1C2A3F]"
                >
                  <RotateCcw size={15} /> Nový dokument
                </button>
              </div>
            </div>
          )}
        </div>

        <p className="mt-4 text-center text-[11.5px] text-slate-400">
          Žádná data se neukládají — vše probíhá jednorázově.
        </p>
      </div>
    </div>
  );
}
