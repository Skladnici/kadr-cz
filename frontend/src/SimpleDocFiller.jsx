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
  // "address" is handled separately below via <AddressBuilder> — not a plain text field.
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

// Common Czech cities with their postal code (PSČ) — covers the large
// majority of real addresses without needing any external lookup
// service. Smaller towns aren't in this list; the person just types the
// PSČ manually in that case, same as before.
const CZ_CITY_PSC = {
  "Praha": "100 00",
  "Praha 1": "110 00", "Praha 2": "120 00", "Praha 3": "130 00", "Praha 4": "140 00",
  "Praha 5": "150 00", "Praha 6": "160 00", "Praha 7": "170 00", "Praha 8": "180 00",
  "Praha 9": "190 00", "Praha 10": "100 00", "Praha 11": "149 00", "Praha 12": "143 00",
  "Praha 13": "155 00", "Praha 14": "198 00", "Praha 15": "109 00", "Praha 16": "165 00",
  "Praha 17": "163 00", "Praha 18": "199 00", "Praha 19": "197 00", "Praha 20": "193 00",
  "Praha 21": "190 16", "Praha 22": "104 00",
  "Brno": "602 00", "Ostrava": "702 00", "Plzeň": "301 00", "Liberec": "460 01",
  "Olomouc": "779 00", "České Budějovice": "370 01", "Hradec Králové": "500 02",
  "Ústí nad Labem": "400 01", "Pardubice": "530 02", "Zlín": "760 01",
  "Havířov": "736 01", "Kladno": "272 01", "Most": "434 01", "Opava": "746 01",
  "Frýdek-Místek": "738 01", "Karviná": "733 01", "Jihlava": "586 01",
  "Teplice": "415 01", "Děčín": "405 02", "Karlovy Vary": "360 01",
  "Chomutov": "430 01", "Jablonec nad Nisou": "466 01", "Mladá Boleslav": "293 01",
  "Prostějov": "796 01", "Přerov": "750 02", "Česká Lípa": "470 01",
  "Třebíč": "674 01", "Třinec": "739 61", "Tábor": "390 02", "Znojmo": "669 02",
  "Kolín": "280 02", "Příbram": "261 01", "Cheb": "350 02", "Trutnov": "541 01",
  "Vsetín": "755 01", "Kroměříž": "767 01", "Litoměřice": "412 01",
  "Písek": "397 01", "Uherské Hradiště": "686 01", "Šumperk": "787 01",
  "Nový Jičín": "741 01", "Chrudim": "537 01", "Klatovy": "339 01",
  "Vyškov": "682 01", "Jindřichův Hradec": "377 01", "Břeclav": "690 02",
  "Rakovník": "269 01", "Strakonice": "386 01", "Havlíčkův Brod": "580 01",
  "Hodonín": "695 01", "Bruntál": "792 01", "Vlašim": "258 01",
  "Sokolov": "356 01", "Kutná Hora": "284 01", "Beroun": "266 01",
  "Blansko": "678 01", "Louny": "440 01", "Náchod": "547 01",
  "Svitavy": "568 02", "Jičín": "506 01", "Domažlice": "344 01",
  "Rokycany": "337 01", "Litvínov": "436 01", "Krnov": "794 01",
  "Kopřivnice": "742 21", "Otrokovice": "765 02", "Valašské Meziříčí": "757 01",
  "Rychnov nad Kněžnou": "516 01", "Semily": "513 01", "Žďár nad Sázavou": "591 01",
  "Nymburk": "288 02", "Benešov": "256 01", "Kralupy nad Vltavou": "278 01",
  "Neratovice": "277 11", "Roudnice nad Labem": "413 01", "Varnsdorf": "407 47",
  "Frýdlant": "464 01", "Rumburk": "408 01", "Vrchlabí": "543 01",
  "Kadaň": "432 01", "Žatec": "438 01", "Aš": "352 01",
  "Kyjov": "697 01", "Uherský Brod": "688 01", "Hranice": "753 01",
  "Studénka": "742 13", "Orlová": "735 14", "Bohumín": "735 81",
};

