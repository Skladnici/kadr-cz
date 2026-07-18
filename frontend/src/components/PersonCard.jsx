import { useState } from "react";
import {
  AlertTriangle, Check, ChevronDown, Download, FileText, Link2, Loader2, Printer, X,
} from "lucide-react";
import AddressBuilder from "./AddressBuilder";

// Only these are "OCR should have found this on any ID document" — visa
// fields are legitimately blank on a plain passport/ID card, so flagging
// them empty would just be noise on most cards.
const EXPECTED_FROM_OCR = new Set(["first_name", "last_name", "birth_date", "doc_number"]);

const inputClass =
  "mt-1 w-full rounded-xl border px-2.5 py-1.5 md:px-3.5 md:py-3 text-[13px] md:text-[14.5px] text-[#0B1220] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10 focus:border-slate-300";

function StatusDot({ person }) {
  if (person.status === "recognizing") {
    return <Loader2 size={13} className="shrink-0 animate-spin text-slate-400" title="Rozpoznávám…" />;
  }
  if (person.status === "pending") {
    return <span className="shrink-0 h-2.5 w-2.5 rounded-full bg-slate-200" title="Ve frontě" />;
  }
  if (person.status === "error") {
    return <AlertTriangle size={13} className="shrink-0 text-red-500" title="Chyba rozpoznání" />;
  }
  return person.warnings.length > 0
    ? <AlertTriangle size={13} className="shrink-0 text-amber-500" title="Rozpoznáno s upozorněním" />
    : <Check size={13} strokeWidth={3} className="shrink-0 text-emerald-600" title="Rozpoznáno" />;
}

function OverrideDateRow({ label, enabled, value, sharedValue, onToggle, onChange }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10.5px] md:text-[11.5px] text-slate-500">{label}</span>
        <button type="button" onClick={onToggle} className="text-[11px] font-medium text-[#185FA5] hover:underline shrink-0">
          {enabled ? "Zrušit vlastní datum" : "Upravit pro tuto osobu"}
        </button>
      </div>
      {!enabled ? (
        <p className="mt-1 text-[11.5px] text-slate-500">{sharedValue || "— (společné pro celou dávku)"}</p>
      ) : (
        <input
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          style={{ fontFamily: "'JetBrains Mono', monospace" }}
          className={`${inputClass} border-slate-200 mt-1 max-w-[220px]`}
        />
      )}
    </div>
  );
}

