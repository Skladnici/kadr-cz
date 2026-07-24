import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Download, Loader2, PenLine, ShieldCheck } from "lucide-react";
import { API_BASE } from "../utils/api";

const PRIMARY_GRADIENT = { background: "var(--gradient-primary)" };

// The public, no-login page an employee opens from a /podepsat/{token}
// link (see SimpleDocFiller/PersonCard's "Vytvořit odkaz k podpisu").
// Every request here is unauthenticated on purpose — the token itself is
// the credential (see backend's create_sign_links_table.sql). Phases:
//
//   loading -> invalid | error
//           -> reading   (already signed on reload -> skips straight to "done")
//           -> signing   (canvas)
//           -> submitting
//           -> done       (download button)
//           -> downloaded (one-time download used up)
export default function SignPage({ token }) {
  const [phase, setPhase] = useState("loading");
  const [info, setInfo] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [hasSignature, setHasSignature] = useState(false);

  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/podepsat/${token}`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (!data.valid) {
          setPhase("invalid");
          return;
        }
        setInfo(data);
        setPhase(data.signed ? "done" : "reading");
      })
      .catch(() => {
        if (!cancelled) setPhase("error");
      });
    return () => { cancelled = true; };
  }, [token]);

  // Sized once when the signing canvas mounts — devicePixelRatio-scaled
  // so the drawn line stays crisp on retina screens instead of blurry.
  const canvasRefCallback = useCallback((node) => {
    canvasRef.current = node;
    if (!node) return;
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = node.clientWidth;
    const cssHeight = node.clientHeight;
    node.width = cssWidth * dpr;
    node.height = cssHeight * dpr;
    const ctx = node.getContext("2d");
    ctx.scale(dpr, dpr);
  }, []);

  const pointFromEvent = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const handlePointerDown = (e) => {
    e.target.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    lastPointRef.current = pointFromEvent(e);
  };

  const handlePointerMove = (e) => {
    if (!drawingRef.current) return;
    const ctx = canvasRef.current.getContext("2d");
    const point = pointFromEvent(e);
    const last = lastPointRef.current;
    ctx.strokeStyle = "#0B1220";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    lastPointRef.current = point;
    setHasSignature(true);
  };

  const handlePointerUp = () => {
    drawingRef.current = false;
  };

  const clearSignature = () => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasSignature(false);
  };

  const submitSignature = async () => {
    setActionError(null);
    setPhase("submitting");
    try {
      const dataUrl = canvasRef.current.toDataURL("image/png");
      const res = await fetch(`${API_BASE}/api/podepsat/${token}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature_image: dataUrl }),
      });
      if (!res.ok) {
        // A 400 here can mean "already signed" (e.g. another tab/device
        // beat this one to it, or a double-submit) rather than a real
        // failure — the document IS signed either way, just not by this
        // exact request, so check before showing a scary error that
        // retrying would only repeat.
        if (res.status === 400) {
          const check = await fetch(`${API_BASE}/api/podepsat/${token}`).then((r) => r.json()).catch(() => null);
          if (check?.signed) {
            setPhase("done");
            return;
          }
        }
        throw new Error("sign failed");
      }
      setPhase("done");
    } catch {
      setActionError("Nepodařilo se uložit podpis. Zkuste to prosím znovu.");
      setPhase("signing");
    }
  };

  const downloadSigned = async () => {
    setActionError(null);
    try {
      const res = await fetch(`${API_BASE}/api/podepsat/${token}/download`);
      if (!res.ok) throw new Error("download failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "smlouva_podepsana.docx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setPhase("downloaded");
    } catch {
      setActionError("Stažení se nezdařilo. Zkuste to prosím znovu.");
    }
  };

  return (
    <div
      className="min-h-screen w-full flex items-center justify-center px-4 py-8"
      style={{ fontFamily: "'Barlow', 'Segoe UI', system-ui, sans-serif", background: "var(--gradient-page-bg)" }}
    >
      <div className="w-full max-w-lg rounded-[20px] border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(11,18,32,0.04),0_12px_32px_-16px_rgba(11,18,32,0.18)] p-7 md:p-9">
        <div className="flex items-center gap-3 mb-6">
          <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full" style={PRIMARY_GRADIENT}>
            <ShieldCheck size={18} strokeWidth={2.25} className="text-white" />
          </div>
          <div>
            <div className="text-[16px] font-semibold tracking-tight text-[#0B1220] leading-none" style={{ fontFamily: "'Barlow', sans-serif" }}>
              KADR.CZ
            </div>
            <div className="text-[11.5px] text-slate-500 mt-1">Podpis dokumentu</div>
          </div>
        </div>

        {phase === "loading" && (
          <div className="flex items-center justify-center gap-2 py-10 text-slate-500">
            <Loader2 size={18} className="animate-spin" /> Načítám…
          </div>
        )}

        {phase === "invalid" && (
          <div className="flex items-start gap-2 rounded-xl bg-red-50 p-4 text-[13px] text-red-700">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            Tento odkaz již není platný.
          </div>
        )}

        {phase === "error" && (
          <div className="flex items-start gap-2 rounded-xl bg-red-50 p-4 text-[13px] text-red-700">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            Nepodařilo se spojit se serverem. Zkuste to prosím znovu později.
          </div>
        )}

        {phase === "reading" && (
          <>
            {info?.employee_name && (
              <p className="mb-3 text-[13px] text-slate-500">
                Dobrý den, <strong className="text-[#0B1220]">{info.employee_name}</strong> — přečtěte si prosím dokument níže a poté jej podepište.
              </p>
            )}
            <div className="rounded-xl border border-slate-200 overflow-hidden bg-slate-50" style={{ height: "60vh", minHeight: 320 }}>
              <iframe
                title="Náhled dokumentu k podpisu"
                src={`${API_BASE}/api/podepsat/${token}/pdf`}
                className="w-full h-full"
              />
            </div>
            <button
              type="button"
              onClick={() => setPhase("signing")}
              style={PRIMARY_GRADIENT}
              className="mt-5 w-full inline-flex items-center justify-center gap-1.5 rounded-xl px-5 py-3 text-[14px] font-medium text-white transition-[filter] hover:brightness-110"
            >
              Přečteno, pokračovat
            </button>
          </>
        )}

        {(phase === "signing" || phase === "submitting") && (
          <>
            <p className="mb-3 text-[13px] text-slate-500">
              Podepište prosím prstem, myší nebo stylusem do rámečku níže.
            </p>
            <div className="rounded-xl border-2 border-dashed border-slate-300 bg-slate-50">
              <canvas
                ref={canvasRefCallback}
                className="w-full touch-none"
                style={{ height: 180 }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerLeave={handlePointerUp}
              />
            </div>
            {!hasSignature && (
              <p className="mt-1.5 flex items-center gap-1 text-[11.5px] text-slate-400">
                <PenLine size={12} /> Zatím nic nenakresleno.
              </p>
            )}

            {actionError && (
              <div className="mt-3 flex items-start gap-2 rounded-xl bg-red-50 p-3 text-[12.5px] text-red-700">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {actionError}
              </div>
            )}

            <div className="mt-5 grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={clearSignature}
                disabled={phase === "submitting"}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 px-4 py-3 text-[13.5px] font-medium text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Vymazat
              </button>
              <button
                type="button"
                onClick={submitSignature}
                disabled={!hasSignature || phase === "submitting"}
                style={PRIMARY_GRADIENT}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-3 text-[13.5px] font-medium text-white transition-[filter] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {phase === "submitting" && <Loader2 size={14} className="animate-spin" />}
                Potvrdit podpis
              </button>
            </div>
          </>
        )}

        {phase === "done" && (
          <div className="text-center py-4">
            <div
              className="mx-auto flex h-14 w-14 items-center justify-center rounded-full text-white"
              style={{ background: "radial-gradient(circle at 30% 30%, #22a35f, #157a45)" }}
            >
              <Check size={24} />
            </div>
            <h2 className="mt-4 text-[17px] font-semibold text-[#0B1220]" style={{ fontFamily: "'Barlow', sans-serif" }}>
              Dokument je podepsán
            </h2>
            <p className="mt-1 text-[13px] text-slate-500">Stáhněte si svou podepsanou kopii.</p>

            {actionError && (
              <div className="mt-4 flex items-start gap-2 rounded-xl bg-red-50 p-3 text-[12.5px] text-red-700 text-left">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {actionError}
              </div>
            )}

            <button
              type="button"
              onClick={downloadSigned}
              style={PRIMARY_GRADIENT}
              className="mt-6 inline-flex items-center justify-center gap-1.5 rounded-xl px-5 py-3 text-[14px] font-medium text-white transition-[filter] hover:brightness-110"
            >
              <Download size={15} /> Stáhnout podepsaný dokument
            </button>
          </div>
        )}

        {phase === "downloaded" && (
          <div className="text-center py-4">
            <div
              className="mx-auto flex h-14 w-14 items-center justify-center rounded-full text-white"
              style={{ background: "radial-gradient(circle at 30% 30%, #22a35f, #157a45)" }}
            >
              <Check size={24} />
            </div>
            <h2 className="mt-4 text-[17px] font-semibold text-[#0B1220]" style={{ fontFamily: "'Barlow', sans-serif" }}>
              Staženo
            </h2>
            <p className="mt-1 text-[13px] text-slate-500">Dokument byl úspěšně stažen. Tento odkaz je nyní neaktivní.</p>
          </div>
        )}
      </div>
    </div>
  );
}
