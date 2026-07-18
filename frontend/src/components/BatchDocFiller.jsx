import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, FileText, Loader2, Upload, X } from "lucide-react";
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

// Every dropped/selected file becomes its own card immediately (auto-
// recognized) — the simple, predictable default. A passport + visa for
// the same person end up as two cards this way; they're re-combined
// into one either automatically (see canAutoMerge, below) when birth
// date agrees, or via "Sloučit s další kartou" on the card (see
// PersonCard) otherwise — either way through the exact same
// utils/recognizeMerge.js logic single mode uses for "several files,
// one person".
function makePersonCard(file) {
  const isHeic = /heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  return {
    id: crypto.randomUUID(),
    files: [file],
    previews: [{
      name: file.name,
      isPdf,
      isHeic,
      url: !isPdf && !isHeic && file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
    }],
    status: "pending", // pending | recognizing | done | error
    error: null,
    rawResults: [], // raw /api/recognize responses — kept so a later merge (or split) can re-run mergeRecognizedResults on the resulting set
    mergeNote: null, // why an automatic merge happened, e.g. "Sloučeno: datum narození" — set by canAutoMerge's auto-merge, null otherwise
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
    endDateOverrideEnabled: false,
    endDateOverride: "",
    templateOverrideEnabled: false,
    templateOverride: null,
    expanded: false,
    generation: { status: "idle", docxToken: null, pdfToken: null, error: null },
  };
}

function applyRecognizedResult(person, result) {
  const merged = mergeRecognizedResults([result]);
  return {
    ...person,
    status: "done",
    rawResults: [result],
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
    warnings: merged.warnings,
    rawText: merged.rawText,
    ocrMode: merged.ocrMode,
  };
}

// Auto-merge relies on birth date, never on the name itself — a visa's
// MRZ name line can blur into pure noise (real case: passport read
// "NEKHAICHYK/IRYNA" cleanly; that same person's visa MRZ name line
// came out as repeated-letter garbage) while the same line's birth-date
// digits stayed legible. Confirmed across three real passport+visa
// pairs in one batch: birth date matched correctly every time. A
// coincidental birth-date collision between two different people in
// the same batch is a real but small risk for realistic batch sizes
// (single/low tens of people) — and trusting it enough to merge with
// no click is only reasonable because a wrong auto-merge can always be
// undone afterwards, see "Rozdělit" (splitPerson) below.
function normalizeDocNumber(s) {
  return (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Plain Levenshtein distance with an early exit once the running best
// case for a row already exceeds maxDist — document numbers are short
// (≈6-10 chars) so this costs nothing.
function levenshteinAtMost(a, b, maxDist) {
  if (Math.abs(a.length - b.length) > maxDist) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      rowMin = Math.min(rowMin, curr[j]);
    }
    if (rowMin > maxDist) return false;
    prev = curr;
  }
  return prev[b.length] <= maxDist;
}

// Too-short strings are excluded — a 2-character edit distance against
// a 3-4 character fragment would accept almost anything, defeating the
// point of a "cross-check" at all.
function docNumbersMatch(a, b) {
  const na = normalizeDocNumber(a);
  const nb = normalizeDocNumber(b);
  if (na.length < 5 || nb.length < 5) return false;
  return levenshteinAtMost(na, nb, 2);
}

function referencedDocNumber(person) {
  return person.rawResults.find((r) => r.visa_referenced_doc_number)?.visa_referenced_doc_number || "";
}

function birthDateMatches(a, b) {
  const birthA = (a.fields.birth_date || "").trim();
  const birthB = (b.fields.birth_date || "").trim();
  return Boolean(birthA) && birthA === birthB;
}

// NOT currently a reliable signal in practice: real-photo testing across
// three passport+visa pairs showed the backend's visa_referenced_doc_
// number consistently pulling the visa's own type/category code (e.g.
// "TD..." — nothing resembling a passport number) instead of an actual
// passport-number reference, regardless of scan quality. Left in place
// only as a bonus confirmation label on an already birth-date-matched
// merge (see mergeNote below) and as a fallback suggestion signal — but
// no longer gates the auto-merge decision itself. If the backend
// extraction is ever fixed to read the right MRZ field, this starts
// contributing real corroboration for free.
function docNumberCrossMatches(a, b) {
  return (
    docNumbersMatch(a.fields.doc_number, referencedDocNumber(b)) ||
    docNumbersMatch(b.fields.doc_number, referencedDocNumber(a))
  );
}