export default function PersonCard({
  person,
  index,
  blanks,
  mergeCandidates,
  sharedCompany,
  sharedStartDate,
  sharedEndDate,
  sharedTemplateId,
  onDownload,
  onRemove,
  onMerge,
  onToggleExpand,
  onOpenLightbox,
  onUpdateFields,
  onUpdateCzPart,
  onUpdateOriginPart,
  onSetOriginCountry,
  onToggleCompanyOverride,
  onUpdateCompanyOverrideField,
  onToggleStartDateOverride,
  onUpdateStartDateOverride,
  onToggleEndDateOverride,
  onUpdateEndDateOverride,
  onToggleTemplateOverride,
  onUpdateTemplateOverride,
}) {
  const [mergeTarget, setMergeTarget] = useState("");
  const displayName = [person.fields.first_name, person.fields.last_name].filter(Boolean).join(" ");
  const hasOverride = person.companyOverrideEnabled || person.startDateOverrideEnabled
    || person.endDateOverrideEnabled || person.templateOverrideEnabled;

  const handleRemoveClick = () => {
    const isFilled = person.status === "done" || person.status === "error";
    if (isFilled && !window.confirm(
      `Opravdu odebrat „${displayName || `Osoba ${index + 1}`}" z dávky? Rozpoznaná ani ručně upravená data se neuloží.`
    )) {
      return;
    }
    onRemove();
  };

  const renderIdentityField = (key, label, { verified } = {}) => {
    const value = person.fields[key] || "";
    const showEmptyWarning = EXPECTED_FROM_OCR.has(key) && person.status === "done" && !value.trim();
    const showVerified = verified && value;
    return (
      <label key={key} className="block">
        <span className="text-[10.5px] md:text-[11.5px] uppercase tracking-wide text-slate-400 inline-flex items-center gap-1.5">
          {label}
          {showVerified && (
            <span className="inline-flex items-center gap-1 rounded-md bg-[#EAF3DE] text-[#3B6D11] text-[9px] font-medium px-1.5 py-0.5 normal-case tracking-normal">
              <Check size={8} strokeWidth={3} /> Ověřeno
            </span>
          )}
        </span>
        <div className="relative">
          <input
            value={value}
            onChange={(e) => onUpdateFields({ [key]: e.target.value })}
            className={`${inputClass} ${showEmptyWarning ? "pr-8 border-amber-300 bg-amber-50/40" : showVerified ? "border-[#97C459] bg-[#F7FBF0]" : "border-slate-200"}`}
          />
          {showEmptyWarning && (
            <AlertTriangle
              size={14}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-amber-500"
              title="OCR se u tohoto pole nepodařilo nic rozpoznat — zkontrolujte a vyplňte ručně."
            />
          )}
        </div>
      </label>
    );
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      {/* Collapsed row */}
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <button
          type="button"
          onClick={onToggleExpand}
          className="flex-1 flex items-center gap-2.5 min-w-0 text-left"
        >
          <StatusDot person={person} />
          <span className="text-[13px] font-medium text-[#0B1220] truncate">
            {displayName || `Osoba ${index + 1}`}
          </span>
          {hasOverride && (
            <span className="shrink-0 rounded-md bg-sky-50 text-sky-700 text-[9.5px] font-medium px-1.5 py-0.5">
              Vlastní nastavení
            </span>
          )}
          <ChevronDown
            size={14}
            className={`shrink-0 text-slate-400 transition-transform ${person.expanded ? "rotate-180" : ""}`}
          />
        </button>
        <button
          type="button"
          onClick={handleRemoveClick}
          title="Odebrat z dávky"
          className="flex h-6 w-6 items-center justify-center rounded-full text-slate-400 hover:bg-slate-200 hover:text-slate-600 shrink-0"
        >
          <X size={13} />
        </button>
      </div>

      {person.expanded && (
        <div className="px-3.5 pb-4 md:px-5 space-y-4 border-t border-slate-100 pt-4">
          {person.status === "error" && (
            <div className="flex items-start gap-2 rounded-xl bg-red-50 p-2.5 text-[12px] text-red-700">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              {person.error || "Rozpoznání se nezdařilo — údaje vyplňte prosím ručně."}
            </div>
          )}
          {person.warnings?.length > 0 && (
            <div className="space-y-1.5">
              {person.warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-2 rounded-xl bg-amber-50 p-2 text-[11.5px] text-amber-700">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {w}
                </div>
              ))}
            </div>
          )}

          {/* Naskenované doklady */}
          <div>
            <div className="text-[11px] md:text-[12px] uppercase tracking-wide text-slate-400 mb-2">Naskenované doklady</div>
            <div className="flex gap-2 flex-wrap">
              {person.previews.map((p, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => p.url && onOpenLightbox(p.url)}
                  className={`relative w-16 h-16 rounded-xl border border-slate-200 overflow-hidden bg-slate-50 shrink-0 ${p.url ? "cursor-zoom-in hover:border-slate-300" : "cursor-default"}`}
                  title={p.url ? "Klikněte pro zvětšení" : p.name}
                >
                  {p.url ? (
                    <img src={p.url} alt={p.name} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-slate-400">
                      <FileText size={16} />
                      <span className="text-[8px] leading-none">{p.isPdf ? "PDF" : "HEIC"}</span>
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Merge with another card (passport + visa of the same person) */}
          {mergeCandidates.length > 0 && (
            <div className="flex items-center gap-2 rounded-xl border border-dashed border-slate-200 p-2.5">
              <Link2 size={13} className="text-slate-400 shrink-0" />
              <select
                value={mergeTarget}
                onChange={(e) => setMergeTarget(e.target.value)}
                className="flex-1 min-w-0 rounded-lg border border-slate-200 px-2 py-1.5 text-[12px] bg-white focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
              >
                <option value="">Sloučit s další kartou (pas + vízum téže osoby)…</option>
                {mergeCandidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {[c.fields.first_name, c.fields.last_name].filter(Boolean).join(" ") || c.previews[0]?.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!mergeTarget}
                onClick={() => { onMerge(mergeTarget); setMergeTarget(""); }}
                className="shrink-0 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11.5px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
              >
                Sloučit
              </button>
            </div>
          )}

          {/* Údaje z pasu */}
          <div>
            <div className="text-[11px] md:text-[12px] uppercase tracking-wide text-slate-400 mb-2">Údaje z pasu</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-3">
              {renderIdentityField("first_name", "Jméno")}
              {renderIdentityField("last_name", "Příjmení")}
              {renderIdentityField("birth_date", "Datum narození")}
              {renderIdentityField("doc_number", "Číslo pasu", { verified: person.docNumberVerified })}
            </div>
          </div>

          {/* Údaje z víza */}
          <div>
            <div className="text-[11px] md:text-[12px] uppercase tracking-wide text-slate-400 mb-2">
              Údaje z víza <span className="normal-case text-slate-400">(jen pro cizince)</span>
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-3">
              {renderIdentityField("residence_type", "Typ víza")}
              {renderIdentityField("visa_number", "Číslo víza")}
              {renderIdentityField("visa_validity", "Platnost víza do")}
            </div>
          </div>

          {/* Adresa v ČR + Adresa v zemi původu */}
          <AddressBuilder
            czParts={person.czAddressParts}
            setCzPart={onUpdateCzPart}
            originCountry={person.originCountry}
            setOriginCountry={onSetOriginCountry}
            originParts={person.originAddressParts}
            setOriginPart={onUpdateOriginPart}
          />

          {/* Individuální nastavení — přepíše společné hodnoty */}
          <div className="rounded-xl border border-slate-200 p-3 bg-slate-50/40 space-y-3">
            <div className="text-[11px] md:text-[12px] uppercase tracking-wide text-slate-400">
              Individuální nastavení (přepíše společné hodnoty)
            </div>

            <div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10.5px] md:text-[11.5px] text-slate-500">Firma</span>
                <button
                  type="button"
                  onClick={onToggleCompanyOverride}
                  className="text-[11px] font-medium text-[#185FA5] hover:underline shrink-0"
                >
                  {person.companyOverrideEnabled ? "Zrušit vlastní firmu" : "Upravit pro tuto osobu"}
                </button>
              </div>
              {!person.companyOverrideEnabled ? (
                <p className="mt-1 text-[11.5px] text-slate-500">{sharedCompany.name || "— (společné pro celou dávku)"}</p>
              ) : (
                <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-3">
                  {[
                    ["name", "Firma (zaměstnavatel)"],
                    ["ico", "IČO"],
                    ["dic", "DIČ"],
                    ["address", "Adresa firmy"],
                    ["representative", "Zástupce firmy"],
                  ].map(([key, label]) => (
                    <label key={key} className="block">
                      <span className="text-[10.5px] md:text-[11.5px] uppercase tracking-wide text-slate-400">{label}</span>
                      <input
                        value={person.companyOverride[key] || ""}
                        onChange={(e) => onUpdateCompanyOverrideField(key, e.target.value)}
                        className={`${inputClass} border-slate-200`}
                      />
                    </label>
                  ))}
                </div>
              )}
            </div>

            <OverrideDateRow
              label="Datum nástupu"
              enabled={person.startDateOverrideEnabled}
              value={person.startDateOverride}
              sharedValue={sharedStartDate}
              onToggle={onToggleStartDateOverride}
              onChange={onUpdateStartDateOverride}
            />
            <OverrideDateRow
              label="Datum ukončení"
              enabled={person.endDateOverrideEnabled}
              value={person.endDateOverride}
              sharedValue={sharedEndDate}
              onToggle={onToggleEndDateOverride}
              onChange={onUpdateEndDateOverride}
            />

            <div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10.5px] md:text-[11.5px] text-slate-500">Typ smlouvy</span>
                <button
                  type="button"
                  onClick={onToggleTemplateOverride}
                  className="text-[11px] font-medium text-[#185FA5] hover:underline shrink-0"
                >
                  {person.templateOverrideEnabled ? "Zrušit vlastní typ" : "Upravit pro tuto osobu"}
                </button>
              </div>
              {!person.templateOverrideEnabled ? (
                <p className="mt-1 text-[11.5px] text-slate-500">
                  {blanks.find((b) => b.id === sharedTemplateId)?.title || "— (společné pro celou dávku)"}
                </p>
              ) : (
                <select
                  value={person.templateOverride || ""}
                  onChange={(e) => onUpdateTemplateOverride(e.target.value)}
                  className={`${inputClass} border-slate-200 mt-1`}
                >
                  {blanks.map((b) => (
                    <option key={b.id} value={b.id}>{b.title}</option>
                  ))}
                </select>
              )}
            </div>
          </div>

          {person.generation?.status === "generating" && (
            <div className="flex items-center gap-2 text-[12px] text-slate-500">
              <Loader2 size={13} className="animate-spin" /> Generuji dokument…
            </div>
          )}
          {person.generation?.status === "error" && (
            <div className="flex items-start gap-2 rounded-xl bg-red-50 p-2.5 text-[12px] text-red-700">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {person.generation.error}
            </div>
          )}
          {person.generation?.status === "done" && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => onDownload(person.generation.docxToken, { filename: person.generation.docxToken })}
                className="inline-flex items-center gap-1.5 rounded-xl bg-[#0B1220] px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110"
              >
                <Download size={13} /> Word
              </button>
              {person.generation.pdfToken && (
                <button
                  type="button"
                  onClick={() => onDownload(person.generation.pdfToken, { openInNewTab: true })}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-1.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50"
                >
                  <Printer size={13} /> PDF
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
