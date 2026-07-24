import { useState, useCallback, useEffect, useRef } from "react";
import { PenLine, Download, ChevronDown, ChevronUp } from "lucide-react";

// localStorage key for the newest signed_at this admin has already seen —
// a plain timestamp cutoff rather than a set of seen tokens, so it stays
// tiny and never needs pruning. Scoped to this one purpose (unlike the
// site-wide auth header's storage key) since it's not sensitive.
const LAST_SEEN_KEY = "kadr_signed_docs_last_seen";

const POLL_INTERVAL_MS = 30_000;

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
  const [expanded, setExpanded] = useState(false);
  const [lastSeenAt, setLastSeenAt] = useState(() => {
    try {
      return localStorage.getItem(LAST_SEEN_KEY);
    } catch {
      return null;
    }
  });
  const downloadErrorRef = useRef(null);
  const [downloadError, setDownloadError] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/sign-links/recent");
      if (!res.ok) {
        setSignedDocs(null);
        return;
      }
      const data = await res.json();
      setSignedDocs(Array.isArray(data) ? data : null);
    } catch {
      setSignedDocs(null);
    }
  }, [apiFetch]);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [load]);

  const hasUnseen = (signedDocs || []).some((d) => !lastSeenAt || d.signed_at > lastSeenAt);

  const toggleExpanded = () => {
    setExpanded((v) => {
      const next = !v;
      if (next) {
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
      }
      return next;
    });
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
      a.download = "smlouva_podepsana.docx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setDownloadError("Stažení se nezdařilo.");
    }
  }, [apiFetch]);

  if (!signedDocs || signedDocs.length === 0) return null;

  return (
    <div className="signed-docs-notifier fixed bottom-4 right-4 z-30 text-left">
      {expanded && (
        <div className="mb-1.5 w-72 max-h-80 overflow-y-auto rounded-xl border border-slate-200 bg-white p-2 shadow-[0_1px_2px_rgba(11,18,32,0.04),0_12px_32px_-16px_rgba(11,18,32,0.25)]">
          <p className="px-1.5 pb-1.5 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">
            Nedávno podepsáno
          </p>
          {downloadError && (
            <p className="px-1.5 pb-1.5 text-[11px] text-red-600">{downloadError}</p>
          )}
          <ul className="space-y-0.5">
            {signedDocs.map((d) => (
              <li key={d.token} className="flex items-center gap-1">
                <div className="flex-1 min-w-0 rounded-md px-1.5 py-1">
                  <div className="truncate text-[12px] text-slate-700">{d.employee_name || "—"}</div>
                  <div className="truncate text-[10.5px] text-slate-400">
                    {d.company_name || "Bez firmy"} · {formatSignedAt(d.signed_at)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => downloadSignedDoc(d.token)}
                  title="Stáhnout podepsaný dokument"
                  className="shrink-0 rounded-md p-1.5 text-slate-400 hover:bg-slate-50 hover:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
                >
                  <Download size={13} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <button
        type="button"
        onClick={toggleExpanded}
        aria-expanded={expanded}
        title="Podepsané dokumenty"
        className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11.5px] font-medium shadow-[0_1px_2px_rgba(11,18,32,0.04),0_8px_20px_-10px_rgba(11,18,32,0.35)] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10 transition-colors ${
          hasUnseen
            ? "signed-docs-lit border-emerald-200 bg-emerald-50 text-emerald-700"
            : "border-slate-200 bg-white/95 text-slate-500 hover:border-slate-300"
        }`}
      >
        <span className={`status-dot ${hasUnseen ? "status-dot-signed" : ""}`} aria-hidden="true" style={!hasUnseen ? { background: "#94a3b8", animation: "none" } : undefined} />
        <PenLine size={13} className="shrink-0" />
        <span className="tabular-nums">{signedDocs.length}</span>
        {expanded ? <ChevronUp size={12} className="shrink-0" /> : <ChevronDown size={12} className="shrink-0" />}
      </button>
    </div>
  );
}