// The auto-merge trigger: birth date alone.
function canAutoMerge(a, b) {
  return birthDateMatches(a, b);
}

// Surfaced as a one-click "Možná stejná osoba" suggestion rather than
// auto-merged — birth-date matches are handled automatically above
// (so by the time cards coexist as separate "done" cards, birth date
// either didn't match or was missing on one side); this only catches
// the doc-number cross-check on its own, for whenever that extraction
// gets fixed and starts being trustworthy.
function findPossibleMatch(candidates, person) {
  return candidates.find((c) => docNumberCrossMatches(person, c)) || null;
}

// Shared by the automatic (canAutoMerge) merge in the recognize queue
// and the manual "Sloučit s další kartou" button — re-runs the
// same mergeRecognizedResults() single mode uses on the two cards'
// combined raw /api/recognize responses, so a merged card picks fields
// exactly as if both files had been uploaded together from the start.
// mergeNote, when passed, records WHY an automatic merge happened, so
// the card can show it (see PersonCard) — manual merges leave whatever
// note the "keep" card already had (usually none).
function combineCards(keep, merge, mergeNote) {
  const combinedRawResults = [...keep.rawResults, ...merge.rawResults];
  const merged = mergeRecognizedResults(combinedRawResults, { compactNameWarning: true });
  return {
    ...keep,
    files: [...keep.files, ...merge.files],
    previews: [...keep.previews, ...merge.previews],
    rawResults: combinedRawResults,
    fields: {
      first_name: merged.fields.first_name,
      last_name: merged.fields.last_name,
      birth_date: merged.fields.birth_date,
      doc_number: merged.fields.doc_number,
      visa_number: merged.fields.visa_number,
      visa_validity: merged.fields.visa_validity,
      // A manually-typed "druh pobytu" on either card survives the
      // merge — OCR never fills this one, so there's nothing from
      // mergeRecognizedResults to prefer over it.
      residence_type: keep.fields.residence_type || merge.fields.residence_type || "",
    },
    docNumberVerified: merged.docNumberVerified,
    warnings: merged.warnings,
    rawText: merged.rawText,
    ocrMode: merged.ocrMode,
    mergeNote: mergeNote !== undefined ? mergeNote : keep.mergeNote,
  };
}

// Rebuilds a single-file "done" card straight from an already-fetched
// /api/recognize response — used by splitPerson to peel a file back out
// of a merged card without re-uploading or re-running OCR. Reuses the
// original preview object (which already has its own blob URL) instead
// of makePersonCard's own URL.createObjectURL(file), which would create
// a second, redundant object URL for the same file and leak the first.
function buildCardFromRawResult(file, preview, rawResult) {
  const base = makePersonCard(file);
  if (base.previews[0]?.url) URL.revokeObjectURL(base.previews[0].url);
  return applyRecognizedResult({ ...base, previews: [preview] }, rawResult);
}

