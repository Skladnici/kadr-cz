import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Download, FileText, Loader2, Upload, X } from "lucide-react";
import CompanyPicker from "./CompanyPicker";
import PersonCard from "./PersonCard";
import {
  FIELD_DEFS, PERSON_FIELD_KEYS, COMPANY_FIELD_KEYS, isFieldRelevant, DEFAULT_SALARY_BY_TEMPLATE,
} from "../constants/fields";
import { composeCzAddress, composeOriginAddress } from "../utils/address";
import { mergeRecognizedResults } from "../utils/recognizeMerge";
import { API_BASE, describeRequestError, uploadFileViaXHR, apiFetchWithTimeout, downloadGeneratedFile } from "../utils/api";
import { paceRateLimit, runWithRetry, estimateSecondsRemaining } from "../utils/rateLimitQueue";
import { nameFolderPart, BUNDLE_FILE_SPECS, zipFolderedDownload } from "../utils/zipDownload";

// Same accent used by SimpleDocFiller/LoginForm's own primary buttons —
// redefined locally rather than imported, matching how LoginForm.jsx
// already does the same (SimpleDocFiller.jsx doesn't export it).
const PRIMARY_GRADIENT = { background: "var(--gradient-primary)" };

const MAX_BATCH_FILES = 25;

const EMPTY_PERSON_FIELDS = {
  first_name: "", last_name: "", birth_date: "", doc_number: "",
  visa_number: "", visa_validity: "", residence_type: "", visa_type_code: "",
  nationality: "",
};
const EMPTY_COMPANY = { name: "", ico: "", dic: "", address: "", representative: "" };

// Every dropped/selected file becomes its own card immediately (auto-
// recognized) — the simple, predictable default. A passport + visa for
// the same person end up as two cards this way; they're re-combined
// into one automatically (see canAutoMerge, below) when birth date
// agrees, through the exact same utils/recognizeMerge.js logic single
// mode uses for "several files, one person". No manual merge control
// exists — a wrong automatic merge is undone with "Rozdělit" instead
// (see splitPerson), never redone by hand.
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
    fields: { ...EMPTY_PERSON_FIELDS },
    docNumberVerified: false,
    warnings: [],
    addressHint: null,
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
    generation: {
      status: "idle", docxToken: null, pdfToken: null,
      gdprDocxToken: null, zdravotniDocxToken: null, poplatnikPdfToken: null,
      error: null,
    },
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
      visa_type_code: merged.fields.visa_type_code,
      nationality: merged.fields.nationality,
      residence_type: "",
    },
    docNumberVerified: merged.docNumberVerified,
    warnings: merged.warnings,
    addressHint: merged.addressHint,
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
// The auto-merge trigger: birth date alone. Doc-number cross-checking
// (against the visa's MRZ-referenced document number) was tried and
// removed — real-photo testing across three passport+visa pairs showed
// the backend consistently pulling the visa's own type/category code
// (e.g. "TD..." — nothing resembling a passport number) rather than an
// actual reference, so it never contributed anything real in practice.
function canAutoMerge(a, b) {
  const birthA = (a.fields.birth_date || "").trim();
  const birthB = (b.fields.birth_date || "").trim();
  return Boolean(birthA) && birthA === birthB;
}

