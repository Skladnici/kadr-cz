import { useState, useCallback, useEffect, useMemo } from "react";
import { Building2, ChevronDown, ChevronUp } from "lucide-react";

// Czech noun declension for "document(s)" depends on the count: 1 =
// dokument, 2-4 = dokumenty, 0 or 5+ = dokumentů.
function pluralizeDocs(n) {
  if (n === 1) return "dokument";
  if (n >= 2 && n <= 4) return "dokumenty";
  return "dokumentů";
}

// Fixed to the corner rather than laid out in the document flow — a
// glanceable, always-available counter that shouldn't compete with or
// shift the main form. Renders nothing at all (not an error banner) when
// /api/stats isn't reachable or Supabase isn't configured on the server:
// this is a decorative extra, not something worth interrupting the
// actual document-filling flow over. `refreshSignal` is bumped by
// SimpleDocFiller right after each successful generation so the count
// updates without a page reload — see its own comment for why a plain
// prop bump was used instead of some shared event bus.
export default function StatsWidget({ apiFetch, refreshSignal }) {
  const [stats, setStats] = useState(null); // null = hidden (not loaded yet, or unavailable)
  const [statsByType, setStatsByType] = useState([]);
  const [expanded, setExpanded] = useState(false);
  // Set of company_name — which company rows have their per-document-type
  // breakdown open. A Set (not a single "which one" value) so several
  // companies can be expanded independently at once, each toggled on its
  // own click without affecting the others.
  const [expandedCompanies, setExpandedCompanies] = useState(() => new Set());

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/stats");
      if (!res.ok) {
        setStats(null);
        return;
      }
      const data = await res.json();
      setStats(Array.isArray(data) ? data : null);
    } catch {
      setStats(null);
    }

    // The by-type breakdown is supplementary detail, not the widget's core
    // feature — a failure here just means expanded rows show no detail
    // rather than hiding the whole widget the way a failed /api/stats does.
    try {
      const res = await apiFetch("/api/stats/by-type");
      const data = res.ok ? await res.json() : [];
      setStatsByType(Array.isArray(data) ? data : []);
    } catch {
      setStatsByType([]);
    }
  }, [apiFetch]);

  useEffect(() => {
    load();
  }, [load, refreshSignal]);

  const byTypeByCompany = useMemo(() => {
    const map = {};
    for (const row of statsByType) {
      (map[row.company_name] ||= []).push(row);
    }
    return map;
  }, [statsByType]);

  const toggleCompany = useCallback((companyName) => {
    setExpandedCompanies((prev) => {
      const next = new Set(prev);
      if (next.has(companyName)) next.delete(companyName);
      else next.add(companyName);
      return next;
    });
  }, []);

  if (stats === null) return null;

  const total = stats.reduce((sum, s) => sum + (s.document_count || 0), 0);

  return (
    <div className="fixed top-4 right-4 z-30 text-left">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white/95 px-3 py-1.5 text-[11.5px] font-medium text-slate-600 shadow-[0_1px_2px_rgba(11,18,32,0.04),0_8px_20px_-10px_rgba(11,18,32,0.35)] hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
      >
        <Building2 size={13} className="shrink-0 text-[#185FA5]" />
        <span className="tabular-nums">{total} {pluralizeDocs(total)}</span>
        {expanded ? <ChevronUp size={12} className="shrink-0" /> : <ChevronDown size={12} className="shrink-0" />}
      </button>

      {expanded && (
        <div className="mt-1.5 w-64 max-h-80 overflow-y-auto rounded-xl border border-slate-200 bg-white p-2 shadow-[0_1px_2px_rgba(11,18,32,0.04),0_12px_32px_-16px_rgba(11,18,32,0.25)]">
          {stats.length === 0 ? (
            <p className="px-1.5 py-1 text-[11.5px] text-slate-400">Zatím žádné dokumenty.</p>
          ) : (
            <ul>
              {stats.map((s) => {
                const isOpen = expandedCompanies.has(s.company_name);
                const byType = byTypeByCompany[s.company_name] || [];
                return (
                  <li key={s.company_name}>
                    <button
                      type="button"
                      onClick={() => toggleCompany(s.company_name)}
                      aria-expanded={isOpen}
                      className="flex w-full items-center justify-between gap-2 rounded-lg px-1.5 py-1 text-[12px] text-slate-600 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
                    >
                      <span className="truncate">{s.company_name}</span>
                      <span className="flex shrink-0 items-center gap-1">
                        <span className="font-semibold text-[#0B1220] tabular-nums">{s.document_count}</span>
                        {isOpen
                          ? <ChevronUp size={11} className="shrink-0 text-slate-400" />
                          : <ChevronDown size={11} className="shrink-0 text-slate-400" />}
                      </span>
                    </button>
                    {isOpen && (
                      <p className="px-1.5 pb-1.5 pt-0.5 text-[11px] text-slate-400">
                        {byType.length > 0
                          ? byType.map((t) => `${t.document_type}: ${t.document_count}`).join(" · ")
                          : "Žádná data podle typu."}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
