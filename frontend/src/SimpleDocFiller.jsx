import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import {
  Upload, FileText, Check, AlertTriangle, X, Download,
  Printer, Loader2, ArrowRight, ArrowLeft, RotateCcw, ShieldCheck,
} from "lucide-react";

import LoginForm from "./components/LoginForm";
import AddressBuilder from "./components/AddressBuilder";
import CompanyPicker from "./components/CompanyPicker";
import { FIELD_DEFS, PERSON_FIELD_KEYS, COMPANY_FIELD_KEYS, isFieldRelevant, DEFAULT_SALARY_BY_TEMPLATE } from "./constants/fields";
import { composeCzAddress, composeOriginAddress } from "./utils/address";
import { isValidIco, isValidDic } from "./utils/validation";
import { API_BASE, describeRequestError, toBasicAuthHeader, uploadFileViaXHR } from "./utils/api";

// NOTE: browser-side compression was removed here — it caused uploads to
// hang indefinitely for certain files (observed with photos forwarded
// through messaging apps), even with a timeout safety net in place. The
// backend already compresses/resizes images reliably and quickly before
// OCR, so sending the original file directly is both simpler and safer.

// The one accent used for the header badge and each screen's single
// primary action button — see index.css's --gradient-primary for the
// actual color stops. Every other button stays neutral (bordered, no
// fill) so the gradient always points at exactly one action per screen.
const PRIMARY_GRADIENT = { background: "var(--gradient-primary)" };

// sessionStorage key for the site-wide Basic Auth header — see the
// authHeader useState/useEffect pair below.
const AUTH_STORAGE_KEY = "kadr_cz_auth_header";

