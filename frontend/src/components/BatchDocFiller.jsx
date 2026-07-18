import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, FileText, Loader2, Plus, Upload, X } from "lucide-react";
import CompanyPicker from "./CompanyPicker";
import PersonCard from "./PersonCard";
import {
  FIELD_DEFS, PERSON_FIELD_KEYS, COMPANY_FIELD_KEYS, isFieldRelevant, DEFAULT_SALARY_BY_TEMPLATE,
} from "../constants/fields";
import { composeCzAddress, composeOriginAddress } from "../utils/address";
import { API_BASE, describeRequestError, uploadFileViaXHR } from "../utils/api";
import { paceRateLimit, runWithRetry, estimateSecondsRemaining } from "../utils/rateLimitQueue";

// Same accent used by SimpleDocFiller/LoginForm's own primary buttons —
// redefined locally rather than imported, matching how LoginForm.jsx
// already does the same (SimpleDocFiller.jsx doesn't export it).
const PRIMARY_GRADIENT = { background: "var(--gradient-primary)" };

const MAX_BATCH_FILES = 25;

const EMPTY_PERSON_FIELDS = {
  first_name: "", last_name: "", birth_date: "", doc_number: "",
  visa_number: "", visa_validity: "", residence_type: "",
};
const EMPTY_COMPANY = { name: "", ico: "", dic: "", address: "", representative: "" };

function makePersonCard(file) {
  const isImage = typeof file.type === "string" && file.type.startsWith("image/");
  return {
    id: crypto.randomUUID(),
    file,
    previewUrl: isImage ? URL.createObjectURL(file) : null,
    fileName: file.name,
    status: "pending", // pending | recognizing | done | error
    error: null,
    fields: { ...EMPTY_PERSON_FIELDS },
    docNumberVerified: false,
    warnings: [],
    rawText: "",
    ocrMode: null,
    czAddressParts: {},
    originCountry: "ua",
    originAddressParts: {},
    companyOverrideEnabled: false,
    companyOverride: { ...EMPTY_COMPANY },
    startDateOverrideEnabled: false,
    startDateOverride: "",
    generation: { status: "idle", docxToken: null, pdfToken: null, error: null },
  };
}

// One photo = one person here (unlike single mode, where several photos of
// the *same* person get merged into one profile) — so a recognized result
// maps straight onto its own card with no cross-file reconciliation needed.
function applyRecognizedResult(person, result) {
  const warnings = [...(result.warnings || [])];
  if (result.address) {
    warnings.push(
      `V dokumentu byl nalezen možný adresní text: „${result.address}" — zkontrolujte a případně zkopírujte ručně, automaticky se nevyplňuje.`
    );
  }
  return {
    ...person,
    status: "done",
    fields: {
      first_name: (result.first_name || "").toUpperCase(),
      last_name: (result.last_name || "").toUpperCase(),
      birth_date: result.birth_date || "",
      doc_number: result.doc_number || "",
      visa_number: result.visa_number || "",
      visa_validity: result.visa_validity || "",
      residence_type: "",
    },
    docNumberVerified: Boolean(result.doc_number_verified),
    warnings,
    rawText: result.ocr_raw_text || "",
    ocrMode: result.ocr_mode || null,
  };
}

