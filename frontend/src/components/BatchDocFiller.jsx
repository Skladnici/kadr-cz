import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, FileText, Loader2, Upload, X } from "lucide-react";
import CompanyPicker from "./CompanyPicker";
import PersonCard from "./PersonCard";
import {
  FIELD_DEFS, PERSON_FIELD_KEYS, COMPANY_FIELD_KEYS, isFieldRelevant, DEFAULT_SALARY_BY_TEMPLATE,
} from "../constants/fields";
import { composeCzAddress, composeOriginAddress } from "../utils/address";
import { mergeRecognizedResults } from "../utils/recognizeMerge";
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

// One card can be backed by *several* files (e.g. a passport photo plus a
// visa sticker for the same person) — mirroring single mode, where
// everything staged before clicking "Rozpoznat a pokračovat" belongs to
// one person. previewUrl is just the first image among them, used as the
// card's thumbnail; fileNames lists all of them for the card's subtitle.
function makePersonCard(files, previewUrl, fileNames) {
  return {
    id: crypto.randomUUID(),
    files,
    previewUrl,
    fileName: fileNames,
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

export default function BatchDocFiller({ apiFetch, authHeader, blanks, onAuthExpired }) {
  const [people, setPeople] = useState([]);
  const [templateId, setTemplateId] = useState(null);
  const [sharedFields, setSharedFields] = useState({});
  const [batchError, setBatchError] = useState(null);

  // Staged files for the person currently being added — the batch
  // equivalent of single mode's own pendingFiles/previewUrls at step 1.
  // Nothing is sent to the server until "Rozpoznat a přidat osobu" is
  // clicked, so a passport + visa pair can be selected together first.
  const [stagedFiles, setStagedFiles] = useState([]);
  const [stagedPreviews, setStagedPreviews] = useState([]);

  const [recognizeActive, setRecognizeActive] = useState(false);
  const [recognizeStats, setRecognizeStats] = useState({ total: 0, done: 0 });
  const [generateActive, setGenerateActive] = useState(false);
  const [generateStats, setGenerateStats] = useState({ total: 0, done: 0 });

  const fileInputRef = useRef(null);
  const peopleRef = useRef(people);
  const peopleCountRef = useRef(0); // mirrors people.length synchronously (state updates are async) for the 25-person cap check
  const recognizeQueueRef = useRef([]); // [{id, files}] — one entry per person, not per file
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
    recognizeQueueRef.current = recognizeQueueRef.current.filter((job) => job.id !== id);
  }, []);

  // Sequential, rate-limit-paced worker — one *person* (job) at a time,
  // and within a job, one file at a time (so a passport+visa pair for the
  // same person still only ever fires one /api/recognize request at
  // once). Re-entrant-safe: if it's already running when another person
  // gets added, this call just returns — the running loop picks the new
  // job up on its next iteration since it re-checks the queue's current
  // length each time rather than snapshotting it once.
  const runRecognizeQueue = useCallback(async () => {
    if (isRecognizingRef.current) return;
    isRecognizingRef.current = true;
    setRecognizeActive(true);
    while (recognizeQueueRef.current.length > 0) {
      const job = recognizeQueueRef.current.shift();
      updatePerson(job.id, (p) => ({ ...p, status: "recognizing" }));

      const results = [];
      const fileErrors = [];
      for (const file of job.files) {
        await paceRateLimit(recognizeStartTimesRef);
        try {
          const result = await runWithRetry(() => uploadFileViaXHR(`${API_BASE}/api/recognize`, file, authHeader));
          results.push(result);
        } catch (e) {
          if (e.status === 401) {
            onAuthExpired();
          } else {
            const reason = e.message === "timeout"
              ? "rozpoznávání trvalo příliš dlouho"
              : e.status >= 500 ? "chyba serveru"
              : e.status === 400 ? "nepodporovaný nebo poškozený soubor"
              : "rozpoznání se nezdařilo";
            fileErrors.push(`„${file.name}" (${reason})`);
          }
        }
        setRecognizeStats((s) => ({ ...s, done: s.done + 1 }));
      }

      if (results.length > 0) {
        // Same reconciliation single mode uses for "several files, one
        // person" — a passport and a visa for the same person merge into
        // one set of identity fields here exactly as they would there.
        const merged = mergeRecognizedResults(results);
        const failureWarning = fileErrors.length > 0
          ? [`Nepodařilo se rozpoznat: ${fileErrors.join(", ")} — zkontrolujte prosím ručně, ostatní soubory této osoby byly rozpoznány.`]
          : [];
        updatePerson(job.id, (p) => ({
          ...p,
          status: "done",
          fields: {
            first_name: merged.fields.first_name,
            last_name: merged.fields.last_name,
            birth_date: merged.fields.birth_date,
            doc_number: merged.fields.doc_number,
            visa_number: merged.fields.visa_number,
            visa_validity: merged.fields.visa_validity,
            residence_type: "",
          },
          docNumberVerified: merged.docNumberVerified,
          warnings: [...merged.warnings, ...failureWarning],
          rawText: merged.rawText,
          ocrMode: merged.ocrMode,
        }));
      } else {
        updatePerson(job.id, (p) => ({
          ...p,
          status: "error",
          error: `Rozpoznání se nezdařilo pro: ${fileErrors.join(", ")}.`,
        }));
      }
    }
    isRecognizingRef.current = false;
    setRecognizeActive(false);
    setRecognizeStats({ total: 0, done: 0 });
  }, [authHeader, onAuthExpired, updatePerson]);

  // ---------------------------------------------------------------- staging (current person's files)
  const addStagedFiles = useCallback((fileList) => {
    const files = Array.from(fileList || []).filter(Boolean);
    if (files.length === 0) return;
    const previews = files.map((f) => {
      const isHeic = /heic|heif/i.test(f.type) || /\.hei[cf]$/i.test(f.name);
      const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
      return {
        name: f.name,
        isPdf,
        isHeic,
        url: !isPdf && !isHeic && f.type.startsWith("image/") ? URL.createObjectURL(f) : null,
      };
    });
    setStagedFiles((prev) => [...prev, ...files]);
    setStagedPreviews((prev) => [...prev, ...previews]);
  }, []);

  const removeStagedFile = useCallback((index) => {
    setStagedPreviews((prev) => {
      const removed = prev[index];
      if (removed?.url) URL.revokeObjectURL(removed.url);
      return prev.filter((_, i) => i !== index);
    });
    setStagedFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const confirmAddPerson = useCallback(() => {
    if (stagedFiles.length === 0) return;
    if (peopleCountRef.current >= MAX_BATCH_FILES) {
      setBatchError(
        `Dosažen limit ${MAX_BATCH_FILES} osob v jedné dávce — odeberte prosím některé karty, nebo dávku nejdřív vygenerujte.`
      );
      return;
    }
    setBatchError(null);

    const files = stagedFiles;
    const previews = stagedPreviews;
    const previewUrl = previews.find((p) => p.url)?.url || null;
    // Only one preview is kept as the card's thumbnail — revoke the rest
    // right away instead of leaking them.
    previews.forEach((p) => { if (p.url && p.url !== previewUrl) URL.revokeObjectURL(p.url); });

    const card = makePersonCard(files, previewUrl, previews.map((p) => p.name).join(", "));
    peopleCountRef.current += 1;
    setPeople((prev) => [...prev, card]);
    recognizeQueueRef.current.push({ id: card.id, files });
    setRecognizeStats((s) => ({
      total: (isRecognizingRef.current ? s.total : 0) + files.length,
      done: isRecognizingRef.current ? s.done : 0,
    }));
    runRecognizeQueue();

    setStagedFiles([]);
    setStagedPreviews([]);
  }, [stagedFiles, stagedPreviews, runRecognizeQueue]);

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
    // Snapshot ids up front — a card added mid-run shouldn't be silently
    // swept into a generation pass already in progress; it'll just wait
    // for the next "Vygenerovat" click.
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
        Stejný postup jako u jedné osoby, jen opakovaný pro každého člověka:
        nahrajte doklady jedné osoby (klidně pas i vízum najednou), nechte je
        rozpoznat a přidejte jako kartu. Pak pokračujte další osobou. Firmu,
        typ dokumentu a další společné údaje vyplníte jednou pro celou dávku
        až na konci.
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

      {/* 1. Upload — same staging pattern as single mode's step 1: stage
          one person's file(s), then confirm to recognize + add a card. */}
      <div className="mt-6">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".jpg,.jpeg,.png,.heic,.pdf"
          className="hidden"
          onChange={(e) => { addStagedFiles(e.target.files); e.target.value = ""; }}
        />
        <div
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); addStagedFiles(e.dataTransfer.files); }}
          className="flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-slate-200 bg-slate-50/50 py-9 cursor-pointer hover:border-slate-300 hover:bg-slate-50 transition-colors"
        >
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white border border-slate-200">
            <Upload size={18} className="text-slate-400" />
          </div>
          <div className="text-center">
            <div className="text-[13px] font-medium text-[#0B1220]">Přetáhněte doklady jedné osoby nebo klikněte</div>
            <div className="text-[11.5px] text-slate-400 mt-0.5">JPG, PNG, HEIC, PDF · pas + vízum téže osoby nahrajte společně</div>
          </div>
        </div>

        {stagedPreviews.length > 0 && (
          <div className="mt-[18px] flex gap-2 flex-wrap">
            {stagedPreviews.map((p, i) => (
              <div key={i} className="relative w-16 h-16 rounded-xl border border-slate-200 overflow-hidden bg-slate-50 shrink-0 group">
                {p.url ? (
                  <img src={p.url} alt={p.name} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-slate-400">
                    <FileText size={18} />
                    <span className="text-[8px] leading-none">{p.isPdf ? "PDF" : "HEIC"}</span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => removeStagedFile(i)}
                  className="absolute top-0.5 right-0.5 flex h-4.5 w-4.5 items-center justify-center rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Odebrat"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="mt-[18px] flex items-center gap-3">
          <button
            type="button"
            onClick={confirmAddPerson}
            disabled={stagedFiles.length === 0}
            style={PRIMARY_GRADIENT}
            className="inline-flex items-center gap-1.5 rounded-xl px-5 py-2.5 text-[13px] font-medium text-white transition-[filter] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Rozpoznat a přidat osobu <ArrowRight size={14} />
          </button>
          <span className="text-[11px] text-slate-400">{people.length} / {MAX_BATCH_FILES} osob v dávce</span>
        </div>
      </div>

      {/* Recognize queue progress */}
      {recognizeActive && recognizeStats.total > 0 && (
        <div className="mt-5 rounded-xl bg-slate-50 border border-slate-200 px-3.5 py-3 flex items-center gap-3">
          <Loader2 size={15} className="animate-spin text-slate-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-[12.5px] font-medium text-[#0B1220]">Rozpoznáno {recognizeStats.done} z {recognizeStats.total} souborů</div>
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

      {/* 2. Person cards, in the order they were added */}
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

      {/* 3. Shared, batch-wide settings — filled in once everyone's added,
          same as single mode showing company/contract fields alongside
          the already-recognized person fields in its own step 3. */}
      {people.length > 0 && (
        <div className="mt-8 space-y-4">
          <div className="border-t border-slate-200 pt-6">
            <h3 className="text-[13px] font-medium text-[#0B1220] mb-3">Společné údaje pro celou dávku</h3>
          </div>
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
      )}

      {/* 4. Generate all */}
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