function AddressBuilder({ addressCountry, setAddressCountry, addressParts, setPart }) {
  const cityMatch = addressCountry === "cz" && addressParts.city
    ? Object.keys(CZ_CITY_PSC).find((c) => c.toLowerCase() === addressParts.city.trim().toLowerCase())
    : null;

  return (
    <div className="rounded-lg border border-slate-200 p-3 bg-slate-50/40">
      <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-2">Adresa</div>

      <div className="flex gap-1.5 mb-3">
        {[
          ["cz", "Česká republika"],
          ["ua", "Ukrajina"],
          ["eu", "Jiná země EU"],
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setAddressCountry(key)}
            className={`rounded-md px-2.5 py-1 text-[11.5px] font-medium border transition-colors
              ${addressCountry === key ? "bg-[#101826] text-white border-[#101826]" : "bg-white text-slate-600 border-slate-200 hover:border-slate-300"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {addressCountry === "cz" && (
        <div className="grid grid-cols-2 gap-3">
          <label className="block col-span-2">
            <span className="text-[11px] text-slate-400">Ulice a číslo popisné</span>
            <input
              value={addressParts.street || ""}
              onChange={(e) => setPart("street", e.target.value)}
              placeholder="Vinohradská 45"
              className="mt-1 w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#101826]/10"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-slate-400">Město</span>
            <input
              list="cz-cities"
              value={addressParts.city || ""}
              onChange={(e) => {
                setPart("city", e.target.value);
                const match = Object.keys(CZ_CITY_PSC).find(
                  (c) => c.toLowerCase() === e.target.value.trim().toLowerCase()
                );
                if (match) setPart("psc", CZ_CITY_PSC[match]);
              }}
              placeholder="Praha"
              className="mt-1 w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#101826]/10"
            />
            <datalist id="cz-cities">
              {Object.keys(CZ_CITY_PSC).map((c) => <option key={c} value={c} />)}
            </datalist>
          </label>
          <label className="block">
            <span className="text-[11px] text-slate-400">
              PSČ {cityMatch && <span className="text-emerald-600">· doplněno automaticky</span>}
            </span>
            <input
              value={addressParts.psc || ""}
              onChange={(e) => setPart("psc", e.target.value)}
              placeholder="100 00"
              className="mt-1 w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#101826]/10"
            />
          </label>
        </div>
      )}

      {addressCountry === "ua" && (
        <div className="grid grid-cols-2 gap-3">
          <label className="block col-span-2">
            <span className="text-[11px] text-slate-400">Vulytsia, budynok (ulice, číslo)</span>
            <input
              value={addressParts.street || ""}
              onChange={(e) => setPart("street", e.target.value)}
              placeholder="вул. Хрещатик 10"
              className="mt-1 w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#101826]/10"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-slate-400">Misto (město)</span>
            <input
              value={addressParts.city || ""}
              onChange={(e) => setPart("city", e.target.value)}
              placeholder="Kyjev"
              className="mt-1 w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#101826]/10"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-slate-400">Oblast</span>
            <input
              value={addressParts.region || ""}
              onChange={(e) => setPart("region", e.target.value)}
              placeholder="Kyjivska oblast"
              className="mt-1 w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#101826]/10"
            />
          </label>
          <label className="block col-span-2">
            <span className="text-[11px] text-slate-400">Indeks (PSČ)</span>
            <input
              value={addressParts.psc || ""}
              onChange={(e) => setPart("psc", e.target.value)}
              placeholder="01001"
              className="mt-1 w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#101826]/10"
            />
          </label>
        </div>
      )}

      {addressCountry === "eu" && (
        <div className="grid grid-cols-2 gap-3">
          <label className="block col-span-2">
            <span className="text-[11px] text-slate-400">Ulice a číslo</span>
            <input
              value={addressParts.street || ""}
              onChange={(e) => setPart("street", e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#101826]/10"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-slate-400">Město</span>
            <input
              value={addressParts.city || ""}
              onChange={(e) => setPart("city", e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#101826]/10"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-slate-400">PSČ</span>
            <input
              value={addressParts.psc || ""}
              onChange={(e) => setPart("psc", e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#101826]/10"
            />
          </label>
          <label className="block col-span-2">
            <span className="text-[11px] text-slate-400">Země</span>
            <input
              value={addressParts.country || ""}
              onChange={(e) => setPart("country", e.target.value)}
              placeholder="Polsko, Slovensko, Německo…"
              className="mt-1 w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#101826]/10"
            />
          </label>
        </div>
      )}
    </div>
  );
}

// Splits a free-text recognized address into a street part and a postal
// code, when one can be confidently found — so the PSČ/indeks field gets
// auto-filled too, not just the street field.
function splitRecognizedAddress(raw) {
  if (!raw) return { street: "" };
  // Ukrainian postal codes: 5 digits. Czech: "NNN NN" (with or without space).
  const czMatch = raw.match(/\b(\d{3}\s?\d{2})\b/);
  const uaMatch = raw.match(/\b(\d{5})\b/);
  const match = czMatch || uaMatch;
  if (!match) return { street: raw.trim() };
  const psc = match[1].replace(/\s+/g, czMatch ? " " : "");
  const street = (raw.slice(0, match.index) + raw.slice(match.index + match[0].length))
    .replace(/[,\s]+$/, "")
    .replace(/^[,\s]+/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { street, psc };
}

function composeAddress(country, parts) {
  if (country === "cz") {
    return [parts.street, [parts.psc, parts.city].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  }
  if (country === "ua") {
    return [parts.street, parts.city, parts.region, parts.psc].filter(Boolean).join(", ");
  }
  return [parts.street, [parts.psc, parts.city].filter(Boolean).join(" "), parts.country].filter(Boolean).join(", ");
}

export default function SimpleDocFiller() {
  const [step, setStep] = useState(1); // 1 upload, 2 scanning, 3 form, 4 done
  const [fields, setFields] = useState({});
  const [addressCountry, setAddressCountry] = useState("cz");
  const [addressPartsByCountry, setAddressPartsByCountry] = useState({ cz: {}, ua: {}, eu: {} });
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

  const handleFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList || []).filter(Boolean);
    if (files.length === 0) return;
    setStep(2);
    setError(null);
    try {
      const results = [];
      for (const file of files) {
        const compressed = await compressImageInBrowser(file);
        const formData = new FormData();
        formData.append("file", compressed);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s max per file
        const res = await fetch(`${API_BASE}/api/recognize`, {
          method: "POST",
          body: formData,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!res.ok) throw new Error("server error");
        results.push(await res.json());
      }

      // Merge multiple documents (e.g. passport + visa page): for each
      // field, take the first non-empty value found across all uploaded
      // files, so missing info on one document is filled in by another.
      const pick = (key) => {
        for (const r of results) {
          if (r[key] && r[key] !== "—") return r[key];
        }
        return "";
      };

      setFields({
        first_name: pick("first_name"),
        last_name: pick("last_name"),
        birth_date: pick("birth_date"),
        nationality: pick("nationality"),
        doc_number: pick("doc_number"),
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

      const recognizedAddress = pick("address");
      const mergedNationality = pick("nationality");
      let guessedCountry = addressCountry;
      if (/ukrajin/i.test(mergedNationality)) guessedCountry = "ua";
      else if (/česk|czech/i.test(mergedNationality)) guessedCountry = "cz";
      setAddressCountry(guessedCountry);
      setAddressPartsByCountry((prev) => ({
        ...prev,
        [guessedCountry]: recognizedAddress
          ? splitRecognizedAddress(recognizedAddress)
          : prev[guessedCountry],
      }));

      setWarnings(results.flatMap((r) => r.warnings || []));
      setRawText(results.map((r, i) => `--- Soubor ${i + 1} ---\n${r.ocr_raw_text || ""}`).join("\n\n"));
      setOcrMode(results[0]?.ocr_mode);
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
    setAddressPartsByCountry({ cz: {}, ua: {}, eu: {} });
    setAddressCountry("cz");
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
        body: JSON.stringify({
          template_id: templateId,
          ...fields,
          address: composeAddress(addressCountry, addressPartsByCountry[addressCountry] || {}),
        }),
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
    setAddressPartsByCountry({ cz: {}, ua: {}, eu: {} });
    setAddressCountry("cz");
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
              <h2 className="text-[16px] font-semibold text-[#101826]">Nahrajte doklady</h2>
              <p className="mt-1 text-[13px] text-slate-500">
                Pas, ID karta, povolení k pobytu, vízum — systém rozpozná a předvyplní údaje
                automaticky. Můžete nahrát i více souborů najednou (např. pas + vízum).
              </p>

              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); handleFiles(e.dataTransfer.files); }}
                className="mt-5 flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-slate-200 bg-slate-50/50 py-12 cursor-pointer hover:border-slate-300 hover:bg-slate-50 transition-colors"
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white border border-slate-200">
                  <Upload size={18} className="text-slate-400" />
                </div>
                <div className="text-center">
                  <div className="text-[13px] font-medium text-[#101826]">Přetáhněte soubory nebo klikněte</div>
                  <div className="text-[11.5px] text-slate-400 mt-0.5">JPG, PNG, HEIC, PDF · lze vybrat více souborů najednou</div>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".jpg,.jpeg,.png,.heic,.pdf"
                  className="hidden"
                  onChange={(e) => handleFiles(e.target.files)}
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

              <div className="mb-3">
                <AddressBuilder
                  addressCountry={addressCountry}
                  setAddressCountry={setAddressCountry}
                  addressParts={addressPartsByCountry[addressCountry] || {}}
                  setPart={(key, value) =>
                    setAddressPartsByCountry((prev) => ({
                      ...prev,
                      [addressCountry]: { ...prev[addressCountry], [key]: value },
                    }))
                  }
                />
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
