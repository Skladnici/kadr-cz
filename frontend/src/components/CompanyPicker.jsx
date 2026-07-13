import { useState, useCallback, useEffect, memo } from "react";
import { describeRequestError } from "../utils/api";

// Saved company profiles persist server-side (Supabase, not localStorage)
// so the same list shows up for everyone using the site, on any computer
// — pick one from the dropdown to auto-fill, or save the currently typed
// values as a new (or updated) profile.

// CompanyPicker only mounts while step 3 ("Vyplnit") is showing, and gets
// unmounted/remounted every time the user goes back to step 1 and works on
// another document. Without this cache, each remount would needlessly
// re-fetch data that hasn't changed — even though the user never left the
// "companies" section conceptually, just moved to a different document in
// the same visit. Module-level so it survives remounts but resets on a
// real page reload (a fresh page load always starts logged out again —
// see LoginForm/apiFetch in SimpleDocFiller).
let companiesCache = null;

// `company` is the {name, ico, dic, address, representative} slice of the
// form's fields, not the whole `fields` object — SimpleDocFiller derives
// it with useMemo so its identity only changes when a company_* field
// actually changes. That, plus memo() here, means typing in an unrelated
// field (salary, position, ...) doesn't re-render this component or
// re-run its effects.
function CompanyPicker({ company, setFields, apiFetch }) {
  const [companies, setCompanies] = useState(companiesCache || []);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const loadCompanies = useCallback(async (force = false) => {
    if (!force && companiesCache) {
      setCompanies(companiesCache);
      return;
    }
    try {
      const res = await apiFetch("/api/companies");
      if (!res.ok) {
        // A 401 already made apiFetch drop back to the login form — no
        // need to also show an error message behind it.
        if (res.status !== 401) {
          setError(describeRequestError(res.status, "Sdílené firmy se nepodařilo načíst."));
        }
        return;
      }
      const data = await res.json();
      companiesCache = data;
      setCompanies(data);
      setError(null);
    } catch {
      setError("Sdílené firmy se nepodařilo načíst — zkontrolujte připojení k internetu.");
    }
  }, [apiFetch]);

  useEffect(() => { loadCompanies(); }, [loadCompanies]);

  const applyCompany = (c) => {
    setFields((f) => ({
      ...f,
      company_name: (c.name || "").toUpperCase(),
      company_ico: c.ico || "",
      company_dic: c.dic || "",
      company_address: c.address || "",
      company_representative: c.representative || "",
    }));
  };

  const handleSelect = (id) => {
    setSelectedId(id);
    if (!id) {
      // "— Vybrat uloženou firmu —" chosen — clear the fields rather
      // than leaving whatever the previously selected company filled in.
      // workplace is included here too even though it isn't a company_*
      // field: SimpleDocFiller.jsx syncs it from company_address, but
      // only ever *protects* a manually-typed workplace from being
      // overwritten by a different company's address — it deliberately
      // doesn't force it to "" on its own, since company_address turning
      // empty also happens when a real, selected company just has no
      // address on file. An explicit deselect back to "no company at
      // all" is unambiguous though: a workplace tied to "the selected
      // company's address" stops making sense once there's no selected
      // company, manual edit or not — so it's cleared unconditionally
      // here, not left to the protective sync effect.
      setFields((f) => ({
        ...f,
        company_name: "",
        company_ico: "",
        company_dic: "",
        company_address: "",
        company_representative: "",
        workplace: "",
      }));
      return;
    }
    const c = companies.find((c) => c.id === id);
    if (c) applyCompany(c);
  };

  const handleSaveCurrent = async () => {
    if (!company.name?.trim()) return;
    setLoading(true);
    setError(null);
    const profile = {
      name: company.name || "",
      ico: company.ico || "",
      dic: company.dic || "",
      address: company.address || "",
      representative: company.representative || "",
    };
    try {
      const res = await apiFetch(
        selectedId ? `/api/companies/${selectedId}` : "/api/companies",
        {
          method: selectedId ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(profile),
        }
      );
      if (!res.ok) {
        if (res.status !== 401) {
          setError(describeRequestError(res.status, "Uložení se nezdařilo."));
        }
        return;
      }
      const saved = await res.json();
      await loadCompanies(true); // force: the list just changed server-side
      setSelectedId(saved.id);
    } catch {
      setError("Uložení se nezdařilo — zkontrolujte připojení k internetu.");
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/companies/${selectedId}`, { method: "DELETE" });
      if (!res.ok) {
        if (res.status !== 401) {
          setError(describeRequestError(res.status, "Smazání se nezdařilo."));
        }
        return;
      }
      setSelectedId("");
      await loadCompanies(true); // force: the list just changed server-side
    } catch {
      setError("Smazání se nezdařilo — zkontrolujte připojení k internetu.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 p-3 md:p-6 bg-slate-50/40 mb-4">
      <div className="text-[11px] md:text-[12px] uppercase tracking-wide text-slate-400 mb-2">Sdílené firmy</div>
      {error && <p className="mb-2 text-[11.5px] text-red-600">{error}</p>}
      <div className="flex gap-2 items-center flex-wrap">
        <select
          value={selectedId}
          onChange={(e) => handleSelect(e.target.value)}
          className="flex-1 min-w-[160px] rounded-xl border border-slate-200 px-2.5 py-1.5 md:px-3.5 md:py-3 text-[13px] md:text-[14.5px] bg-white focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
        >
          <option value="">— Vybrat uloženou firmu —</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleSaveCurrent}
          disabled={loading}
          className="rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 md:px-4 md:py-3 text-[12px] md:text-[13.5px] font-medium text-slate-600 hover:bg-slate-50 whitespace-nowrap disabled:opacity-50"
        >
          {selectedId ? "Aktualizovat" : "Uložit jako novou"}
        </button>
        {selectedId && (
          <button
            type="button"
            onClick={handleDelete}
            disabled={loading}
            className="rounded-xl border border-red-200 bg-white px-2.5 py-1.5 md:px-4 md:py-3 text-[12px] md:text-[13.5px] font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            Smazat
          </button>
        )}
      </div>
      <p className="mt-1.5 text-[10.5px] text-slate-400">
        Firmy jsou uložené na serveru — vidí je kdokoliv, kdo tento web používá.
      </p>
    </div>
  );
}

export default memo(CompanyPicker);
