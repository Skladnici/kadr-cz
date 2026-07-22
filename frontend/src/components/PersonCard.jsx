import { useCallback, useMemo, useState } from "react";
import {
  AlertTriangle, Check, ChevronDown, FileText, Link2, Loader2, Scissors, X,
} from "lucide-react";
import AddressBuilder from "./AddressBuilder";
import MinorWarningIcon from "./MinorWarningIcon";
import VisaExpiredWarningIcon from "./VisaExpiredWarningIcon";
import StrpeniWarningIcon from "./StrpeniWarningIcon";
import { calculateAge, isPastDate } from "../utils/age";
import { isStrpeniVisaCode } from "../utils/visaStatus";

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

// Warns when only one of passport/visa was found for this card —
// "Číslo víza" etc. living in a section that never got filled in isn't
// obvious just from the fields themselves. Says nothing once both are
// found and merged — merging is now fully automatic (see canAutoMerge
// in BatchDocFiller), so announcing that it happened is just noise the
// person filling out paperwork doesn't need.
function missingDocumentLabel(person) {
  if (person.status !== "done" || person.rawResults.length >= 2) return null;
  const hasVisa = person.rawResults.some((r) => r.doc_type === "Vízum");
  return hasVisa ? "Pouze vízum, pas nenalezen" : "Pouze pas, vízum nenalezeno";
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
  sharedCompany,
  sharedStartDate,
  sharedEndDate,
  sharedTemplateId,
  onRemove,
  onSplit,
  mergeCandidates,
  onManualMerge,
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
  // Starts closed every time the card itself is (re-)expanded — matches
  // "hidden by default, only opens on an explicit click" literally rather
  // than remembering whether it was open on a previous expand.
  const [individualOpen, setIndividualOpen] = useState(false);
  // Manual-merge fallback for when canAutoMerge's birth-date match missed
  // (OCR non-determinism — see BatchDocFiller's handleManualMerge) — a
  // pending selection, not committed until "Sloučit" is clicked, same
  // shape as the override toggles below.
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState("");
  const displayName = [person.fields.first_name, person.fields.last_name].filter(Boolean).join(" ");
  const hasOverride = person.companyOverrideEnabled || person.startDateOverrideEnabled
    || person.endDateOverrideEnabled || person.templateOverrideEnabled;
  const missingDocLabel = missingDocumentLabel(person);
  // Same advisory-only minor-age check as single mode (see
  // SimpleDocFiller's identical computation) — reused as-is rather than
  // a separate batch implementation, so both modes flag exactly the
  // same birth dates the same way. Never blocks generation.
  const personAge = useMemo(() => calculateAge(person.fields.birth_date), [person.fields.birth_date]);
  const isPersonMinor = personAge !== null && personAge < 18;
  // Same advisory-only check as SimpleDocFiller's own (see utils/age.js's
  // isPastDate) — reused as-is so both modes flag the same expired visas.
  const isVisaExpiredWarning = useMemo(
    () => isPastDate(person.fields.visa_validity),
    [person.fields.visa_validity]
  );
  const isStrpeniWarning = useMemo(
    () => isStrpeniVisaCode(person.fields.visa_type_code),
    [person.fields.visa_type_code]
  );

  // Binds this card's id once via useCallback so AddressBuilder sees a
  // stable setCzPart/setOriginPart/setOriginCountry reference across
  // renders, same as SimpleDocFiller's own useCallback-wrapped setters —
  // AddressBuilder's PSČ geocoding effect depends on that reference staying
  // stable to let its 1s debounce actually complete instead of restarting
  // (and aborting any in-flight Nominatim request) on every unrelated
  // batch re-render. onUpdateCzPart/onUpdateOriginPart/onSetOriginCountry
  // themselves are stable (id, key, value) updaters from BatchDocFiller.
  const setCzPart = useCallback(
    (key, value) => onUpdateCzPart(person.id, key, value),
    [onUpdateCzPart, person.id]
  );
  const setOriginPart = useCallback(
    (key, value) => onUpdateOriginPart(person.id, key, value),
    [onUpdateOriginPart, person.id]
  );
  const setOriginCountry = useCallback(
    (country) => onSetOriginCountry(person.id, country),
    [onSetOriginCountry, person.id]
  );

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
    // Same field, same styling as SimpleDocFiller's own birth_date
    // handling — an empty-field warning takes priority when both would
    // otherwise apply (an empty date can't have a computed age anyway).
    const showMinorBorder = key === "birth_date" && isPersonMinor && !showEmptyWarning;
    const showVisaExpiredBorder = key === "visa_validity" && isVisaExpiredWarning && !showEmptyWarning;
    // Shown on visa_number (the field printed with the visa's own "CZE
    // ######" number) rather than residence_type — residence_type is a
    // free-text field OCR never fills in and isn't shown in this grid at
    // all anymore (see the collapsed "Druh pobytu" details below), while
    // visa_number is always visible here for every visa card, so that's
    // where the badge needs to live to actually be seen.
    const showStrpeniBadge = key === "visa_number" && isStrpeniWarning;
    const showBadge = showMinorBorder || showVisaExpiredBorder || showStrpeniBadge;
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
            className={`${inputClass} ${showEmptyWarning || showBadge ? "pr-8 " : ""}${showEmptyWarning || showBadge ? "border-amber-300 bg-amber-50/40" : showVerified ? "border-[#97C459] bg-[#F7FBF0]" : "border-slate-200"}`}
          />
          {showEmptyWarning && (
            <AlertTriangle
              size={14}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-amber-500"
              title="OCR se u tohoto pole nepodařilo nic rozpoznat — zkontrolujte a vyplňte ručně."
            />
          )}
          {showMinorBorder && <MinorWarningIcon />}
          {showVisaExpiredBorder && <VisaExpiredWarningIcon />}
          {showStrpeniBadge && <StrpeniWarningIcon />}
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
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium text-[#0B1220] truncate">
                {displayName || `Osoba ${index + 1}`}
              </span>
              {hasOverride && (
                <span className="shrink-0 rounded-md bg-sky-50 text-sky-700 text-[9.5px] font-medium px-1.5 py-0.5">
                  Vlastní nastavení
                </span>
              )}
            </div>
            {missingDocLabel && <div className="text-[10.5px] text-slate-400 mt-0.5">{missingDocLabel}</div>}
          </div>
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
          {(person.warnings?.length > 0 || person.addressHint) && (
            <div className="space-y-1.5">
              {person.warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-2 rounded-xl bg-amber-50 p-2 text-[11.5px] text-amber-700">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {w}
                </div>
              ))}
              {/* Shown here (expanded detail) but deliberately excluded
                  from StatusDot's warning count above — see
                  recognizeMerge.js's addressHint comment for why an
                  address merely being present isn't a "needs review"
                  signal the way an actual OCR/merge warning is. */}
              {person.addressHint && (
                <div className="flex items-start gap-2 rounded-xl bg-amber-50 p-2 text-[11.5px] text-amber-700">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {person.addressHint}
                </div>
              )}
            </div>
          )}

          {/* Naskenované doklady */}
          <div>
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="text-[11px] md:text-[12px] uppercase tracking-wide text-slate-400">Naskenované doklady</div>
              {person.rawResults.length >= 2 && (
                <button
                  type="button"
                  onClick={onSplit}
                  title="Rozdělit zpět na samostatné karty"
                  className="shrink-0 inline-flex items-center gap-1 text-[11px] font-medium text-slate-400 hover:text-slate-600"
                >
                  <Scissors size={11} /> Rozdělit
                </button>
              )}
            </div>
            <div className="flex gap-2 flex-wrap">
              {person.previews.map((p, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    // TEMP DEBUG — remove once the multi-photo lightbox
                    // bug is confirmed fixed on a real auto-merged card.
                    // Search "LIGHTBOX-DEBUG" to find every line to strip.
                    console.log("[LIGHTBOX-DEBUG] thumbnail clicked:", {
                      index: i,
                      totalPreviews: person.previews.length,
                      name: p.name,
                      url: p.url,
                      isPdf: p.isPdf,
                      isHeic: p.isHeic,
                      allPreviewUrls: person.previews.map((pv) => pv.url),
                    });
                    if (p.url) onOpenLightbox(p.url);
                  }}
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
            {/* Manual fallback for when canAutoMerge's birth-date match
                missed — see BatchDocFiller's handleManualMerge comment
                for why this is needed even with matching people (OCR
                non-determinism, not a bug this UI can fix outright). */}
            {person.status === "done" && mergeCandidates?.length > 0 && (
              <div className="mt-2">
                {!mergeOpen ? (
                  <button
                    type="button"
                    onClick={() => setMergeOpen(true)}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-400 hover:text-slate-600"
                  >
                    <Link2 size={11} /> Sloučit s jinou kartou
                  </button>
                ) : (
                  <div className="flex items-center gap-2 flex-wrap">
                    <select
                      value={mergeTargetId}
                      onChange={(e) => setMergeTargetId(e.target.value)}
                      className="rounded-lg border border-slate-200 px-2 py-1 text-[11.5px] text-[#0B1220] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
                    >
                      <option value="">— vyberte osobu —</option>
                      {mergeCandidates.map((c) => (
                        <option key={c.id} value={c.id}>
                          {[c.fields.first_name, c.fields.last_name].filter(Boolean).join(" ") || c.fields.doc_number || "(bez jména)"}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={!mergeTargetId}
                      onClick={() => {
                        onManualMerge(mergeTargetId);
                        setMergeOpen(false);
                        setMergeTargetId("");
                      }}
                      className="text-[11px] font-medium text-[#185FA5] hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Sloučit
                    </button>
                    <button
                      type="button"
                      onClick={() => { setMergeOpen(false); setMergeTargetId(""); }}
                      className="text-[11px] font-medium text-slate-400 hover:text-slate-600"
                    >
                      Zrušit
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

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
              {renderIdentityField("visa_number", "Číslo víza")}
              {renderIdentityField("visa_validity", "Platnost víza do")}
            </div>
            {/* Collapsed by default — OCR never fills this in (it's
                free text describing the residence permit category for
                the printed contract, not anything printed verbatim on
                the visa itself), so it'd otherwise sit empty on every
                single card. Still the same "residence_type" field sent
                to /api/fill as DRUH_POBYTU when it *is* filled in. */}
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] text-slate-500 hover:text-[#0B1220]">
                Druh pobytu na území ČR (nepovinné)
              </summary>
              <input
                value={person.fields.residence_type || ""}
                onChange={(e) => onUpdateFields({ residence_type: e.target.value })}
                className={`${inputClass} border-slate-200 mt-2`}
              />
            </details>
          </div>

          {/* Adresa v ČR + Adresa v zemi původu */}
          <AddressBuilder
            czParts={person.czAddressParts}
            setCzPart={setCzPart}
            originCountry={person.originCountry}
            setOriginCountry={setOriginCountry}
            originParts={person.originAddressParts}
            setOriginPart={setOriginPart}
          />

          {/* Individuální nastavení — přepíše společné hodnoty. Hidden by
              default (every card already inherits the shared company/
              dates/typ smlouvy automatically) — only opens on request, so
              reviewing a batch of ordinary cards doesn't mean scrolling
              past four override toggles per person for nothing. */}
          {!individualOpen ? (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 p-3 bg-slate-50/40">
              <span className="text-[11.5px] text-slate-500">
                {hasOverride ? "Firma/datum: použito vlastní nastavení pro tuto osobu" : "Firma/datum: použity společné hodnoty výše"}
              </span>
              <button
                type="button"
                onClick={() => setIndividualOpen(true)}
                className="shrink-0 text-[11px] font-medium text-[#185FA5] hover:underline"
              >
                Nastavit jinak pro tuto osobu
              </button>
            </div>
          ) : (
          <div className="rounded-xl border border-slate-200 p-3 bg-slate-50/40 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] md:text-[12px] uppercase tracking-wide text-slate-400">
                Individuální nastavení (přepíše společné hodnoty)
              </span>
              <button
                type="button"
                onClick={() => setIndividualOpen(false)}
                className="shrink-0 text-[11px] font-medium text-slate-400 hover:text-slate-600"
              >
                Skrýt
              </button>
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
          )}

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
          {/* No per-card download here on purpose — downloading one
              contract at a time defeated the point of batch mode.
              Download/print for everyone lives once, at the bottom of
              the batch, as "Stáhnout všechny"/"Otevřít / Tisk všechny". */}
          {person.generation?.status === "done" && (
            <div className="flex items-center gap-1.5 text-[12px] text-emerald-700">
              <Check size={13} strokeWidth={3} /> Dokument vygenerován — stáhněte pomocí tlačítek pod seznamem osob.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
