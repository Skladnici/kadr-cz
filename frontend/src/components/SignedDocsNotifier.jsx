import { useState, useCallback, useEffect, useRef } from "react";
import { Bell, Download, ChevronDown, ChevronUp } from "lucide-react";
import { playSignChime } from "../utils/signSound";

// localStorage key for the newest signed_at this admin has already seen —
// a plain timestamp cutoff rather than a set of seen tokens, so it stays
// tiny and never needs pruning. Scoped to this one purpose (unlike the
// site-wide auth header's storage key) since it's not sensitive.
const LAST_SEEN_KEY = "kadr_signed_docs_last_seen";

const POLL_INTERVAL_MS = 30_000;

// How long the collapse animation runs before the panel actually unmounts
// (see closeTimeoutRef below) — matches signedDocsPanelOut's own duration
// in index.css so the DOM node disappears right as the fade-out finishes,
// same "unmount timer kept in sync with the CSS" pattern WelcomeToast uses.
const CLOSE_ANIM_MS = 180;

function formatSignedAt(iso) {
  try {
    return new Date(iso).toLocaleString("cs-CZ", {
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return "";
  }
}

// Separate, self-contained corner indicator for "someone just signed a
// contract through their link" — deliberately NOT part of StatsWidget.jsx
// (company/document-type counts): that widget answers "how much work has
// this company generated", a fundamentally different question from "did
// a real person just sign something I should know about". Polls
// GET /api/sign-links/recent (only ever real signatures — see that
// route's own docstring) since signing happens on the employee's own
// device, not as a result of anything the admin does here.
//
// Fully hidden with nothing signed yet; a small neutral icon once there's
// history to browse; lights up (green, pulsing) only while at least one
// signing hasn't been seen yet — "seen" meaning the admin has opened this
// panel since, tracked via one timestamp in localStorage rather than a
// server-side per-admin read state this app has no login-per-person
// concept to hang that off of.
export default function SignedDocsNotifier({ apiFetch }) {
  const [signedDocs, setSignedDocs] = useState(null); // null = not loaded / unavailable
  // { generated, signed } document totals — separate from signedDocs
  // (which is only the last 24h of not-yet-downloaded signatures, see
  // get_recent_signed_links's own docstring) since this is meant to read
  // as an overall "how much work, how much of it done" summary, visible
  // before ever opening the panel.
  const [totals, setTotals] = useState(null);
  const [expanded, setExpanded] = useState(false);
  // True only for the ~180ms the collapse animation is playing — the
  // panel stays mounted (with the "out" animation class) until then, see
  // closeTimeoutRef below. Without this the list just vanished instantly
  // on click, no matter how the open animation looked.
  const [closing, setClosing] = useState(false);
  const closeTimeoutRef = useRef(null);
  const [lastSeenAt, setLastSeenAt] = useState(() => {
    try {
      return localStorage.getItem(LAST_SEEN_KEY);
    } catch {
      return null;
    }
  });
  const downloadErrorRef = useRef(null);
  const [downloadError, setDownloadError] = useState(null);

  // "New" here means "arrived since the last poll", tracked as a plain
  // signed_at cutoff independent of lastSeenAt/localStorage above — that
  // one is about the panel's own unread glow across sessions, this one
  // is purely "did a live sign event just happen while this tab was
  // open". undefined (not yet initialized) makes the very first load
  // after mount establish the baseline silently instead of chiming for a
  // whole backlog of pre-existing signatures.
  const chimedUpToRef = useRef(undefined);
  const flashTimeoutRef = useRef(null);
  const pingTimeoutRef = useRef(null);
  const newItemsTimeoutRef = useRef(null);
  const [bellFlash, setBellFlash] = useState(false);
  const [pingBadge, setPingBadge] = useState(false);
  const [newlyArrivedTokens, setNewlyArrivedTokens] = useState(() => new Set());

  const detectNewSignatures = useCallback((list) => {
    if (!list || list.length === 0) return;
    const newest = list[0].signed_at;
    if (chimedUpToRef.current === undefined) {
      chimedUpToRef.current = newest;
      return;
    }
    if (!(newest > chimedUpToRef.current)) return;
    const freshTokens = list
      .filter((d) => d.signed_at > chimedUpToRef.current)
      .map((d) => d.token);
    chimedUpToRef.current = newest;

    playSignChime();

    setBellFlash(true);
    clearTimeout(flashTimeoutRef.current);
    flashTimeoutRef.current = setTimeout(() => setBellFlash(false), 1100);

    setPingBadge(true);
    clearTimeout(pingTimeoutRef.current);
    pingTimeoutRef.current = setTimeout(() => setPingBadge(false), 1000);

    setNewlyArrivedTokens((prev) => new Set([...prev, ...freshTokens]));
    clearTimeout(newItemsTimeoutRef.current);
    newItemsTimeoutRef.current = setTimeout(() => {
      setNewlyArrivedTokens((prev) => {
        const next = new Set(prev);
        freshTokens.forEach((t) => next.delete(t));
        return next;
      });
    }, 1400);
  }, []);

  const load = useCallback(async () => {
    let list = null;
    try {
      const res = await apiFetch("/api/sign-links/recent");
      if (!res.ok) {
        setSignedDocs(null);
        return;
      }
      const data = await res.json();
      list = Array.isArray(data) ? data : null;
      setSignedDocs(list);
    } catch {
      setSignedDocs(null);
    }

    // Deliberately outside the fetch's own try/catch above — a problem in
    // the chime/animation path (audio permissions, whatever) must never
    // get swallowed together with a real network error, nor reset
    // signedDocs back to null on its own.
    try {
      detectNewSignatures(list);
    } catch (err) {
      console.error("sign chime/animation failed:", err);
    }

    // Supplementary, same as StatsWidget's own by-type fetch — a failure
    // here just means the summary line doesn't show, not that the whole
    // notifier disappears. generation_stats_by_person's all_signed is the
    // same per-person "this person's whole document set is signed" flag
    // StatsWidget's own dots already use, summed here into one number
    // instead of shown per row.
    try {
      const res = await apiFetch("/api/stats/by-person");
      const data = res.ok ? await res.json() : [];
      if (Array.isArray(data)) {
        const generated = data.reduce((sum, row) => sum + (row.document_count || 0), 0);
        const signed = data.reduce((sum, row) => sum + (row.all_signed ? (row.document_count || 0) : 0), 0);
        setTotals({ generated, signed });
      }
    } catch {
      // leave totals as whatever they already were
    }
  }, [apiFetch, detectNewSignatures]);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_INTERVAL_MS);
    // A background/inactive tab is exactly the common real case here — an
    // admin creates a link, switches away to send it (WhatsApp, email,
    // whatever), and only comes back after the employee has signed.
    // Browsers throttle (sometimes near-freeze) setInterval in a
    // backgrounded tab, so the 30s poll alone can leave a real signature
    // sitting unreflected for a long time — a real "the indicator didn't
    // update" report traced back to exactly this. Forcing one fresh load
    // the moment the tab becomes visible again closes that gap without
    // needing to poll any more aggressively while it's in the foreground.
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  useEffect(() => () => {
    clearTimeout(closeTimeoutRef.current);
    clearTimeout(flashTimeoutRef.current);
    clearTimeout(pingTimeoutRef.current);
    clearTimeout(newItemsTimeoutRef.current);
  }, []);

  const hasUnseen = (signedDocs || []).some((d) => !lastSeenAt || d.signed_at > lastSeenAt);

  const toggleExpanded = () => {
    if (expanded) {
      // Play the "out" animation, then actually unmount — see
      // CLOSE_ANIM_MS/.signed-docs-panel-out.
      clearTimeout(closeTimeoutRef.current);
      setClosing(true);
      closeTimeoutRef.current = setTimeout(() => {
        setExpanded(false);
        setClosing(false);
      }, CLOSE_ANIM_MS);
      return;
    }
    setExpanded(true);
    // Opening the panel is what "acknowledges" everything currently
    // in the list — the newest signed_at becomes the new cutoff, so
    // the glow only comes back once something NEWER arrives.
    const newest = (signedDocs || [])[0]?.signed_at;
    if (newest) {
      try {
        localStorage.setItem(LAST_SEEN_KEY, newest);
      } catch {
        // ignored — worst case the glow reappears next load, harmless
      }
      setLastSeenAt(newest);
    }
  };

  const downloadSignedDoc = useCallback(async (token) => {
    downloadErrorRef.current = null;
    setDownloadError(null);
    try {
      const res = await apiFetch(`/api/sign-links/${token}/download`);
      if (!res.ok) {
        setDownloadError("Stažení se nezdařilo.");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "podepsane_dokumenty.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setDownloadError("Stažení se nezdařilo.");
    }
  }, [apiFetch]);

  // Hidden only when there's truly nothing to report at all — previously
  // gated on signedDocs.length alone, which hid the whole widget (totals
  // summary included) as soon as every recent signature had already been
  // downloaded/expired out of the 24h window, even with a long history of
  // generated/signed documents still worth showing at a glance.
  const hasAnyHistory = (signedDocs && signedDocs.length > 0) || (totals && totals.generated > 0);
  if (!hasAnyHistory) return null;

  return (
    <div className="signed-docs-notifier fixed bottom-4 right-4 z-30 text-left">
      {(expanded || closing) && (
        <div className={`mb-1.5 w-72 max-h-80 overflow-y-auto rounded-xl border border-slate-200 bg-white p-2 shadow-[0_1px_2px_rgba(11,18,32,0.04),0_12px_32px_-16px_rgba(11,18,32,0.25)] ${closing ? "signed-docs-panel-out" : "signed-docs-panel-in"}`}>
          <p className="px-1.5 pb-1.5 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">
            Nedávno podepsáno
          </p>
          {downloadError && (
            <p className="px-1.5 pb-1.5 text-[11px] text-red-600">{downloadError}</p>
          )}
          {(!signedDocs || signedDocs.length === 0) ? (
            <p className="px-1.5 pb-1 text-[11.5px] text-slate-400">Zatím nic nečeká na stažení.</p>
          ) : (
            <ul className="space-y-0.5">
              {signedDocs.map((d) => (
                <li
                  key={d.token}
                  className={`flex items-center gap-1 ${newlyArrivedTokens.has(d.token) ? "signed-doc-item-new" : ""}`}
                >
                  <div className="flex-1 min-w-0 rounded-md px-1.5 py-1">
                    <div className="truncate text-[12px] text-slate-700">{d.employee_name || "—"}</div>
                    <div className="truncate text-[10.5px] text-slate-400">
                      {d.company_name || "Bez firmy"} · {formatSignedAt(d.signed_at)}
                      {newlyArrivedTokens.has(d.token) && (
                        <span className="ml-1.5 font-medium text-emerald-600">Podepsáno</span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => downloadSignedDoc(d.token)}
                    title="Stáhnout podepsané dokumenty"
                    className="shrink-0 rounded-md p-1.5 text-slate-400 hover:bg-slate-50 hover:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
                  >
                    <Download size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={toggleExpanded}
        aria-expanded={expanded}
        title="Podepsané dokumenty"
        className={`relative flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11.5px] font-medium shadow-[0_1px_2px_rgba(11,18,32,0.04),0_8px_20px_-10px_rgba(11,18,32,0.35)] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10 transition-colors ${bellFlash ? "signed-docs-bell-flash" : ""} ${
          hasUnseen
            ? "signed-docs-lit border-emerald-200 bg-emerald-50 text-emerald-700"
            : "border-slate-200 bg-white/95 text-slate-500 hover:border-slate-300"
        }`}
      >
        <span className={`status-dot ${hasUnseen ? "status-dot-signed" : ""}`} aria-hidden="true" style={!hasUnseen ? { background: "#94a3b8", animation: "none" } : undefined} />
        <span className="relative shrink-0">
          <Bell size={13} />
          {pingBadge && <span className="signed-docs-ping-badge" aria-hidden="true" />}
        </span>
        {/* Always signedDocs.length — the exact same array that drives
            the glow/list above — never totals.signed. A real incident:
            totals.signed comes from /api/stats/by-person's all_signed,
            which depends on _apply_signed_status finding a generation_log
            row with a matching company_name/employee_name after the
            employee signs (see that function's own docstring) — a
            mismatch there (formatting, timing, a row that was never
            there to match) silently updates zero rows, no error, and
            this showed "0 podepsáno" for a signature that had, in fact,
            just genuinely happened — exactly what get_recent_signed_
            links' own docstring already warned this second metric would
            be "actively misleading" for. signedDocs came from
            /api/sign-links/recent, sign_links.signed_at only, no
            secondary join to go stale. */}
        <span className="tabular-nums whitespace-nowrap">{(signedDocs || []).length} podepsáno</span>
        {expanded ? <ChevronUp size={12} className="shrink-0" /> : <ChevronDown size={12} className="shrink-0" />}
      </button>
    </div>
  );
}