export default function BatchDocFiller({ apiFetch, authHeader, blanks, onAuthExpired }) {
  const [people, setPeople] = useState([]);
  const [templateId, setTemplateId] = useState(null);
  const [sharedFields, setSharedFields] = useState({});
  const [batchError, setBatchError] = useState(null);
  const [lightboxUrl, setLightboxUrl] = useState(null);

  const [recognizeActive, setRecognizeActive] = useState(false);
  const [recognizeStats, setRecognizeStats] = useState({ total: 0, done: 0 });
  const [generateActive, setGenerateActive] = useState(false);
  const [generateStats, setGenerateStats] = useState({ total: 0, done: 0 });

  const fileInputRef = useRef(null);
  const peopleRef = useRef(people);
  const peopleCountRef = useRef(0); // mirrors people.length synchronously (state updates are async) for the 25-person cap check
  const recognizeQueueRef = useRef([]); // [{id, file}] — one entry per file/card
  const isRecognizingRef = useRef(false);
  const recognizeStartTimesRef = useRef([]);
  const isGeneratingRef = useRef(false);
  const fillStartTimesRef = useRef([]);

  useEffect(() => { peopleRef.current = people; }, [people]);

  useEffect(() => {
    if (!templateId && blanks.length > 0) setTemplateId(blanks[0].id);
  }, [blanks, templateId]);

  // Revoke every card's thumbnail blob URLs if this component itself ever
  // unmounts — it's kept alive (hidden, not unmounted) while the person
  // just tabs between single/batch mode, so this mainly matters if the
  // whole page navigates away.
  useEffect(() => () => {
    peopleRef.current.forEach((p) => p.previews.forEach((pv) => pv.url && URL.revokeObjectURL(pv.url)));
  }, []);

  const updatePerson = useCallback((id, updater) => {
    setPeople((prev) => prev.map((p) => (p.id === id ? updater(p) : p)));
  }, []);

  const removePerson = useCallback((id) => {
    setPeople((prev) => {
      const removed = prev.find((p) => p.id === id);
      removed?.previews.forEach((pv) => pv.url && URL.revokeObjectURL(pv.url));
      return prev.filter((p) => p.id !== id);
    });
    peopleCountRef.current = Math.max(0, peopleCountRef.current - 1);
    recognizeQueueRef.current = recognizeQueueRef.current.filter((item) => item.id !== id);
  }, []);

  // Wipes the entire batch — every card, its files/thumbnails, the
  // recognize queue, and the shared fields — back to a clean slate.
  // Confirms first if there's anything that would actually be lost.
  const handleResetAll = useCallback(() => {
    if (peopleRef.current.length > 0 && !window.confirm(
      "Opravdu začít znovu? Všechny karty, nahrané soubory i společné údaje budou nenávratně smazány."
    )) {
      return;
    }
    peopleRef.current.forEach((p) => p.previews.forEach((pv) => pv.url && URL.revokeObjectURL(pv.url)));
    recognizeQueueRef.current = [];
    peopleCountRef.current = 0;
    setPeople([]);
    setSharedFields({});
    setTemplateId(blanks.length > 0 ? blanks[0].id : null);
    setBatchError(null);
    setRecognizeStats({ total: 0, done: 0 });
    setGenerateStats({ total: 0, done: 0 });
  }, [blanks]);

  // Manual fallback for when the automatic birth-date merge (see
  // canAutoMerge/runRecognizeQueue below) didn't fire — e.g. birth date
  // itself didn't come out matching but the person reviewing can see
  // from the photos that it's the same person anyway. A deliberate
  // click, using the exact same combineCards() the automatic path uses.
  const mergeCards = useCallback((keepId, mergeId) => {
    if (keepId === mergeId) return;
    setPeople((prev) => {
      const keep = prev.find((p) => p.id === keepId);
      const merge = prev.find((p) => p.id === mergeId);
      if (!keep || !merge || keep.status !== "done" || merge.status !== "done") return prev;
      return prev.filter((p) => p.id !== mergeId).map((p) => (p.id === keepId ? combineCards(keep, merge) : p));
    });
    peopleCountRef.current = Math.max(0, peopleCountRef.current - 1);
  }, []);

  // Undoes a merge (automatic or manual) — peels the most recently
  // merged-in file back into its own separate card, re-deriving both
  // cards' fields from their own (now-smaller) rawResults set via the
  // same mergeRecognizedResults() used everywhere else. No re-upload or
  // re-OCR needed — the raw /api/recognize response for every file is
  // already kept around for exactly this. This is what makes the
  // birth-date auto-merge (canAutoMerge) safe to run with no
  // confirmation click: a wrong automatic merge is never unrecoverable.
  const splitPerson = useCallback((id) => {
    setPeople((prev) => {
      const person = prev.find((p) => p.id === id);
      if (!person || person.rawResults.length < 2) return prev;
      const lastIndex = person.rawResults.length - 1;

      const peeledCard = buildCardFromRawResult(
        person.files[lastIndex],
        person.previews[lastIndex],
        person.rawResults[lastIndex]
      );

      const remainingResults = person.rawResults.slice(0, lastIndex);
      const remainingMerged = mergeRecognizedResults(remainingResults, { compactNameWarning: true });
      const remainingCard = {
        ...person,
        files: person.files.slice(0, lastIndex),
        previews: person.previews.slice(0, lastIndex),
        rawResults: remainingResults,
        fields: {
          first_name: remainingMerged.fields.first_name,
          last_name: remainingMerged.fields.last_name,
          birth_date: remainingMerged.fields.birth_date,
          doc_number: remainingMerged.fields.doc_number,
          visa_number: remainingMerged.fields.visa_number,
          visa_validity: remainingMerged.fields.visa_validity,
          residence_type: person.fields.residence_type,
        },
        docNumberVerified: remainingMerged.docNumberVerified,
        warnings: remainingMerged.warnings,
        rawText: remainingMerged.rawText,
        ocrMode: remainingMerged.ocrMode,
        mergeNote: null,
      };

      return [...prev.filter((p) => p.id !== id), remainingCard, peeledCard];
    });
    peopleCountRef.current += 1;
  }, []);

  // Sequential, rate-limit-paced worker, one file/card at a time —
  // re-entrant-safe: if it's already running when more files get added,
  // this call just returns and the running loop picks the new items up on
  // its next iteration since it re-checks the queue's current length each
  // time rather than snapshotting it once.
  //
  // Because it's strictly sequential (never two files in flight at once),
  // by the time any file finishes recognizing, every earlier-queued file
  // has already settled into "done" or "error" — so checking the rest of
  // the list for an identity match right here is always looking at
  // final, stable data, never a half-finished card.
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
        let autoMerged = false;
        setPeople((prev) => {
          const afterRecognize = prev.map((p) => (p.id === item.id ? applyRecognizedResult(p, result) : p));
          const justRecognized = afterRecognize.find((p) => p.id === item.id);
          // A passport and its own visa sticker land as separate cards
          // (one /api/recognize call per file) — auto-merge them back
          // into one the moment the second one finishes, whenever birth
          // date agrees (see canAutoMerge). The "Sloučit s další kartou"
          // button on the card (or the "Možná stejná osoba" suggestion,
          // for a doc-number-only cross-check hit) is the fallback
          // otherwise.
          const match = afterRecognize.find(
            (p) => p.id !== item.id && p.status === "done" && canAutoMerge(p, justRecognized)
          );
          if (!match) return afterRecognize;
          autoMerged = true;
          const mergeNote = docNumberCrossMatches(match, justRecognized)
            ? "Sloučeno: datum narození, číslo dokladu potvrzeno"
            : "Sloučeno: datum narození";
          return afterRecognize
            .filter((p) => p.id !== justRecognized.id)
            .map((p) => (p.id === match.id ? combineCards(match, justRecognized, mergeNote) : p));
        });
        if (autoMerged) peopleCountRef.current = Math.max(0, peopleCountRef.current - 1);
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
    recognizeQueueRef.current.push(...newCards.map((c) => ({ id: c.id, file: c.files[0] })));
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
    const endDate = person.endDateOverrideEnabled ? person.endDateOverride : (sharedFields.end_date || "");
    const effectiveTemplateId = person.templateOverrideEnabled ? person.templateOverride : templateId;
    return {
      template_id: effectiveTemplateId,
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
      end_date: endDate,
      position: sharedFields.position || "",
      workplace: sharedFields.workplace || "",
      salary: sharedFields.salary || "",
      hours_per_week: sharedFields.hours_per_week || "",
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
  const doneCards = useMemo(() => people.filter((p) => p.status === "done"), [people]);

  return (
    <div className="p-7 md:p-9">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-[19px] font-semibold text-[#0B1220]" style={{ fontFamily: "'Barlow', sans-serif" }}>
          Hromadné zpracování více osob
        </h2>
        {people.length > 0 && (
          <button
            type="button"
            onClick={handleResetAll}
            className="shrink-0 text-[12px] text-slate-400 hover:text-red-600 mt-1"
          >
            Začít znovu
          </button>
        )}
      </div>
      <p className="mt-1 text-[13px] text-slate-500">
        Nahrajte fotografie více dokladů najednou — každá fotografie se
        rozpozná jako vlastní karta. Pas a vízum téže osoby se po
        rozpoznání spojí automaticky podle jména; pokud se to nepodaří,
        spojte je na kartě ručně tlačítkem „Sloučit s další kartou".
        Firmu, typ smlouvy a další společné údaje vyplníte jednou pro
        celou dávku dole a použijí se pro všechny karty automaticky.
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

      {/* 1. Upload — always available, every file becomes its own card */}
      <div className="mt-6">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".jpg,.jpeg,.png,.heic,.pdf"
          className="hidden"
          onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
        />
        <div
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
          className="flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-slate-200 bg-slate-50/50 py-9 cursor-pointer hover:border-slate-300 hover:bg-slate-50 transition-colors"
        >
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white border border-slate-200">
            <Upload size={18} className="text-slate-400" />
          </div>
          <div className="text-center">
            <div className="text-[13px] font-medium text-[#0B1220]">Přetáhněte fotografie více osob nebo klikněte</div>
            <div className="text-[11.5px] text-slate-400 mt-0.5">JPG, PNG, HEIC, PDF · jedna fotografie = jedna karta · max {MAX_BATCH_FILES} v dávce</div>
          </div>
        </div>
        <div className="mt-2 text-[11px] text-slate-400">{people.length} / {MAX_BATCH_FILES} karet v dávce</div>
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

      {/* 2. Person cards, collapsed by default */}
      {people.length > 0 && (
        <div className="mt-6 space-y-2.5">
          {people.map((person, i) => (
            <PersonCard
              key={person.id}
              person={person}
              index={i}
              blanks={blanks}
              mergeCandidates={doneCards.filter((p) => p.id !== person.id)}
              possibleMatch={
                person.status === "done"
                  ? findPossibleMatch(doneCards.filter((p) => p.id !== person.id), person)
                  : null
              }
              sharedCompany={sharedCompanyFields}
              sharedStartDate={sharedFields.start_date || ""}
              sharedEndDate={sharedFields.end_date || ""}
              sharedTemplateId={templateId}
              onDownload={handleDownload}
              onRemove={() => removePerson(person.id)}
              onMerge={(otherId) => mergeCards(person.id, otherId)}
              onSplit={() => splitPerson(person.id)}
              onToggleExpand={() => updatePerson(person.id, (p) => ({ ...p, expanded: !p.expanded }))}
              onOpenLightbox={setLightboxUrl}
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
              onToggleEndDateOverride={() => updatePerson(person.id, (p) => (
                p.endDateOverrideEnabled
                  ? { ...p, endDateOverrideEnabled: false, endDateOverride: "" }
                  : { ...p, endDateOverrideEnabled: true, endDateOverride: sharedFields.end_date || "" }
              ))}
              onUpdateEndDateOverride={(value) => updatePerson(person.id, (p) => ({ ...p, endDateOverride: value }))}
              onToggleTemplateOverride={() => updatePerson(person.id, (p) => (
                p.templateOverrideEnabled
                  ? { ...p, templateOverrideEnabled: false, templateOverride: null }
                  : { ...p, templateOverrideEnabled: true, templateOverride: templateId }
              ))}
              onUpdateTemplateOverride={(value) => updatePerson(person.id, (p) => ({ ...p, templateOverride: value }))}
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
            <label className="text-[11px] md:text-[12px] uppercase tracking-wide text-slate-400">Typ smlouvy (pro celou dávku)</label>
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

      {lightboxUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
          onClick={(e) => { if (e.target === e.currentTarget) setLightboxUrl(null); }}
        >
          <img src={lightboxUrl} alt="Náhled dokumentu" className="max-h-full max-w-full rounded-xl shadow-2xl object-contain" />
          <button
            onClick={() => setLightboxUrl(null)}
            className="absolute top-5 right-5 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
          >
            <X size={18} />
          </button>
        </div>
      )}
    </div>
  );
}
