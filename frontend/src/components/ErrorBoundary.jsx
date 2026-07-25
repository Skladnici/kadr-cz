import { Component } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

// A blank white screen (React 18's createRoot unmounts the whole tree on
// any uncaught render error, with nothing rendered in its place) is the
// worst possible failure mode for SignPage.jsx specifically — an
// employee hitting it has no console to check and no other way to reach
// the document, unlike the logged-in admin app where a refresh/relogin
// is an obvious next step. This boundary is the last line of defense so
// that failure always shows a plain-language message instead of nothing.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // No error-reporting service wired up — this is still strictly
    // better than losing the error entirely to a blank screen.
    console.error("ErrorBoundary caught:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          className="min-h-screen w-full flex items-center justify-center px-4 py-8"
          style={{ fontFamily: "'Barlow', 'Segoe UI', system-ui, sans-serif", background: "var(--gradient-page-bg)" }}
        >
          <div className="w-full max-w-md rounded-[20px] border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(11,18,32,0.04),0_12px_32px_-16px_rgba(11,18,32,0.18)] p-7 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-red-50 text-red-600">
              <AlertTriangle size={22} />
            </div>
            <h2 className="mt-4 text-[16px] font-semibold text-[#0B1220]" style={{ fontFamily: "'Barlow', sans-serif" }}>
              Něco se pokazilo
            </h2>
            <p className="mt-1.5 text-[13px] text-slate-500">
              Stránku se nepodařilo zobrazit. Zkuste ji prosím načíst znovu — pokud problém přetrvá, kontaktujte toho, kdo vám odkaz poslal.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-5 inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 px-4 py-2.5 text-[13px] font-medium text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-colors"
            >
              <RotateCcw size={14} /> Načíst znovu
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
