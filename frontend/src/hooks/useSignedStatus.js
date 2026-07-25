import { useState, useEffect, useCallback } from "react";

const POLL_INTERVAL_MS = 30_000;

function statsKey(companyName, employeeName) {
  const company = (companyName || "").trim() || "Bez firmy";
  return `${company}::${(employeeName || "").trim()}`;
}

// Powers the "Čeká na podpis" -> "Podepsáno" status pill shown next to a
// created e-signature link (SimpleDocFiller.jsx, PersonCard.jsx). Reuses
// the same generation_stats_by_person view SignedDocsNotifier/StatsWidget
// already read — all_signed is true only once every document logged for
// that exact company+employee pair has a signed_at — rather than
// inventing a second, per-token way to ask "is this person signed yet".
//
// `enabled` defaults to true for BatchDocFiller (already only mounted
// after login). SimpleDocFiller calls this hook itself, above its own
// "not logged in yet" early return — unconditionally, since hooks can't
// be called conditionally — so it passes `enabled: !!authHeader` to
// keep this from polling with a missing/invalid Authorization header
// while the login form is still showing.
export default function useSignedStatus(apiFetch, enabled = true) {
  const [byPerson, setByPerson] = useState(() => new Map());

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/stats/by-person");
      const data = res.ok ? await res.json() : [];
      if (Array.isArray(data)) {
        const map = new Map();
        for (const row of data) {
          map.set(statsKey(row.company_name, row.employee_name), !!row.all_signed);
        }
        setByPerson(map);
      }
    } catch {
      // leave byPerson as whatever it already was — a failed poll
      // shouldn't flip every pill back to "waiting"
    }
  }, [apiFetch]);

  useEffect(() => {
    if (!enabled) return;
    load();
    const id = setInterval(load, POLL_INTERVAL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, enabled]);

  return useCallback(
    (companyName, employeeName) => byPerson.get(statsKey(companyName, employeeName)) || false,
    [byPerson]
  );
}
