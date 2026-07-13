import { useState } from "react";
import { ShieldCheck, AlertTriangle, Loader2 } from "lucide-react";

// Same accent used for SimpleDocFiller's per-screen primary buttons and
// header badge — see index.css's --gradient-primary for the single
// source of truth on the actual color stops.
const PRIMARY_GRADIENT = { background: "var(--gradient-primary)" };

export default function LoginForm({ onLogin, loading, error }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const submit = (e) => {
    e.preventDefault();
    if (!username || !password || loading) return;
    onLogin(username, password);
  };

  return (
    <div
      className="min-h-screen w-full flex items-center justify-center px-4"
      style={{ fontFamily: "'Barlow', 'Segoe UI', system-ui, sans-serif", background: "var(--gradient-page-bg)" }}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-[20px] border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(11,18,32,0.04),0_12px_32px_-16px_rgba(11,18,32,0.18)] p-7 md:p-9"
      >
        <div className="flex items-center gap-3 mb-6">
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
            <div className="text-[11.5px] text-slate-500 mt-1">Přihlášení</div>
          </div>
        </div>

        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-xl bg-red-50 p-3 text-[12.5px] text-red-700">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}

        <label className="block mb-4">
          <span className="text-[11px] md:text-[12px] uppercase tracking-wide text-slate-400">Uživatelské jméno</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            className="mt-1 w-full rounded-xl border border-slate-200 px-2.5 py-1.5 md:px-3.5 md:py-3 text-[13px] md:text-[14.5px] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
          />
        </label>
        <label className="block mb-7">
          <span className="text-[11px] md:text-[12px] uppercase tracking-wide text-slate-400">Heslo</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className="mt-1 w-full rounded-xl border border-slate-200 px-2.5 py-1.5 md:px-3.5 md:py-3 text-[13px] md:text-[14.5px] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
          />
        </label>

        <button
          type="submit"
          disabled={loading || !username || !password}
          style={PRIMARY_GRADIENT}
          className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl px-5 py-2.5 md:px-6 md:py-3.5 text-[13px] md:text-[14px] font-medium text-white transition-[filter] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {loading && <Loader2 size={14} className="animate-spin" />}
          {loading ? "Přihlašuji…" : "Přihlásit se"}
        </button>
      </form>
    </div>
  );
}
