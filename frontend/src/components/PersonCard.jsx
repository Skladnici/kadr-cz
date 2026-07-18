import { AlertTriangle, Check, Download, Loader2, Printer, User, X } from "lucide-react";
import AddressBuilder from "./AddressBuilder";
import { FIELD_DEFS, PERSON_FIELD_KEYS } from "../constants/fields";

// Same order/labels as the single-person form's "person" section
// (SimpleDocFiller.jsx's personFields) — reusing FIELD_DEFS directly
// instead of a hand-picked list keeps batch mode's identity fields
// exactly in sync with single mode's, including if that list ever changes.
const PERSON_FIELDS = FIELD_DEFS.filter(([key]) => PERSON_FIELD_KEYS.has(key));

// Only these are "OCR should have found this on any ID document" —
// visa_number/visa_validity/residence_type are legitimately blank on a
// plain passport/ID card, so flagging them empty would just be noise on
// most cards.
const EXPECTED_FROM_OCR = new Set(["first_name", "last_name", "birth_date", "doc_number"]);

const inputClass =
  "mt-1 w-full rounded-xl border px-2.5 py-1.5 md:px-3.5 md:py-3 text-[13px] md:text-[14.5px] text-[#0B1220] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10 focus:border-slate-300";

function StatusBadge({ status }) {
  if (status === "recognizing") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 text-slate-500 text-[10.5px] font-medium px-1.5 py-0.5">
        <Loader2 size={10} className="animate-spin" /> Rozpoznávám…
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-red-50 text-red-600 text-[10.5px] font-medium px-1.5 py-0.5">
        <AlertTriangle size={10} /> Chyba rozpoznání
      </span>
    );
  }
  if (status === "done") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-[#EAF3DE] text-[#3B6D11] text-[10.5px] font-medium px-1.5 py-0.5">
        <Check size={10} strokeWidth={3} /> Rozpoznáno
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 text-slate-400 text-[10.5px] font-medium px-1.5 py-0.5">
      Ve frontě
    </span>
  );
}

export default function PersonCard({
  person,
  index,
  onUpdateFields,
  onUpdateCzPart,
  onUpdateOriginPart,
  onSetOriginCountry,
  onToggleCompanyOverride,
  onUpdateCompanyOverrideField,
  onToggleStartDateOverride,
  onUpdateStartDateOverride,
  onRemove,
  sharedCompany,
  sharedStartDate,
  onDownload,
}) {
  const displayName = [person.fields.first_name, person.fields.last_name].filter(Boolean).join(" ");

  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <div className="flex items-center gap-3 px-3 py-2.5 md:px-4 md:py-3 bg-slate-50/60 border-b border-slate-200">
        <div className="relative w-9 h-9 rounded-lg border border-slate-200 overflow-hidden bg-white shrink-0">
          {person.previewUrl ? (
            <img src={person.previewUrl} alt={person.fileName} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-slate-300">
              <User size={16} />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-[#0B1220] truncate">
            {displayName || `Osoba ${index + 1}`}
          </div>
          <div className="text-[10.5px] text-slate-400 truncate">{person.fileName}</div>
        </div>
        <StatusBadge status={person.status} />
        <button
          type="button"
          onClick={onRemove}
          title="Odebrat"
          className="flex h-6 w-6 items-center justify-center rounded-full text-slate-400 hover:bg-slate-200 hover:text-slate-600 shrink-0"
        >
          <X size={13} />
        </button>
      </div>

      <div className="p-3 md:p-5 space-y-4">
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

        <div className="grid grid-cols-2 gap-x-3 gap-y-3">
          {PERSON_FIELDS.map(([key, label]) => {
            const value = person.fields[key] || "";
            const showVerified = key === "doc_number" && person.docNumberVerified && value;
            const showEmptyWarning =
              EXPECTED_FROM_OCR.has(key) && person.status === "done" && !value.trim();
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
          })}
        </div>

        <AddressBuilder
          czParts={person.czAddressParts}
          setCzPart={onUpdateCzPart}
          originCountry={person.originCountry}
          setOriginCountry={onSetOriginCountry}
          originParts={person.originAddressParts}
          setOriginPart={onUpdateOriginPart}
        />

        {/* Company and start date default to the shared values set once at
            the top of the batch — these two independent toggles are the
            only per-card override the task calls for, so every other
            contract field (salary, position, ...) stays purely shared
            with no override UI here. */}
        <div className="rounded-xl border border-slate-200 p-3 bg-slate-50/40 space-y-3">
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10.5px] md:text-[11.5px] uppercase tracking-wide text-slate-400">Firma</span>
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

          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10.5px] md:text-[11.5px] uppercase tracking-wide text-slate-400">Datum nástupu</span>
              <button
                type="button"
                onClick={onToggleStartDateOverride}
                className="text-[11px] font-medium text-[#185FA5] hover:underline shrink-0"
              >
                {person.startDateOverrideEnabled ? "Zrušit vlastní datum" : "Upravit pro tuto osobu"}
              </button>
            </div>
            {!person.startDateOverrideEnabled ? (
              <p className="mt-1 text-[11.5px] text-slate-500">{sharedStartDate || "— (společné pro celou dávku)"}</p>
            ) : (
              <input
                value={person.startDateOverride || ""}
                onChange={(e) => onUpdateStartDateOverride(e.target.value)}
                className={`${inputClass} border-slate-200 mt-1 max-w-[220px]`}
              />
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
    </div>
  );
}