export default function BatchDocFiller({ apiFetch, authHeader, blanks, onAuthExpired }) {
  const [people, setPeople] = useState([]);
  const [templateId, setTemplateId] = useState(null);
  const [sharedFields, setSharedFields] = useState({});
  const [batchError, setBatchError] = useState(null);

  const [recognizeActive, setRecognizeActive] = useState(false);
  const [recognizeStats, setRecognizeStats] = useState({ total: 0, done: 0 });
  const [generateActive, setGenerateActive] = useState(false);
  const [generateStats, setGenerateStats] = useState({ total: 0, done: 0 });

  const fileInputRef = useRef(null);
  const peopleRef = useRef(people);
  const peopleCountRef = useRef(0); // mirrors people.length synchronously (state updates are async) for the 25-file cap check
  const recognizeQueueRef = useRef([]); // [{id, file}] not yet sent
  const isRecognizingRef = useRef(false);
  const recognizeStartTimesRef = useRef([]);
  const isGeneratingRef = useRef(false);
  const fillStartTimesRef = useRef([]);

  useEffect(() => { peopleRef.current = people; }, [people]);

  useEffect(() => {
    if (!templateId && blanks.length > 0) setTemplateId(blanks[0].id);
  }, [blanks, templateId]);

  // Revoke every card's thumbnail blob URL if this component itself ever
  // unmounts — it's kept alive (hidden, not unmounted) while the person
  // just tabs between single/batch mode, so this mainly matters if the
  // whole page navigates away.
  useEffect(() => () => {
    peopleRef.current.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl));
  }, []);

  const updatePerson = useCallback((id, updater) => {
    setPeople((prev) => prev.map((p) => (p.id === id ? updater(p) : p)));
  }, []);

  const removePerson = useCallback((id) => {
    setPeople((prev) => {
      const removed = prev.find((p) => p.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
    peopleCountRef.current = Math.max(0, peopleCountRef.current - 1);
    recognizeQueueRef.current = recognizeQueueRef.current.filter((item) => item.id !== id);
  }, []);

  // Sequential, rate-limit-paced worker. Re-entrant-safe: if it's already
  // running when more files get pushed onto recognizeQueueRef (via "+
  // Přidat další"), this call just returns — the running loop below picks
  // the new items up on its next iteration since it re-checks the queue's
  // *current* length each time rather than snapshotting it once.
  const runRecognizeQueue = useCallback(async () => {
    if (isRecognizingRef.current) return;
    isRecognizingRef.current = true;
    setRecognizeActive(true);
    while (recognizeQueueRef.current.length > 0) {
      const item = recognizeQueueRef.current.shift();
      updatePerson(item.id, (p) => ({ ...p, status: "recognizing" }));
      await paceRateLimit(recognizeStartTimesRef);
      try {
        const result = await runWithRetry(() => uploadFileViaXHR(`${API_BASE}/api/recognize`, item.file, authHeader));
        updatePerson(item.id, (p) => applyRecognizedResult(p, result));
      } catch (e) {
        if (e.status === 401) {
          onAuthExpired();
        } else {
          const message = e.message === "timeout"
            ? "Rozpoznávání trvalo příliš dlouho (přes 90 s) — zkuste tuto fotografii nahrát znovu."
            : describeRequestError(e.status, "Rozpoznání se nezdařilo.");
          updatePerson(item.id, (p) => ({ ...p, status: "error", error: message }));
        }
      }
      setRecognizeStats((s) => ({ ...s, done: s.done + 1 }));
    }
    isRecognizingRef.current = false;
    setRecognizeActive(false);
    setRecognizeStats({ total: 0, done: 0 });
  }, [authHeader, onAuthExpired, updatePerson]);

  const addFiles = useCallback((fileList) => {
    const incoming = Array.from(fileList || []).filter(Boolean);
    if (incoming.length === 0) return;

    const remainingSlots = MAX_BATCH_FILES - peopleCountRef.current;
    if (remainingSlots <= 0) {
      setBatchError(
        `Dosažen limit ${MAX_BATCH_FILES} osob v jedné dávce — odeberte prosím některé karty, nebo dávku nejdřív vygenerujte.`
      );
      return;
    }

    let accepted = incoming;
    if (incoming.length > remainingSlots) {
      accepted = incoming.slice(0, remainingSlots);
      setBatchError(
        `Lze nahrát maximálně ${MAX_BATCH_FILES} osob najednou (včetně již přidaných) — přidáno ${accepted.length}, ${incoming.length - remainingSlots} přeskočeno.`
      );
    } else {
      setBatchError(null);
    }

    const newCards = accepted.map(makePersonCard);
    peopleCountRef.current += newCards.length;
    setPeople((prev) => [...prev, ...newCards]);
    recognizeQueueRef.current.push(...newCards.map((c) => ({ id: c.id, file: c.file })));
    setRecognizeStats((s) => ({
      total: (isRecognizingRef.current ? s.total : 0) + newCards.length,
      done: isRecognizingRef.current ? s.done : 0,
    }));
    runRecognizeQueue();
  }, [runRecognizeQueue]);

  // ---------------------------------------------------------------- shared fields
  const relevantFields = useMemo(
    () => FIELD_DEFS.filter(([, , scope]) => isFieldRelevant(scope, templateId)),
    [templateId]
  );
  const companyReqFields = useMemo(
    () => relevantFields.filter(([key]) => COMPANY_FIELD_KEYS.has(key)),
    [relevantFields]
  );
  const restFields = useMemo(
    () => relevantFields.filter(([key]) => !PERSON_FIELD_KEYS.has(key) && !COMPANY_FIELD_KEYS.has(key)),
    [relevantFields]
  );

  const sharedCompanyFields = useMemo(() => ({
    name: sharedFields.company_name || "",
    ico: sharedFields.company_ico || "",
    dic: sharedFields.company_dic || "",
    address: sharedFields.company_address || "",
    representative: sharedFields.company_representative || "",
  }), [sharedFields.company_name, sharedFields.company_ico, sharedFields.company_dic, sharedFields.company_address, sharedFields.company_representative]);

  const handleTemplateChange = (nextId) => {
    setTemplateId(nextId);
    const knownDefaults = Object.values(DEFAULT_SALARY_BY_TEMPLATE);
    const nextDefault = DEFAULT_SALARY_BY_TEMPLATE[nextId] || "";
    setSharedFields((f) => {
      const current = (f.salary || "").trim();
      if (!current || knownDefaults.includes(current)) return { ...f, salary: nextDefault };
      return f;
    });
  };

  const renderSharedField = ([key, label]) => (
    <label key={key} className="block">
      <span className="text-[11px] md:text-[12px] uppercase tracking-wide text-slate-400">{label}</span>
      <input
        value={sharedFields[key] || ""}
        onChange={(e) => setSharedFields((f) => ({ ...f, [key]: e.target.value }))}
        style={key.includes("date") ? { fontFamily: "'JetBrains Mono', monospace" } : undefined}
        className="mt-1 w-full rounded-xl border border-slate-200 px-2.5 py-1.5 md:px-3.5 md:py-3 text-[13px] md:text-[14.5px] text-[#0B1220] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10 focus:border-slate-300"
      />
    </label>
  );

  // ---------------------------------------------------------------- download
  const handleDownload = useCallback(async (token, { filename, openInNewTab } = {}) => {
    try {
      const res = await apiFetch(`/api/download/${token}`);
      if (!res.ok) {
        if (res.status !== 401) {
          setBatchError(
            res.status === 404
              ? "Tento odkaz ke stažení už byl použit (soubor se maže hned po prvním stažení). Vygenerujte dokument znovu."
              : describeRequestError(res.status, "Stažení se nezdařilo.")
          );
        }
        return;
      }
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      if (openInNewTab) {
        window.open(blobUrl, "_blank", "noopener,noreferrer");
      } else {
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = filename || token;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
    } catch {
      setBatchError("Stažení se nezdařilo — zkontrolujte připojení a zkuste to znovu.");
    }
  }, [apiFetch]);

  // ---------------------------------------------------------------- generate all
  const buildFillPayload = useCallback((person) => {
    const company = person.companyOverrideEnabled ? person.companyOverride : sharedCompanyFields;
    const startDate = person.startDateOverrideEnabled ? person.startDateOverride : (sharedFields.start_date || "");
    return {
      template_id: templateId,
      first_name: person.fields.first_name,
      last_name: person.fields.last_name,
      birth_date: person.fields.birth_date,
      doc_number: person.fields.doc_number,
      visa_number: person.fields.visa_number,
      visa_validity: person.fields.visa_validity,
      residence_type: person.fields.residence_type,
      address: composeCzAddress(person.czAddressParts),
      address_origin: composeOriginAddress(person.originCountry, person.originAddressParts),
      company_name: company.name,
      company_ico: company.ico,
      company_dic: company.dic,
      company_address: company.address,
      company_representative: company.representative,
      start_date: startDate,
      position: sharedFields.position || "",
      workplace: sharedFields.workplace || "",
      salary: sharedFields.salary || "",
      hours_per_week: sharedFields.hours_per_week || "",
      end_date: sharedFields.end_date || "",
      bank_account: sharedFields.bank_account || "",
      signing_place: sharedFields.signing_place || "",
      termination_reason: sharedFields.termination_reason || "",
      last_working_day: sharedFields.last_working_day || "",
      pay_period: sharedFields.pay_period || "",
      gross_salary: sharedFields.gross_salary || "",
      health_insurance: sharedFields.health_insurance || "",
      social_insurance: sharedFields.social_insurance || "",
      income_tax: sharedFields.income_tax || "",
      net_salary: sharedFields.net_salary || "",
    };
  }, [templateId, sharedFields, sharedCompanyFields]);

  const handleGenerateAll = useCallback(async () => {
    if (isGeneratingRef.current || !templateId || people.length === 0) return;
    isGeneratingRef.current = true;
    setGenerateActive(true);
    // Snapshot ids up front — a card added mid-run (via "+ Přidat další")
    // shouldn't be silently swept into a generation pass already in
    // progress; it'll just wait for the next "Vygenerovat" click.
    const ids = peopleRef.current.map((p) => p.id);
    setGenerateStats({ total: ids.length, done: 0 });
    for (const id of ids) {
      updatePerson(id, (p) => ({ ...p, generation: { status: "generating", docxToken: null, pdfToken: null, error: null } }));
      await paceRateLimit(fillStartTimesRef);
      const person = peopleRef.current.find((p) => p.id === id);
      if (person) {
        // Card still exists — actually generate it. (If it was removed
        // mid-run, there's nothing to submit; the stats update below
        // still fires either way so the progress bar never gets stuck
        // short of its own total.)
        try {
          const data = await runWithRetry(async () => {
            const res = await apiFetch("/api/fill", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(buildFillPayload(person)),
            });
            if (!res.ok) {
              const err = new Error("server error");
              err.status = res.status;
              throw err;
            }
            return res.json();
          });
          updatePerson(id, (p) => ({
            ...p,
            generation: { status: "done", docxToken: data.docx_token, pdfToken: data.pdf_token, error: null },
          }));
        } catch (e) {
          if (e.status !== 401) {
            updatePerson(id, (p) => ({
              ...p,
              generation: { status: "error", docxToken: null, pdfToken: null, error: describeRequestError(e.status, "Generování se nezdařilo.") },
            }));
          }
        }
      }
      setGenerateStats((s) => ({ ...s, done: s.done + 1 }));
    }
    isGeneratingRef.current = false;
    setGenerateActive(false);
  }, [templateId, people.length, apiFetch, buildFillPayload, updatePerson]);

  const recognizeRemaining = recognizeStats.total - recognizeStats.done;
  const generateRemaining = generateStats.total - generateStats.done;

  return (
    <div className="p-7 md:p-9">
      <h2 className="text-[19px] font-semibold text-[#0B1220]" style={{ fontFamily: "'Barlow', sans-serif" }}>
        Hromadné zpracování více osob
      </h2>
      <p className="mt-1 text-[13px] text-slate-500">
        Nahrajte fotografie více dokladů najednou — jedna fotografie odpovídá
        jedné osobě. Firma a datum nástupu se nastaví jednou pro celou dávku
        (lze u konkrétní osoby přepsat), ostatní údaje se rozpoznají a
        upravují nezávisle pro každou kartu.
      </p>

      {batchError && (
        <div className="mt-5 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-[12.5px] text-amber-700">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="flex-1">{batchError}</span>
          <button type="button" onClick={() => setBatchError(null)} className="shrink-0 text-amber-600 hover:text-amber-800">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Shared, batch-wide settings */}
      <div className="mt-6 space-y-4">
        <div>
          <label className="text-[11px] md:text-[12px] uppercase tracking-wide text-slate-400">Typ dokumentu (pro celou dávku)</label>
          <select
            value={templateId || ""}
            onChange={(e) => handleTemplateChange(e.target.value)}
            className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 md:px-4 md:py-3.5 text-[13.5px] md:text-[15px] text-[#0B1220] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
          >
            {blanks.map((b) => (
              <option key={b.id} value={b.id}>{b.title}</option>
            ))}
          </select>
        </div>

        <CompanyPicker company={sharedCompanyFields} setFields={setSharedFields} apiFetch={apiFetch} />
        <div className="grid grid-cols-2 gap-x-4 gap-y-4">
          {companyReqFields.map(renderSharedField)}
        </div>
        {restFields.length > 0 && (
          <div className="grid grid-cols-2 gap-x-4 gap-y-4">
            {restFields.map(renderSharedField)}
          </div>
        )}
      </div>

      {/* Upload */}
      <div className="mt-7">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".jpg,.jpeg,.png,.heic,.pdf"
          className="hidden"
          onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
        />
        {people.length === 0 ? (
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
            className="flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-slate-200 bg-slate-50/50 py-10 cursor-pointer hover:border-slate-300 hover:bg-slate-50 transition-colors"
          >
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white border border-slate-200">
              <Upload size={18} className="text-slate-400" />
            </div>
            <div className="text-center">
              <div className="text-[13px] font-medium text-[#0B1220]">Přetáhněte fotografie více osob nebo klikněte</div>
              <div className="text-[11.5px] text-slate-400 mt-0.5">JPG, PNG, HEIC, PDF · jedna fotografie = jedna osoba · max {MAX_BATCH_FILES} v dávce</div>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-xl border border-dashed border-slate-300 px-3.5 py-2 text-[12.5px] font-medium text-slate-600 hover:border-slate-400 hover:bg-slate-50"
            >
              <Plus size={14} /> Přidat další osoby
            </button>
            <span className="text-[11px] text-slate-400">{people.length} / {MAX_BATCH_FILES}</span>
          </div>
        )}
      </div>

      {/* Recognize queue progress */}
      {recognizeActive && recognizeStats.total > 0 && (
        <div className="mt-5 rounded-xl bg-slate-50 border border-slate-200 px-3.5 py-3 flex items-center gap-3">
          <Loader2 size={15} className="animate-spin text-slate-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-[12.5px] font-medium text-[#0B1220]">Rozpoznáno {recognizeStats.done} z {recognizeStats.total}</div>
            <div className="h-1 mt-1.5 rounded-full bg-slate-200 overflow-hidden">
              <div
                className="h-full bg-[#185FA5] transition-[width]"
                style={{ width: `${(recognizeStats.done / recognizeStats.total) * 100}%` }}
              />
            </div>
          </div>
          <span className="text-[11px] text-slate-400 shrink-0">~{estimateSecondsRemaining(recognizeRemaining)} s zbývá</span>
        </div>
      )}

      {/* Person cards */}
      {people.length > 0 && (
        <div className="mt-6 space-y-4">
          {people.map((person, i) => (
            <PersonCard
              key={person.id}
              person={person}
              index={i}
              sharedCompany={sharedCompanyFields}
              sharedStartDate={sharedFields.start_date || ""}
              onDownload={handleDownload}
              onRemove={() => removePerson(person.id)}
              onUpdateFields={(patch) => updatePerson(person.id, (p) => ({ ...p, fields: { ...p.fields, ...patch } }))}
              onUpdateCzPart={(key, value) => updatePerson(person.id, (p) => ({ ...p, czAddressParts: { ...p.czAddressParts, [key]: value } }))}
              onUpdateOriginPart={(key, value) => updatePerson(person.id, (p) => ({ ...p, originAddressParts: { ...p.originAddressParts, [key]: value } }))}
              onSetOriginCountry={(country) => updatePerson(person.id, (p) => ({ ...p, originCountry: country, originAddressParts: {} }))}
              onToggleCompanyOverride={() => updatePerson(person.id, (p) => (
                p.companyOverrideEnabled
                  ? { ...p, companyOverrideEnabled: false, companyOverride: { ...EMPTY_COMPANY } }
                  : { ...p, companyOverrideEnabled: true, companyOverride: { ...sharedCompanyFields } }
              ))}
              onUpdateCompanyOverrideField={(key, value) => updatePerson(person.id, (p) => ({ ...p, companyOverride: { ...p.companyOverride, [key]: value } }))}
              onToggleStartDateOverride={() => updatePerson(person.id, (p) => (
                p.startDateOverrideEnabled
                  ? { ...p, startDateOverrideEnabled: false, startDateOverride: "" }
                  : { ...p, startDateOverrideEnabled: true, startDateOverride: sharedFields.start_date || "" }
              ))}
              onUpdateStartDateOverride={(value) => updatePerson(person.id, (p) => ({ ...p, startDateOverride: value }))}
            />
          ))}
        </div>
      )}

      {/* Generate all */}
      {people.length > 0 && (
        <div className="mt-8">
          {generateActive && generateStats.total > 0 && (
            <div className="mb-3 rounded-xl bg-slate-50 border border-slate-200 px-3.5 py-3 flex items-center gap-3">
              <Loader2 size={15} className="animate-spin text-slate-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] font-medium text-[#0B1220]">Generuji {generateStats.done} z {generateStats.total}</div>
                <div className="h-1 mt-1.5 rounded-full bg-slate-200 overflow-hidden">
                  <div
                    className="h-full bg-[#185FA5] transition-[width]"
                    style={{ width: `${(generateStats.done / generateStats.total) * 100}%` }}
                  />
                </div>
              </div>
              <span className="text-[11px] text-slate-400 shrink-0">~{estimateSecondsRemaining(generateRemaining)} s zbývá</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11.5px] text-slate-400">{people.length} osob v dávce</span>
            <button
              type="button"
              onClick={handleGenerateAll}
              disabled={generateActive || recognizeActive || !templateId}
              style={PRIMARY_GRADIENT}
              className="inline-flex items-center gap-1.5 rounded-xl px-5 py-2.5 md:px-7 md:py-3.5 text-[13px] md:text-[14.5px] font-medium text-white transition-[filter] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {generateActive ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
              {generateActive ? `Generuji ${generateStats.done} z ${generateStats.total}…` : `Vygenerovat všech ${people.length} smluv`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
