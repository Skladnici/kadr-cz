import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Download, FileText, Loader2, PenLine, RotateCcw, ShieldCheck } from "lucide-react";
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
  const [pdfUrl, setPdfUrl] = useState(null);
  const [pdfError, setPdfError] = useState(false);
  const [pdfRetryCount, setPdfRetryCount] = useState(0);
  // True once the first status-check attempt has failed and a retry is
  // pending — lets the "loading" screen explain *why* it's taking a
  // while (see the retry loop below) instead of leaving a bare spinner
  // up that looks identical to a hang.
  const [wakingUp, setWakingUp] = useState(false);
  const [statusRetryCount, setStatusRetryCount] = useState(0);

  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef(null);

  // The backend (Render free tier — see NASAZENI.md) sleeps after 15 min
  // idle; its first request after that can take 30-60s to even start
  // responding, and can also see a transient connection failure along
  // the way rather than just being slow (confirmed by a real "site
  // refuses to connect" report from an employee opening a cold link).
  // A single fetch() with no retry turned that ordinary, expected wait
  // into a dead-end error screen. Retrying with backoff here — silently,
  // before ever bothering the person with an error — means a cold
  // backend just costs a slightly longer spinner instead of a broken
  // link. statusRetryCount lets the "Zkusit znovu" button on the error
  // screen re-run this same effect from attempt zero.
  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    setWakingUp(false);

    const delays = [0, 3000, 6000, 10000, 15000, 20000]; // ~54s of backoff across 6 attempts
    let attempt = 0;

    const tryFetch = () => {
      fetch(`${API_BASE}/api/podepsat/${token}`)
        .then((res) => {
          if (!res.ok) throw new Error("status check failed");
          return res.json();
        })
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
          if (cancelled) return;
          attempt += 1;
          if (attempt >= delays.length) {
            setPhase("error");
            return;
          }
          setWakingUp(true);
          setTimeout(() => { if (!cancelled) tryFetch(); }, delays[attempt]);
        });
    };
    tryFetch();

    return () => { cancelled = true; };
  }, [token, statusRetryCount]);

  // Fetched as a blob (not used directly as an <iframe src>) so the "open
  // the contract" link below works as a plain same-origin blob URL —
  // opening it in a new tab is what actually renders a PDF reliably on
  // every device, including in-app browsers (WhatsApp/Telegram, etc.)
  // that frequently show nothing at all for an embedded cross-origin PDF
  // iframe, which is what a blank-screen report on a real phone almost
  // always turns out to be.
  useEffect(() => {
    if (phase !== "reading") return;
    let cancelled = false;
    setPdfError(false);
    setPdfUrl(null);
    fetch(`${API_BASE}/api/podepsat/${token}/pdf`)
      .then((res) => {
        if (!res.ok) throw new Error("pdf failed");
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        setPdfUrl(URL.createObjectURL(blob));
      })
      .catch(() => {
        if (!cancelled) setPdfError(true);
      });
    return () => { cancelled = true; };
  }, [phase, token, pdfRetryCount]);

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

  // The signing box is a wide, mostly-empty rectangle — most people sign
  // a small mark somewhere inside it rather than filling it edge to
  // edge. Exporting the raw canvas as-is means that small mark is what
  // gets scaled down to the fixed Mm(35) width in the generated document
  // (see render_signed_contract's InlineImage), so it prints as a barely
  // visible speck. Cropping to the actual ink's bounding box first (plus
  // a small margin) means the signature — not the surrounding blank
  // canvas — is what fills that 35mm, at a normal, legible size on paper.
  const croppedSignatureDataUrl = () => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const { width, height } = canvas;
    const { data } = ctx.getImageData(0, 0, width, height);

    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX || maxY < minY) return canvas.toDataURL("image/png"); // nothing drawn — shouldn't happen (button is disabled without hasSignature)

    const margin = Math.round(Math.min(width, height) * 0.04);
    const cropX = Math.max(0, minX - margin);
    const cropY = Math.max(0, minY - margin);
    const cropW = Math.min(width, maxX + margin) - cropX;
    const cropH = Math.min(height, maxY + margin) - cropY;

    const cropCanvas = document.createElement("canvas");
    cropCanvas.width = cropW;
    cropCanvas.height = cropH;
    cropCanvas.getContext("2d").putImageData(ctx.getImageData(cropX, cropY, cropW, cropH), 0, 0);
    return cropCanvas.toDataURL("image/png");
  };

  const submitSignature = async () => {
    setActionError(null);
    setPhase("submitting");
    try {
      const dataUrl = croppedSignatureDataUrl();
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
      a.download = "podepsane_dokumenty.zip";
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
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-slate-500 text-center">
            <Loader2 size={18} className="animate-spin" />
            <span>{wakingUp ? "Server se probouzí, může to chvíli trvat…" : "Načítám…"}</span>
            {wakingUp && <span className="text-[11.5px] text-slate-400">Klidně počkejte, zkoušíme to znovu automaticky.</span>}
          </div>
        )}

        {phase === "invalid" && (
          <div className="flex items-start gap-2 rounded-xl bg-red-50 p-4 text-[13px] text-red-700">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            Tento odkaz již není platný.
          </div>
        )}

        {phase === "error" && (
          <div className="rounded-xl bg-red-50 p-4 text-[13px] text-red-700">
            <div className="flex items-start gap-2">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              Nepodařilo se spojit se serverem. Server může být dočasně neaktivní — zkuste to prosím znovu.
            </div>
            <button
              type="button"
              onClick={() => setStatusRetryCount((n) => n + 1)}
              className="mt-3 inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-[12.5px] font-medium text-red-700 hover:bg-red-50"
            >
              <RotateCcw size={13} /> Zkusit znovu
            </button>
          </div>
        )}

        {phase === "reading" && (
          <>
            {info?.employee_name && (
              <p className="mb-3 text-[13px] text-slate-500">
                Dobrý den, <strong className="text-[#0B1220]">{info.employee_name}</strong> — přečtěte si prosím dokument níže a poté jej podepište.
              </p>
            )}

            {pdfError ? (
              <div className="rounded-xl bg-red-50 p-4 text-[13px] text-red-700">
                <div className="flex items-start gap-2">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                  Náhled dokumentu se nepodařilo načíst.
                </div>
                <button
                  type="button"
                  onClick={() => setPdfRetryCount((n) => n + 1)}
                  className="mt-3 inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-[12.5px] font-medium text-red-700 hover:bg-red-50"
                >
                  <RotateCcw size={13} /> Zkusit znovu
                </button>
              </div>
            ) : !pdfUrl ? (
              <div className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-slate-50 py-10 text-[13px] text-slate-500">
                <Loader2 size={16} className="animate-spin" /> Načítám dokument…
              </div>
            ) : (
              <>
                {/* The one thing that actually has to work everywhere — a
                    same-origin blob URL opened as a normal top-level
                    navigation, which every mobile browser (and in-app
                    browser) knows how to hand off to its own PDF viewer. */}
                <a
                  href={pdfUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 px-4 py-3 text-[13.5px] font-medium text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-colors"
                >
                  <FileText size={15} /> Otevřít smlouvu k přečtení
                </a>
                {/* Inline preview — a bonus on wider screens where an
                    embedded PDF reliably renders; deliberately not shown
                    on narrow/mobile viewports, where it's the part most
                    likely to render blank, instead of being mistaken for
                    the whole page failing. The link above is what's
                    actually required to proceed either way. */}
                <div
                  className="mt-3 hidden md:block rounded-xl border border-slate-200 overflow-hidden bg-slate-50"
                  style={{ height: "50vh", minHeight: 320 }}
                >
                  <iframe title="Náhled dokumentu k podpisu" src={pdfUrl} className="w-full h-full" />
                </div>
              </>
            )}

            <button
              type="button"
              onClick={() => setPhase("signing")}
              disabled={!pdfUrl}
              style={PRIMARY_GRADIENT}
              className="mt-5 w-full inline-flex items-center justify-center gap-1.5 rounded-xl px-5 py-3 text-[14px] font-medium text-white transition-[filter] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
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
            <p className="mt-1 text-[13px] text-slate-500">Stáhněte si svou podepsanou kopii dokumentů.</p>

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
              <Download size={15} /> Stáhnout podepsané dokumenty
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
            <p className="mt-1 text-[13px] text-slate-500">Dokumenty byly úspěšně staženy. Tento odkaz je nyní neaktivní.</p>
          </div>
        )}
      </div>
    </div>
  );
}