// The only merge path — automatic (see canAutoMerge/runRecognizeQueue
// below), there's no manual equivalent. Re-runs the same
// mergeRecognizedResults() single mode uses on the two cards' combined
// raw /api/recognize responses, so a merged card picks fields exactly
// as if both files had been uploaded together from the start.
// Deliberately doesn't surface WHY a merge happened (birth date match,
// ...) anywhere in the UI — that's an implementation detail the person
// filling out paperwork doesn't need, and single mode never showed a
// merge "reason" either, so this keeps both consistent.
function combineCards(keep, merge) {
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
      visa_type_code: merged.fields.visa_type_code,
      nationality: merged.fields.nationality,
      // A manually-typed "druh pobytu" on either card survives the
      // merge — OCR never fills this one, so there's nothing from
      // mergeRecognizedResults to prefer over it.
      residence_type: keep.fields.residence_type || merge.fields.residence_type || "",
    },
    docNumberVerified: merged.docNumberVerified,
    warnings: merged.warnings,
    addressHint: merged.addressHint,
    rawText: merged.rawText,
    ocrMode: merged.ocrMode,
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
  // --- Lightbox zoom/pan (mouse wheel to zoom 100%-400%, drag to pan) —
  // ported as-is from SimpleDocFiller.jsx's single-mode lightbox so both
  // modes behave identically, rather than a separate implementation. ---
  const lightboxImgRef = useRef(null);
  const [lightboxTransform, setLightboxTransform] = useState({ zoom: 1, pan: { x: 0, y: 0 } });
  const lightboxDragRef = useRef(null); // { startX, startY, startPan } while a drag is in progress, else null
  const [isPanningLightbox, setIsPanningLightbox] = useState(false);

  const [recognizeActive, setRecognizeActive] = useState(false);
  const [recognizeStats, setRecognizeStats] = useState({ total: 0, done: 0 });
  const [generateActive, setGenerateActive] = useState(false);
  const [generateStats, setGenerateStats] = useState({ total: 0, done: 0 });
  const [bulkDownloadBuilding, setBulkDownloadBuilding] = useState(false); // is the one combined-packet zip currently being built

  const fileInputRef = useRef(null);
  const peopleRef = useRef(people);
  const peopleCountRef = useRef(0); // mirrors people.length synchronously (state updates are async) for the 25-person cap check
  const recognizeQueueRef = useRef([]); // [{id, file}] — one entry per file/card
  const isRecognizingRef = useRef(false);
  const recognizeStartTimesRef = useRef([]);
  const isGeneratingRef = useRef(false);
  const fillStartTimesRef = useRef([]);
  // Guards handleDownloadAllBundle against running twice concurrently
  // (an accidental double-click) — /api/download tokens are single-use
  // server-side, so two overlapping zip-building passes would race each
  // other for the same tokens and whichever request lost would find its
  // file already gone, silently shrinking the resulting zip by one. A
  // ref (not just the bulkDownloadBuilding state above) because the
  // check has to be synchronous at click time, before React has
  // necessarily re-rendered with the new state yet.
  const isBulkDownloadingRef = useRef(false);

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

  // Fresh photo, fresh zoom — otherwise the next opened preview would
  // inherit whatever zoom/pan the previous one was left at.
  useEffect(() => {
    setLightboxTransform({ zoom: 1, pan: { x: 0, y: 0 } });
  }, [lightboxUrl]);

  // Keeps panning from dragging the image entirely out of view — the
  // further zoomed in, the more room there is to pan, none at all at 100%.
  const clampLightboxPan = useCallback((pan, zoom) => {
    const el = lightboxImgRef.current;
    if (!el) return pan;
    const maxX = (el.offsetWidth * (zoom - 1)) / 2;
    const maxY = (el.offsetHeight * (zoom - 1)) / 2;
    return {
      x: Math.min(maxX, Math.max(-maxX, pan.x)),
      y: Math.min(maxY, Math.max(-maxY, pan.y)),
    };
  }, []);

  // Wheel is attached as a native (non-passive) listener rather than
  // React's onWheel — React delegates wheel listeners as passive by
  // default, which would silently prevent e.preventDefault() from
  // stopping the page itself from scrolling behind the lightbox.
  useEffect(() => {
    const el = lightboxImgRef.current;
    if (!el) return;
    const handleWheel = (e) => {
      e.preventDefault();
      setLightboxTransform((t) => {
        const nextZoom = Math.min(4, Math.max(1, t.zoom - e.deltaY * 0.0015));
        return { zoom: nextZoom, pan: clampLightboxPan(t.pan, nextZoom) };
      });
    };
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [lightboxUrl, clampLightboxPan]);

  const handleLightboxMouseDown = useCallback((e) => {
    if (lightboxTransform.zoom <= 1) return; // nothing to pan at 100%
    e.preventDefault();
    lightboxDragRef.current = { startX: e.clientX, startY: e.clientY, startPan: lightboxTransform.pan };
    setIsPanningLightbox(true);
  }, [lightboxTransform.zoom, lightboxTransform.pan]);

  // Move/up listen on window (not just the image) so a drag that carries
  // the cursor off the image, or releases outside it, still behaves.
  useEffect(() => {
    const handleMove = (e) => {
      const drag = lightboxDragRef.current;
      if (!drag) return;
      setLightboxTransform((t) => ({
        ...t,
        pan: clampLightboxPan(
          { x: drag.startPan.x + (e.clientX - drag.startX), y: drag.startPan.y + (e.clientY - drag.startY) },
          t.zoom
        ),
      }));
    };
    const handleUp = () => {
      lightboxDragRef.current = null;
      setIsPanningLightbox(false);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [clampLightboxPan]);

  // Every person-list update goes through this instead of calling
  // setPeople directly, so peopleRef.current is authoritative the
  // instant the update runs — not just after the next render commits.
  // The plain `useEffect(() => { peopleRef.current = people }, [people])`
  // above is too late for code that fires right after a state update
  // resolves but before React has re-rendered: real testing found the
  // bulk-download buttons (whose click handler reads peopleRef.current)
  // intermittently missing whichever card's generation had *just*
  // finished — handleGenerateAll's loop calls setGenerateActive(false)
  // (re-enabling the button) in the same tick as the last card's
  // updatePerson call, and a fast click could land before the
  // useEffect-driven ref sync had a chance to run, so the ref still
  // reflected the second-to-last state. Every fetch in that scenario
  // actually succeeded (confirmed via logging) — the card just wasn't in
  // the target list to begin with.
  const setPeopleAndSync = useCallback((updaterOrValue) => {
    setPeople((prev) => {
      const next = typeof updaterOrValue === "function" ? updaterOrValue(prev) : updaterOrValue;
      peopleRef.current = next;
      return next;
    });
  }, []);

  const updatePerson = useCallback((id, updater) => {
    setPeopleAndSync((prev) => prev.map((p) => (p.id === id ? updater(p) : p)));
  }, [setPeopleAndSync]);

  // Stable (id, key, value) updaters, as opposed to inline arrow functions
  // built fresh per card on every render — AddressBuilder's own PSČ
  // geocoding effect depends on its setCzPart/setOriginPart/setOriginCountry
  // props for its debounce (see AddressBuilder.jsx), exactly like
  // SimpleDocFiller's useCallback-wrapped setCzPart/setOriginPart do for
  // single mode. An unstable reference there was restarting that effect —
  // aborting the in-flight Nominatim request and resetting the 1s debounce —
  // on every unrelated batch re-render, which is why PSČ lookups in batch
  // mode kept searching without ever finishing. PersonCard binds `id` for
  // its own card via useCallback so the reference AddressBuilder sees stays
  // stable across renders.
  const updateCzPart = useCallback((id, key, value) => {
    updatePerson(id, (p) => ({ ...p, czAddressParts: { ...p.czAddressParts, [key]: value } }));
  }, [updatePerson]);
  const updateOriginPart = useCallback((id, key, value) => {
    updatePerson(id, (p) => ({ ...p, originAddressParts: { ...p.originAddressParts, [key]: value } }));
  }, [updatePerson]);
  const setOriginCountryForPerson = useCallback((id, country) => {
    updatePerson(id, (p) => ({ ...p, originCountry: country, originAddressParts: {} }));
  }, [updatePerson]);

  const removePerson = useCallback((id) => {
    setPeopleAndSync((prev) => {
      const removed = prev.find((p) => p.id === id);
      removed?.previews.forEach((pv) => pv.url && URL.revokeObjectURL(pv.url));
      return prev.filter((p) => p.id !== id);
    });
    peopleCountRef.current = Math.max(0, peopleCountRef.current - 1);
    recognizeQueueRef.current = recognizeQueueRef.current.filter((item) => item.id !== id);
  }, []);

  // Manual fallback for when canAutoMerge's birth-date match misses —
  // OCR.space is non-deterministic call-to-call on the same image (see
  // combineCards' own neighboring comments and _looks_like_garbage_name
  // in ocr_service.py), so a passport and its own visa can occasionally
  // come back with a birth date that reads slightly differently on one
  // of the two, and no regex-level fix can catch a wrong-but-plausible
  // digit the way it can catch obviously garbled text. Reuses the exact
  // same combineCards() path the automatic merge does, so a manual merge
  // behaves identically (including being reversible via "Rozdělit").
  const handleManualMerge = useCallback((id, otherId) => {
    setPeopleAndSync((prev) => {
      const a = prev.find((p) => p.id === id);
      const b = prev.find((p) => p.id === otherId);
      if (!a || !b) return prev;
      const combined = combineCards(a, b);
      return prev.filter((p) => p.id !== b.id).map((p) => (p.id === a.id ? combined : p));
    });
    peopleCountRef.current = Math.max(0, peopleCountRef.current - 1);
  }, [setPeopleAndSync]);

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
    setPeopleAndSync([]);
    setSharedFields({});
    setTemplateId(blanks.length > 0 ? blanks[0].id : null);
    setBatchError(null);
    setRecognizeStats({ total: 0, done: 0 });
    setGenerateStats({ total: 0, done: 0 });
  }, [blanks, setPeopleAndSync]);

  // Undoes an automatic merge — peels the most recently
  // merged-in file back into its own separate card, re-deriving both
  // cards' fields from their own (now-smaller) rawResults set via the
  // same mergeRecognizedResults() used everywhere else. No re-upload or
  // re-OCR needed — the raw /api/recognize response for every file is
  // already kept around for exactly this. This is what makes the
  // birth-date auto-merge (canAutoMerge) safe to run with no
  // confirmation click: a wrong automatic merge is never unrecoverable.
  const splitPerson = useCallback((id) => {
    setPeopleAndSync((prev) => {
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
          visa_type_code: remainingMerged.fields.visa_type_code,
          nationality: remainingMerged.fields.nationality,
          residence_type: person.fields.residence_type,
        },
        docNumberVerified: remainingMerged.docNumberVerified,
        warnings: remainingMerged.warnings,
        addressHint: remainingMerged.addressHint,
        rawText: remainingMerged.rawText,
        ocrMode: remainingMerged.ocrMode,
      };

      return [...prev.filter((p) => p.id !== id), remainingCard, peeledCard];
    });
    peopleCountRef.current += 1;
  }, [setPeopleAndSync]);

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
        setPeopleAndSync((prev) => {
          const afterRecognize = prev.map((p) => (p.id === item.id ? applyRecognizedResult(p, result) : p));
          const justRecognized = afterRecognize.find((p) => p.id === item.id);
          // A passport and its own visa sticker land as separate cards
          // (one /api/recognize call per file) — auto-merge them back
          // into one the moment the second one finishes, whenever birth
          // date agrees (see canAutoMerge). The "Sloučit s jinou kartou"
          // button on the card (see PersonCard's mergeCandidates/
          // onManualMerge, and handleManualMerge below) is the fallback
          // for whenever OCR non-determinism makes the two readings
          // disagree even though they're the same document/person.
          const match = afterRecognize.find(
            (p) => p.id !== item.id && p.status === "done" && canAutoMerge(p, justRecognized)
          );
          if (!match) return afterRecognize;
          autoMerged = true;
          return afterRecognize
            .filter((p) => p.id !== justRecognized.id)
            .map((p) => (p.id === match.id ? combineCards(match, justRecognized) : p));
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
  }, [authHeader, onAuthExpired, updatePerson, setPeopleAndSync]);

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
    setPeopleAndSync((prev) => [...prev, ...newCards]);
    recognizeQueueRef.current.push(...newCards.map((c) => ({ id: c.id, file: c.files[0] })));
    setRecognizeStats((s) => ({
      total: (isRecognizingRef.current ? s.total : 0) + newCards.length,
      done: isRecognizingRef.current ? s.done : 0,
    }));
    runRecognizeQueue();
  }, [runRecognizeQueue, setPeopleAndSync]);

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
  // This is now the ONLY download path in batch mode — no more per-card
  // buttons (see PersonCard).
  // Reads `people` (the state variable, captured fresh via the
  // dependency array below) rather than peopleRef.current — real
  // testing found the ref-based read intermittently missing whichever
  // card's generation had *just* finished, even after making every
  // setPeople call assign the ref synchronously inside its own updater.
  // That "fix" didn't actually close the gap: a functional updater
  // passed to setState only runs when React gets around to processing
  // the queued update, which is not guaranteed to happen before the
  // surrounding synchronous code (handleGenerateAll's own
  // setGenerateActive(false), re-enabling this very button) continues —
  // so the ref could still be one card behind. The state variable itself
  // doesn't have that gap: React only lets a component's rendered
  // output (including this button and whatever closure its onClick
  // captured) reach the screen — and therefore reach a click — once a
  // commit has actually applied, at which point `people` in that
  // closure is guaranteed consistent with what's on screen.
  // One combined packet per person rather than separate Word/PDF zips —
  // each person's folder gets whatever of their documents actually
  // exist (docxToken/pdfToken always; the three bundle tokens only for
  // DPP/DPČ/HPP — see backend's _BUNDLE_TEMPLATE_IDS), so a non-bundle
  // template still works exactly the same as before, just with the
  // single file placed inside that person's own folder instead of at
  // the zip's top level. Real-world testing (Chrome throttling both
  // multi-download and multi-window.open() sequences after the first
  // one — the same "[BULK-PDF-DEBUG]" finding the old separate PDF zip
  // was built around) is why this stays one zip, one browser action,
  // rather than one download per document. BUNDLE_FILE_SPECS and the zip-
  // building logic itself live in utils/zipDownload.js, shared with
  // SimpleDocFiller's single-mode download button.
  const handleDownloadAllBundle = useCallback(async () => {
    if (isBulkDownloadingRef.current) return;
    isBulkDownloadingRef.current = true;
    setBulkDownloadBuilding(true);
    try {
      const targets = people.filter((p) => p.generation?.status === "done");
      const entries = targets.map((p) => ({ folderName: nameFolderPart(p.fields), tokens: p.generation }));
      await zipFolderedDownload(apiFetch, entries, BUNDLE_FILE_SPECS, (n) => `Dokumenty_${n}_osob.zip`, setBatchError);
    } finally {
      isBulkDownloadingRef.current = false;
      setBulkDownloadBuilding(false);
    }
  }, [apiFetch, people]);

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
      nationality: person.fields.nationality,
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
      // HPP-only (see FIELD_DEFS) — already rendered in this shared-
      // fields form via the same generic FIELD_DEFS loop SimpleDocFiller
      // uses, just wasn't being read out into the actual payload yet.
      probation_period: sharedFields.probation_period || "",
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
    // for the next "Vygenerovat" click. Reads `people` (state, captured
    // fresh via this callback's dependency array) rather than
    // peopleRef.current — real testing found the ref-based read
    // intermittently stale immediately after a split/merge action
    // (e.g. clicking "Vygenerovat" right after "Rozdělit"), for the same
    // reason documented on handleDownloadAllBundle above: a functional
    // setState updater isn't guaranteed to run before this code
    // continues, no matter where the ref gets assigned inside it.
    const ids = people.map((p) => p.id);
    setGenerateStats({ total: ids.length, done: 0 });
    for (const id of ids) {
      // The whole per-iteration body is wrapped in try/catch (not just
      // the fetch itself) so that an exception from anywhere in here —
      // not only the network call — can never silently end the loop
      // early; it always turns into a visible per-card error instead.
      try {
        updatePerson(id, (p) => ({
          ...p,
          generation: {
            status: "generating", docxToken: null, pdfToken: null,
            gdprDocxToken: null, zdravotniDocxToken: null, poplatnikPdfToken: null,
            error: null,
          },
        }));
        await paceRateLimit(fillStartTimesRef);
        const person = peopleRef.current.find((p) => p.id === id);
        if (person) {
          // Card still exists — actually generate it. (If it was removed
          // mid-run, there's nothing to submit; the stats update below
          // still fires either way so the progress bar never gets stuck
          // short of its own total.)
          try {
            const data = await runWithRetry(async () => {
              // A bare fetch() has no timeout of its own — see
              // apiFetchWithTimeout's docstring. Without this, one stuck
              // /api/fill call (LibreOffice PDF conversion taking too long
              // on a free-tier instance, or a hung fetch from an
              // interfering browser extension) froze this entire
              // sequential loop behind an endless "Generuji X z Y"
              // spinner with zero explanation — that's the real bug this
              // guards against, not just a nice-to-have.
              const res = await apiFetchWithTimeout(apiFetch, "/api/fill", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(buildFillPayload(person)),
              }, 60000);
              if (!res.ok) {
                const err = new Error("server error");
                err.status = res.status;
                throw err;
              }
              return res.json();
            });
            // Does NOT touch `expanded` — a card stays exactly as
            // collapsed/expanded as the person already left it. Batch
            // mode used to force it open here so the (then per-card)
            // download buttons would be visible without an extra click,
            // but that reasoning no longer applies now that download is
            // only ever the batch-level buttons below, never a per-card
            // one — the person can open a card to check its details
            // whenever they want to, but nothing should decide that for
            // them.
            updatePerson(id, (p) => ({
              ...p,
              generation: {
                status: "done", docxToken: data.docx_token, pdfToken: data.pdf_token,
                // A real token only for DPP/DPČ/HPP (see backend's
                // /api/fill and _BUNDLE_TEMPLATE_IDS) — data.*_token is
                // absent entirely for any other template id, and `??
                // null` folds that in with "this one bundle doc's own
                // best-effort generation failed" (see
                // _fill_bundle_docx/fill_poplatnik_pdf) — the zip-
                // building code below only ever needs "is there a token
                // to include," not which of those two this was.
                gdprDocxToken: data.gdpr_docx_token ?? null,
                zdravotniDocxToken: data.zdravotni_docx_token ?? null,
                poplatnikPdfToken: data.poplatnik_pdf_token ?? null,
                error: null,
              },
            }));
          } catch (e) {
            if (e.status === 401) {
              onAuthExpired();
            } else {
              const message = e.message === "timeout"
                ? "Generování trvalo příliš dlouho (přes 60 s) — zkuste to prosím znovu."
                : describeRequestError(e.status, "Generování se nezdařilo.");
              updatePerson(id, (p) => ({
                ...p,
                generation: {
                  status: "error", docxToken: null, pdfToken: null,
                  gdprDocxToken: null, zdravotniDocxToken: null, poplatnikPdfToken: null,
                  error: message,
                },
              }));
            }
          }
        }
      } catch (e) {
        updatePerson(id, (p) => ({
          ...p,
          generation: {
            status: "error", docxToken: null, pdfToken: null,
            gdprDocxToken: null, zdravotniDocxToken: null, poplatnikPdfToken: null,
            error: "Neočekávaná chyba při generování — zkuste to prosím znovu.",
          },
        }));
      }
      setGenerateStats((s) => ({ ...s, done: s.done + 1 }));
    }
    isGeneratingRef.current = false;
    setGenerateActive(false);
  }, [templateId, people, apiFetch, buildFillPayload, updatePerson, onAuthExpired]);

  const recognizeRemaining = recognizeStats.total - recognizeStats.done;
  const generateRemaining = generateStats.total - generateStats.done;
  const generatedCount = useMemo(() => people.filter((p) => p.generation?.status === "done").length, [people]);

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
        rozpoznání spojí automaticky (podle data narození). Pokud se
        omylem spojí dvě různé osoby do jedné karty, rozdělte je zpět
        tlačítkem „Rozdělit" na kartě. Firmu, typ smlouvy a další
        společné údaje vyplníte jednou pro celou dávku dole a použijí se
        pro všechny karty automaticky.
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
              sharedCompany={sharedCompanyFields}
              sharedStartDate={sharedFields.start_date || ""}
              sharedEndDate={sharedFields.end_date || ""}
              sharedTemplateId={templateId}
              onRemove={() => removePerson(person.id)}
              onSplit={() => splitPerson(person.id)}
              mergeCandidates={people.filter((p) => p.id !== person.id && p.status === "done")}
              onManualMerge={(otherId) => handleManualMerge(person.id, otherId)}
              onToggleExpand={() => {
                // TEMP DEBUG — remove once the "card reopens itself"
                // report is confirmed fixed on a real batch. Search
                // "EXPAND-DEBUG" to find every line to strip.
                console.log("[EXPAND-DEBUG] toggle clicked for", person.id, `(${person.fields.first_name} ${person.fields.last_name})`, "current expanded =", person.expanded, "-> will become", !person.expanded);
                updatePerson(person.id, (p) => {
                  console.log("[EXPAND-DEBUG] updater running for", p.id, "expanded", p.expanded, "->", !p.expanded);
                  return { ...p, expanded: !p.expanded };
                });
              }}
              onOpenLightbox={setLightboxUrl}
              onUpdateFields={(patch) => updatePerson(person.id, (p) => ({ ...p, fields: { ...p.fields, ...patch } }))}
              onUpdateCzPart={updateCzPart}
              onUpdateOriginPart={updateOriginPart}
              onSetOriginCountry={setOriginCountryForPerson}
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

          {/* Bulk download — once at least one contract is generated,
              this is the ONLY way to get it in batch mode (see
              PersonCard — no more per-card buttons), one click across
              the whole batch instead of opening every card. One zip,
              one folder per person, with whatever documents that
              person actually has (contract +, for DPP/DPČ/HPP, the
              GDPR/health-declaration/tax-office packet) — see
              handleDownloadAllBundle. */}
          {generatedCount > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleDownloadAllBundle}
                disabled={bulkDownloadBuilding}
                style={PRIMARY_GRADIENT}
                className="inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {bulkDownloadBuilding ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                {bulkDownloadBuilding ? "Balím do ZIP…" : `Stáhnout všechny (${generatedCount}) jako ZIP`}
              </button>
            </div>
          )}
        </div>
      )}

      {lightboxUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6 overflow-hidden"
          onClick={(e) => {
            // Only the backdrop itself closes it — a click that bubbled
            // up from the image (e.g. the end of a drag, or a plain
            // click now that the image is interactive) shouldn't.
            if (e.target === e.currentTarget) setLightboxUrl(null);
          }}
        >
          <img
            ref={lightboxImgRef}
            src={lightboxUrl}
            alt="Náhled dokumentu"
            draggable={false}
            onMouseDown={handleLightboxMouseDown}
            style={{
              transform: `translate(${lightboxTransform.pan.x}px, ${lightboxTransform.pan.y}px) scale(${lightboxTransform.zoom})`,
              cursor: lightboxTransform.zoom > 1 ? (isPanningLightbox ? "grabbing" : "grab") : "zoom-in",
            }}
            className="max-h-full max-w-full rounded-xl shadow-2xl object-contain select-none"
          />
          {lightboxTransform.zoom > 1 && (
            <div className="absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-[12px] text-white pointer-events-none">
              {Math.round(lightboxTransform.zoom * 100)}%
            </div>
          )}
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