export default function SimpleDocFiller() {
  const [step, setStep] = useState(1); // 1 upload, 2 scanning, 3 form, 4 done
  const [fields, setFields] = useState({});
  const [previewUrls, setPreviewUrls] = useState([]);
  const [czAddressParts, setCzAddressParts] = useState({});
  const [originCountry, setOriginCountry] = useState("ua");
  const [originAddressParts, setOriginAddressParts] = useState({});
  const [warnings, setWarnings] = useState([]);
  const [rawText, setRawText] = useState("");
  const [ocrMode, setOcrMode] = useState(null);
  const [docNumberVerified, setDocNumberVerified] = useState(false);
  const [pendingFiles, setPendingFiles] = useState([]);
  const [pastedText, setPastedText] = useState("");
  const [lightboxUrl, setLightboxUrl] = useState(null);
  const [error, setError] = useState(null);
  const [blanks, setBlanks] = useState([]);
  const [templateId, setTemplateId] = useState(null);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [downloadError, setDownloadError] = useState(null);
  const fileInputRef = useRef(null);

  // Backed by sessionStorage (not localStorage, not memory-only) so a
  // page reload (F5) or browser back/forward doesn't force a fresh
  // login — sessionStorage survives those — while still asking again
  // once the tab/browser is actually closed, since that's exactly when
  // sessionStorage (unlike localStorage) gets cleared. "Nový dokument"
  // (reset()) never touches authHeader, so the login-once-per-visit
  // behavior for cycling through documents is unaffected by this.
  const [authHeader, setAuthHeader] = useState(() => {
    try {
      return sessionStorage.getItem(AUTH_STORAGE_KEY);
    } catch {
      return null; // sessionStorage unavailable — falls back to asking every load, same as before this change
    }
  });
  const [loginError, setLoginError] = useState(null);
  const [loggingIn, setLoggingIn] = useState(false);

  // Single point that keeps sessionStorage in sync with authHeader,
  // regardless of which of the three call sites below changed it —
  // login success writes it in, a 401 (from apiFetch or the XHR upload
  // path) clears it out.
  useEffect(() => {
    try {
      if (authHeader) sessionStorage.setItem(AUTH_STORAGE_KEY, authHeader);
      else sessionStorage.removeItem(AUTH_STORAGE_KEY);
    } catch {
      // sessionStorage unavailable — session just won't survive a reload
    }
  }, [authHeader]);

  // Every authenticated request goes through here instead of a bare
  // fetch() — attaches the Authorization header we built at login, and
  // reacts to a 401 (wrong/expired credentials) by dropping back to
  // LoginForm, centralizing that instead of repeating it at every call
  // site.
  const apiFetch = useCallback((path, options = {}) => {
    return fetch(`${API_BASE}${path}`, {
      ...options,
      headers: { ...options.headers, Authorization: authHeader },
    }).then((res) => {
      if (res.status === 401) setAuthHeader(null);
      return res;
    });
  }, [authHeader]);

  const handleLogin = async (username, password) => {
    setLoggingIn(true);
    setLoginError(null);
    const header = toBasicAuthHeader(username, password);
    try {
      // /api/blanks doubles as the credential check here (any correctly
      // authenticated GET would do) — reuse its body to seed the blanks
      // list directly instead of throwing it away and having the effect
      // below immediately re-fetch the same data over again.
      const res = await fetch(`${API_BASE}/api/blanks`, { headers: { Authorization: header } });
      if (res.ok) {
        const data = await res.json();
        setBlanks(data);
        if (data.length > 0) setTemplateId(data[0].id);
        setAuthHeader(header);
      } else if (res.status === 401) {
        setLoginError("Nesprávné uživatelské jméno nebo heslo.");
      } else {
        setLoginError(describeRequestError(res.status, "Přihlášení se nezdařilo."));
      }
    } catch {
      setLoginError("Přihlášení se nezdařilo — zkontrolujte připojení k internetu.");
    } finally {
      setLoggingIn(false);
    }
  };

  useEffect(() => {
    // Already seeded by handleLogin's credential-check response — this
    // effect only needs to actually fetch when authHeader appears through
    // some other path (there currently isn't one, but relying on that
    // would be fragile) or blanks genuinely came back empty.
    if (!authHeader || blanks.length > 0) return;
    apiFetch("/api/blanks")
      .then((r) => {
        if (!r.ok) {
          const err = new Error("failed");
          err.status = r.status;
          throw err;
        }
        return r.json();
      })
      .then((data) => {
        setBlanks(data);
        if (data.length > 0) setTemplateId(data[0].id);
      })
      .catch((e) => {
        if (e.status !== 401) {
          setError(describeRequestError(e?.status, "Nepodařilo se načíst seznam formulářů."));
        }
      });
  }, [authHeader, apiFetch]);

  // Shared by both the file-upload path and the paste-text path: takes
  // an array of /api/recognize-shaped results and merges them into the
  // form's fields, address, and warnings — so pasting text goes through
  // exactly the same field-extraction and auto-fill logic as a photo.
  const applyRecognizedResults = useCallback((results) => {
    const pick = (key) => {
      for (const r of results) {
        if (r[key] && r[key] !== "—") return r[key];
      }
      return "";
    };

    // Identity fields (name, birth date, doc number) can come back non-empty
    // from more than one uploaded file — a visa sticker carries its own
    // MRZ-style name line too, alongside a passport/ID's. But a visa's MRZ
    // is far more OCR-error-prone (glare, curvature, smaller print, often
    // crowded by stamps) than a passport's dedicated biometric-page MRZ, so
    // whichever file happens to be uploaded/processed first shouldn't just
    // win by default — that let a garbled visa read silently override a
    // clean passport read that arrived second. Rank sources by reliability
    // instead: prefer a result whose doc_number checksum-verified (only
    // possible for genuine ICAO passport/ID MRZ, see
    // _extract_passport_number_from_mrz in ocr_service.py), then prefer any
    // non-visa document, and only fall back to plain upload order if
    // neither signal distinguishes them.
    const pickReliableResult = (key) =>
      results.find((r) => r[key] && r[key] !== "—" && r.doc_number_verified) ||
      results.find((r) => r[key] && r[key] !== "—" && r.doc_type !== "Vízum") ||
      results.find((r) => r[key] && r[key] !== "—");
    const pickReliable = (key) => pickReliableResult(key)?.[key] || "";

    const docNumberSource = pickReliableResult("doc_number");

    setFields({
      first_name: pickReliable("first_name").toUpperCase(),
      last_name: pickReliable("last_name").toUpperCase(),
      birth_date: pickReliable("birth_date"),
      nationality: pick("nationality"),
      doc_number: docNumberSource?.doc_number || "",
      visa_number: pick("visa_number"),
      visa_validity: pick("visa_validity"),
      position: "",
      workplace: "",
      salary: DEFAULT_SALARY_BY_TEMPLATE[templateId] || "",
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
    // Tied to whichever source actually won doc_number above, not just
    // "was any uploaded file verified" — otherwise the "Ověřeno kontrolním
    // součtem" badge could show next to a number that isn't the one that
    // was actually checksum-verified.
    setDocNumberVerified(Boolean(docNumberSource?.doc_number_verified));

    const recognizedAddress = pick("address");
    const newWarnings = [...results.flatMap((r) => r.warnings || [])];
    if (recognizedAddress) {
      newWarnings.push(
        `V dokumentu byl nalezen možný adresní text: „${recognizedAddress}" — zkontrolujte a případně zkopírujte ručně, automaticky se nevyplňuje.`
      );
    }
    setWarnings(newWarnings);
    setRawText(results.map((r, i) => `--- Soubor ${i + 1} ---\n${r.ocr_raw_text || ""}`).join("\n\n"));
    setOcrMode(results[0]?.ocr_mode);
    setStep(3);
  }, [originCountry, templateId]);

  // Adds newly selected/dropped files to the pending queue and shows
  // their thumbnails right away — recognition itself only starts once
  // the person clicks "Rozpoznat a pokračovat", so they can add several
  // photos (and/or paste text) before triggering the actual processing.
  const addPendingFiles = useCallback((fileList) => {
    const files = Array.from(fileList || []).filter(Boolean);
    if (files.length === 0) return;
    setError(null);
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
    setPendingFiles((prev) => [...prev, ...files]);
    setPreviewUrls((prev) => [...prev, ...previews]);
  }, []);

  const removePendingFile = useCallback((index) => {
    setPreviewUrls((prev) => {
      const removed = prev[index];
      if (removed?.url) URL.revokeObjectURL(removed.url);
      return prev.filter((_, i) => i !== index);
    });
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleConfirmUpload = useCallback(async () => {
    if (pendingFiles.length === 0 && !pastedText.trim()) return;
    setStep(2);
    setError(null);
    try {
      const results = [];
      for (const file of pendingFiles) {
        const data = await uploadFileViaXHR(`${API_BASE}/api/recognize`, file, authHeader);
        results.push(data);
      }
      if (pastedText.trim()) {
        const res = await apiFetch("/api/recognize-text", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: pastedText }),
        });
        if (!res.ok) {
          const err = new Error("server error");
          err.status = res.status;
          throw err;
        }
        results.push(await res.json());
      }
      applyRecognizedResults(results);
    } catch (e) {
      if (e.message === "timeout") {
        setError("Rozpoznávání trvá příliš dlouho (přes 90 s) — server je pravděpodobně přetížený. Zkuste to znovu za chvíli, nebo nahrajte menší/ostřejší fotografii.");
      } else if (e.status === 401) {
        // XHR upload doesn't go through apiFetch — clear the login here
        // too so a 401 from /api/recognize also drops back to LoginForm.
        setAuthHeader(null);
      } else {
        setError(describeRequestError(e.status, "Nepodařilo se rozpoznat dokument."));
      }
      setStep(1);
    }
  }, [pendingFiles, pastedText, applyRecognizedResults, authHeader, apiFetch]);

  const skipUpload = () => {
    setFields({
      ...Object.fromEntries(FIELD_DEFS.map(([k]) => [k, ""])),
      salary: DEFAULT_SALARY_BY_TEMPLATE[templateId] || "",
    });
    setCzAddressParts({});
    setOriginCountry("ua");
    setOriginAddressParts({});
    setWarnings([]);
    setOcrMode(null);
    setDocNumberVerified(false);
    setPreviewUrls((prev) => { prev.forEach((p) => p.url && URL.revokeObjectURL(p.url)); return []; });
    setPendingFiles([]);
    setPastedText("");
    setStep(3);
  };

  const handleGenerate = async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await apiFetch("/api/fill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          template_id: templateId,
          ...fields,
          address: composeCzAddress(czAddressParts),
          address_origin: composeOriginAddress(originCountry, originAddressParts),
        }),
      });
      if (!res.ok) {
        const err = new Error("server error");
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      setResult(data);
      setStep(4);
    } catch (e) {
      if (e.status !== 401) {
        setError(describeRequestError(e.status, "Nepodařilo se vygenerovat dokument."));
      }
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setStep(1);
    setFields({});
    setCzAddressParts({});
    setOriginCountry("ua");
    setOriginAddressParts({});
    setWarnings([]);
    setResult(null);
    setError(null);
    setDownloadError(null);
    setDocNumberVerified(false);
    setPreviewUrls((prev) => { prev.forEach((p) => p.url && URL.revokeObjectURL(p.url)); return []; });
    setPendingFiles([]);
    setPastedText("");
  };

  // Download tokens are single-use — the file is deleted server-side right
  // after being served (see backend/app/main.py /api/download), so a
  // second click on the same link (browser back+retry, opening twice,
  // etc.) now 404s. A plain <a href> can't distinguish that from a normal
  // download, so we fetch the file ourselves and show an honest message
  // instead of a raw browser download-failed error.
  const handleDownload = async (token, { filename, openInNewTab } = {}) => {
    setDownloadError(null);
    try {
      const res = await apiFetch(`/api/download/${token}`);
      if (!res.ok) {
        if (res.status !== 401) {
          setDownloadError(
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
      setDownloadError("Stažení se nezdařilo — zkontrolujte připojení a zkuste to znovu.");
    }
  };

  // Stable identities so AddressBuilder (wrapped in React.memo) doesn't
  // re-render on every keystroke in an unrelated field — plain inline
  // arrow functions here would get a new identity on every render of this
  // component, defeating the memoization. Safe as empty-deps useCallbacks
  // because both only ever use the functional setState form.
  const setCzPart = useCallback((key, value) => {
    setCzAddressParts((prev) => ({ ...prev, [key]: value }));
  }, []);
  const setOriginPart = useCallback((key, value) => {
    setOriginAddressParts((prev) => ({ ...prev, [key]: value }));
  }, []);
  const handleSetOriginCountry = useCallback((next) => {
    // Fields are shared between UA/EU modes (they don't mean the same
    // thing in each — UA has no "country" field, EU has no "oblast"
    // concept) — clear on switch so old values from one mode don't
    // silently leak into the other.
    setOriginCountry(next);
    setOriginAddressParts({});
  }, []);

  // Narrow slice of `fields` for CompanyPicker (also React.memo'd) — its
  // identity only changes when a company_* field actually changes, not on
  // every keystroke elsewhere in the form.
  const companyFields = useMemo(() => ({
    name: fields.company_name || "",
    ico: fields.company_ico || "",
    dic: fields.company_dic || "",
    address: fields.company_address || "",
    representative: fields.company_representative || "",
  }), [fields.company_name, fields.company_ico, fields.company_dic, fields.company_address, fields.company_representative]);

  // "Místo výkonu práce" (workplace) isn't part of a saved company
  // profile — there's no dedicated field for it — but in practice it's
  // almost always the employer's own address, and CompanyPicker never
  // touched it, so switching companies left a stale workplace behind
  // from whichever company was selected before. Defaults it to the
  // current company's address, same protect-manual-edits pattern as the
  // salary default and the geocoded PSČ: only overwrites workplace while
  // it's still empty or still holds exactly what *this* effect last put
  // there, so a value the person typed themselves is never clobbered —
  // and correctly clears it back out if the newly selected company has
  // no address on file, instead of leaving the old one stuck.
  // (An explicit deselect back to "no company chosen" is handled
  // separately and unconditionally in CompanyPicker.jsx's handleSelect —
  // there, no company being selected at all means a company-derived
  // workplace can't make sense regardless of manual edits, unlike
  // switching between two real companies, which this effect protects.)
  const lastAutoFilledWorkplaceRef = useRef(null);
  useEffect(() => {
    const companyAddress = (fields.company_address || "").trim();
    setFields((f) => {
      const currentWorkplace = (f.workplace || "").trim();
      if (currentWorkplace && currentWorkplace !== lastAutoFilledWorkplaceRef.current) {
        return f; // person typed their own value — leave it alone
      }
      lastAutoFilledWorkplaceRef.current = companyAddress || null;
      return { ...f, workplace: companyAddress };
    });
  }, [fields.company_address]);

  // --- Lightbox zoom/pan (mouse wheel to zoom 100%-400%, drag to pan) ---
  // Kept self-contained to the lightbox — doesn't touch how previews are
  // uploaded, recognized, or opened, only what happens once one is open.
  const lightboxImgRef = useRef(null);
  const [lightboxTransform, setLightboxTransform] = useState({ zoom: 1, pan: { x: 0, y: 0 } });
  const lightboxDragRef = useRef(null); // { startX, startY, startPan } while a drag is in progress, else null
  const [isPanningLightbox, setIsPanningLightbox] = useState(false);

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

  if (!authHeader) {
    return <LoginForm onLogin={handleLogin} loading={loggingIn} error={loginError} />;
  }

  return (
    <div
      className="min-h-screen w-full flex items-start justify-center py-10 px-4"
      style={{
        fontFamily: "'Barlow', 'Segoe UI', system-ui, sans-serif",
        background: "var(--gradient-page-bg)",
      }}
    >
      <div className="w-full max-w-xl md:max-w-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 mb-9">
          <div
            className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
            style={PRIMARY_GRADIENT}
          >
            <ShieldCheck size={18} strokeWidth={2.25} className="text-white" />
          </div>
          <div>
            <div
              className="text-[16px] font-semibold tracking-tight text-[#0B1220] leading-none"
              style={{ fontFamily: "'Barlow', sans-serif" }}
            >
              KADR.CZ
            </div>
            <div className="text-[11.5px] text-slate-500 mt-1">Rychlé vyplnění dokumentů</div>
          </div>
        </div>

        {/* Step tracker */}
        <div className="flex items-center gap-1.5 mb-6">
          {["Nahrát", "Rozpoznání", "Vyplnit", "Hotovo"].map((label, i) => {
            const n = i + 1;
            const state = step > n ? "done" : step === n ? "active" : "todo";
            return (
              <div
                key={label}
                className={`flex-1 h-[3px] rounded-full transition-colors ${
                  state === "done" || state === "active" ? "bg-[#185FA5]" : "bg-slate-200"
                }`}
                title={label}
              />
            );
          })}
        </div>
        <div className="flex items-center justify-between mb-8 -mt-4 px-0.5">
          {["Nahrát", "Rozpoznání", "Vyplnit", "Hotovo"].map((label, i) => {
            const n = i + 1;
            const state = step > n ? "done" : step === n ? "active" : "todo";
            return (
              <span
                key={label}
                className={`text-[10.5px] ${state === "todo" ? "text-slate-400" : "text-[#0B1220] font-medium"}`}
              >
                {label}
              </span>
            );
          })}
        </div>

        <div className="rounded-[20px] border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(11,18,32,0.04),0_12px_32px_-16px_rgba(11,18,32,0.18)] overflow-hidden">
          {error && (
            <div className="m-5 mb-0 flex items-start gap-2 rounded-xl bg-red-50 p-3 text-[12.5px] text-red-700">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
            </div>
          )}

          {/* Step 1: upload */}
          {step === 1 && (
            <div className="p-7 md:p-9">
              <h2 className="text-[19px] font-semibold text-[#0B1220]" style={{ fontFamily: "'Barlow', sans-serif" }}>Nahrajte doklady</h2>
              <p className="mt-1 text-[13px] text-slate-500">
                Pas, ID karta, povolení k pobytu, vízum — systém rozpozná a předvyplní údaje
                automaticky. Můžete přidat více souborů i text zároveň (např. pas + vízum).
              </p>

              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); addPendingFiles(e.dataTransfer.files); }}
                className="mt-7 flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-slate-200 bg-slate-50/50 py-10 cursor-pointer hover:border-slate-300 hover:bg-slate-50 transition-colors"
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white border border-slate-200">
                  <Upload size={18} className="text-slate-400" />
                </div>
                <div className="text-center">
                  <div className="text-[13px] font-medium text-[#0B1220]">Přetáhněte soubory nebo klikněte</div>
                  <div className="text-[11.5px] text-slate-400 mt-0.5">JPG, PNG, HEIC, PDF · lze přidat i více najednou</div>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".jpg,.jpeg,.png,.heic,.pdf"
                  className="hidden"
                  onChange={(e) => { addPendingFiles(e.target.files); e.target.value = ""; }}
                />
              </div>

              {previewUrls.length > 0 && (
                <div className="mt-[22px] flex gap-2 flex-wrap">
                  {previewUrls.map((p, i) => (
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
                        onClick={() => removePendingFile(i)}
                        className="absolute top-0.5 right-0.5 flex h-4.5 w-4.5 items-center justify-center rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Odebrat"
                      >
                        <X size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <details className="mt-[22px]">
                <summary className="cursor-pointer text-[12px] text-slate-500 hover:text-[#0B1220]">
                  Nebo vložit text dokladu ručně
                </summary>
                <textarea
                  value={pastedText}
                  onChange={(e) => setPastedText(e.target.value)}
                  placeholder="Vložte sem text dokladu…"
                  rows={5}
                  className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 md:px-4 md:py-3.5 text-[12.5px] md:text-[14px] font-mono text-slate-700 resize-none focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10 focus:border-slate-300"
                />
              </details>

              <div className="mt-7 flex items-center gap-2.5">
                <button
                  onClick={handleConfirmUpload}
                  disabled={pendingFiles.length === 0 && !pastedText.trim()}
                  style={PRIMARY_GRADIENT}
                  className="inline-flex items-center gap-1.5 rounded-xl px-5 py-2.5 md:px-7 md:py-3.5 text-[13px] md:text-[14.5px] font-medium text-white transition-[filter] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Rozpoznat a pokračovat <ArrowRight size={14} />
                </button>
                <button
                  onClick={skipUpload}
                  className="text-[12.5px] text-slate-500 hover:text-[#0B1220] py-1"
                >
                  Přeskočit a vyplnit ručně
                </button>
              </div>
            </div>
          )}

          {/* Step 2: scanning */}
          {step === 2 && (
            <div className="p-7 md:p-9">
              <div className="flex flex-col items-center justify-center gap-4 py-14">
                <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-50 border border-slate-200 overflow-hidden">
                  <FileText size={26} className="text-slate-300" />
                  <div className="absolute left-0 right-0 h-0.5 bg-[#185FA5]/70 animate-[scan_1.6s_ease-in-out_infinite]" />
                </div>
                <div className="flex items-center gap-2 text-[13px] font-medium text-[#0B1220]">
                  <Loader2 size={14} className="animate-spin text-slate-400" /> Rozpoznávám dokument…
                </div>
              </div>
              <style>{`@keyframes scan { 0% { top: 4px; } 50% { top: 60px; } 100% { top: 4px; } }`}</style>
            </div>
          )}

          {/* Step 3: form */}
          {step === 3 && (
            <div className="p-7 md:p-9">
              {previewUrls.length > 0 && (
                <div className="mb-[22px] flex gap-2 flex-wrap">
                  {previewUrls.map((p, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => p.url && setLightboxUrl(p.url)}
                      className={`relative w-16 h-16 rounded-xl border border-slate-200 overflow-hidden bg-slate-50 shrink-0 ${p.url ? "cursor-zoom-in hover:border-slate-300" : "cursor-default"}`}
                      title={p.url ? "Klikněte pro zvětšení" : p.name}
                    >
                      {p.url ? (
                        <img src={p.url} alt={p.name} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-slate-400">
                          <FileText size={18} />
                          <span className="text-[8px] leading-none">{p.isPdf ? "PDF" : "HEIC"}</span>
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {ocrMode === "mock" && (
                <div className="mb-[22px] flex items-center justify-between rounded-xl bg-emerald-50 px-3 py-2">
                  <span className="text-[12px] text-emerald-700 font-medium">Údaje rozpoznány (demo data)</span>
                </div>
              )}
              {warnings.length > 0 && (
                <div className="mb-[22px] space-y-2">
                  {warnings.map((w, i) => (
                    <div key={i} className="flex items-start gap-2 rounded-xl bg-amber-50 p-2.5 text-[12px] text-amber-700">
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {w}
                    </div>
                  ))}
                </div>
              )}

              {rawText && rawText.trim() && (
                <details className="mb-[22px] rounded-xl border border-slate-200 bg-slate-50/60">
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

              <div className="mb-[22px]">
                <label className="text-[11px] md:text-[12px] uppercase tracking-wide text-slate-400">Typ dokumentu</label>
                <select
                  value={templateId || ""}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    setTemplateId(nextId);
                    // Auto-fill (or clear) the salary default for this
                    // contract type — runs every time, even when the new
                    // template has no default (e.g. "ukončení", "výplatní
                    // páska"), so a stale amount from a previous DPP/HPP
                    // selection doesn't linger. Never touches a value the
                    // person typed themselves.
                    const knownDefaults = Object.values(DEFAULT_SALARY_BY_TEMPLATE);
                    const nextDefault = DEFAULT_SALARY_BY_TEMPLATE[nextId] || "";
                    setFields((f) => {
                      const current = (f.salary || "").trim();
                      if (!current || knownDefaults.includes(current)) {
                        return { ...f, salary: nextDefault };
                      }
                      return f;
                    });
                  }}
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 md:px-4 md:py-3.5 text-[13.5px] md:text-[15px] text-[#0B1220] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
                >
                  {blanks.map((b) => (
                    <option key={b.id} value={b.id}>{b.title}</option>
                  ))}
                </select>
              </div>

              {(() => {
                const relevantFields = FIELD_DEFS.filter(([, , scope]) => isFieldRelevant(scope, templateId));
                const personFields = relevantFields.filter(([key]) => PERSON_FIELD_KEYS.has(key));
                const companyReqFields = relevantFields.filter(([key]) => COMPANY_FIELD_KEYS.has(key));
                const restFields = relevantFields.filter(([key]) => !PERSON_FIELD_KEYS.has(key) && !COMPANY_FIELD_KEYS.has(key));

                const renderField = ([key, label]) => {
                  const isMono = key === "doc_number" || key.includes("date") || key === "visa_number";
                  const isUppercase = ["first_name", "last_name", "company_name"].includes(key);
                  const showVerified = key === "doc_number" && docNumberVerified && fields[key];
                  // Advisory only (see utils/validation.js) — flags a likely
                  // typo without blocking generation, since foreign
                  // companies and sole traders without a VAT number are
                  // legitimate cases these checks can't fully account for.
                  const value = fields[key] || "";
                  const showIcoWarning = key === "company_ico" && value.trim() && !isValidIco(value);
                  const showDicWarning = key === "company_dic" && value.trim() && !isValidDic(value);
                  const showWarning = showIcoWarning || showDicWarning;
                  return (
                    <label key={key} className="block">
                      <span className="text-[11px] md:text-[12px] uppercase tracking-wide text-slate-400 inline-flex items-center gap-1.5">
                        {label}
                        {showVerified && (
                          <span className="inline-flex items-center gap-1 rounded-md bg-[#EAF3DE] text-[#3B6D11] text-[9.5px] font-medium px-1.5 py-0.5 normal-case tracking-normal">
                            <Check size={9} strokeWidth={3} /> Ověřeno kontrolním součtem
                          </span>
                        )}
                      </span>
                      <input
                        value={fields[key] || ""}
                        onChange={(e) =>
                          setFields((f) => ({
                            ...f,
                            [key]: isUppercase ? e.target.value.toUpperCase() : e.target.value,
                          }))
                        }
                        style={isMono ? { fontFamily: "'JetBrains Mono', monospace" } : undefined}
                        className={`mt-1 w-full rounded-xl border px-2.5 py-1.5 md:px-3.5 md:py-3 text-[13px] md:text-[14.5px] text-[#0B1220] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10 focus:border-slate-300
                          ${showVerified ? "border-[#97C459] bg-[#F7FBF0]" : showWarning ? "border-amber-300 bg-amber-50/40" : "border-slate-200"}`}
                      />
                      {showIcoWarning && (
                        <span className="mt-1 block text-[10.5px] text-amber-600">
                          Neplatné IČO — zkontrolujte, zda má 8 číslic a souhlasí kontrolní číslice.
                        </span>
                      )}
                      {showDicWarning && (
                        <span className="mt-1 block text-[10.5px] text-amber-600">
                          Neobvyklý formát DIČ — očekává se dvoupísmenný kód země a 8–10 číslic (např. CZ12345678).
                        </span>
                      )}
                    </label>
                  );
                };

                return (
                  <>
                    {/* 1. Person's own data first */}
                    <div className="grid grid-cols-2 gap-x-4 gap-y-4 mb-[22px]">
                      {personFields.map(renderField)}
                    </div>

                    {/* 2. Company section: picker + its own particulars
                        (IČO, název, adresa firmy, zástupce) as one unbroken
                        block, so they read as "the company" rather than
                        being split apart by other sections. Picking the
                        company here also means fields.company_address is
                        already set well before AddressBuilder renders at
                        the very end of the form, so the workplace
                        auto-fill effect (keyed off fields.company_address,
                        not render position) has long since run by the time
                        the person gets to typing an address, and the
                        protect-manual-edits guard never ends up fighting
                        the sync regardless of how far down the page the
                        address section sits. */}
                    <CompanyPicker company={companyFields} setFields={setFields} apiFetch={apiFetch} />
                    <div className="grid grid-cols-2 gap-x-4 gap-y-4 mb-[22px]">
                      {companyReqFields.map(renderField)}
                    </div>

                    {/* 3. Everything else about the employee's contract
                        (position, salary, dates, ...) */}
                    <div className="grid grid-cols-2 gap-x-4 gap-y-4 mb-[22px] max-h-[300px] overflow-y-auto pr-1">
                      {restFields.map(renderField)}
                    </div>

                    {/* 4. Employee's own address, last — a separate,
                        unrelated section that doesn't need to gate anything
                        after it, so it closes out the form. Its own PSČ
                        geocoding is self-contained inside AddressBuilder and
                        equally unaffected by where in the page it renders. */}
                    <div className="mb-4">
                      <AddressBuilder
                        czParts={czAddressParts}
                        setCzPart={setCzPart}
                        originCountry={originCountry}
                        setOriginCountry={handleSetOriginCountry}
                        originParts={originAddressParts}
                        setOriginPart={setOriginPart}
                      />
                    </div>
                  </>
                );
              })()}

              <div className="mt-8 flex justify-between items-center">
                <button
                  onClick={() => {
                    setPreviewUrls((prev) => { prev.forEach((p) => p.url && URL.revokeObjectURL(p.url)); return []; });
                    setPendingFiles([]);
                    setPastedText("");
                    setStep(1);
                  }}
                  className="inline-flex items-center gap-1.5 text-[13px] text-slate-500 hover:text-[#0B1220]"
                >
                  <ArrowLeft size={14} /> Zpět
                </button>
                <button
                  onClick={handleGenerate}
                  disabled={loading || !templateId}
                  style={PRIMARY_GRADIENT}
                  className="inline-flex items-center gap-1.5 rounded-xl px-5 py-2.5 md:px-7 md:py-3.5 text-[13px] md:text-[14.5px] font-medium text-white transition-[filter] hover:brightness-110 disabled:opacity-60"
                >
                  {loading ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
                  {loading ? "Generuji…" : "Vytvořit dokument"}
                </button>
              </div>
            </div>
          )}

          {/* Step 4: done */}
          {step === 4 && result && (
            <div>
              {/* Signature: a torn-stub perforation, echoing an official
                  document/boarding-pass tear line — used once, here, as
                  the one deliberate flourish in an otherwise quiet UI. */}
              <div className="relative flex items-center px-8 pt-2">
                <div className="flex-1 border-t-2 border-dashed border-slate-200" />
              </div>
              <div className="p-8 pt-6 md:p-10 md:pt-8 text-center">
                <div
                  className="mx-auto flex h-14 w-14 items-center justify-center rounded-full text-white"
                  style={{ background: "radial-gradient(circle at 30% 30%, #22a35f, #157a45)" }}
                >
                  <Check size={24} />
                </div>
                <h2 className="mt-4 text-[19px] font-semibold text-[#0B1220]" style={{ fontFamily: "'Barlow', sans-serif" }}>
                  Dokument je hotový
                </h2>
                <p className="mt-1 text-[13px] text-slate-500">Stáhněte si soubor nebo ho rovnou vytiskněte.</p>

                {downloadError && (
                  <div className="mt-[22px] flex items-start gap-2 rounded-xl bg-red-50 p-3 text-[12.5px] text-red-700 text-left">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {downloadError}
                  </div>
                )}

                <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <button
                    type="button"
                    onClick={() => handleDownload(result.docx_token, { filename: result.docx_token })}
                    style={PRIMARY_GRADIENT}
                    className="inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-3 md:px-6 md:py-4 text-[13px] md:text-[14.5px] font-medium text-white transition-[filter] hover:brightness-110"
                  >
                    <Download size={15} /> Stáhnout Word
                  </button>
                  {result.pdf_token && (
                    <button
                      type="button"
                      onClick={() => handleDownload(result.pdf_token, { openInNewTab: true })}
                      className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 px-4 py-3 md:px-6 md:py-4 text-[13px] md:text-[14.5px] font-medium text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-colors"
                    >
                      <Printer size={15} /> Otevřít / Tisk (PDF)
                    </button>
                  )}
                  <button
                    onClick={reset}
                    className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 px-4 py-3 md:px-6 md:py-4 text-[13px] md:text-[14.5px] font-medium text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-colors"
                  >
                    <RotateCcw size={15} /> Nový dokument
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <p className="mt-[22px] text-center text-[11.5px] text-slate-400">
          Údaje o firmách (název, IČO, DIČ, adresa) se ukládají trvale pro
          opakované použití. Vygenerované dokumenty s osobními údaji (doklady,
          mzda, adresa) se neukládají — mažou se hned po stažení. PSČ u
          velkých měst se dohledává podle zadané adresy přes OpenStreetMap
          (© přispěvatelé OpenStreetMap).
        </p>
      </div>

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
