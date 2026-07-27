import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import { AlertTriangle, Loader2 } from "lucide-react";

// Vite-native worker resolution — bundles the real worker file rather
// than fetching it from a CDN at runtime, so this still works offline/
// behind a restrictive network the same way the rest of the app does.
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).href;

// Renders a PDF as a stack of plain <canvas> pages instead of handing it
// to the browser as a navigable PDF resource — see SignPage.jsx's own
// comment on the bug this replaces: an <iframe src>/<a href> pointing at
// a PDF blob lets Chrome/Edge's built-in PDF viewer take over, and that
// viewer comes with ITS OWN download/print/draw toolbar layered on top of
// the file, bypassing "read-only until signed" no matter what this app's
// UI does. A canvas the browser never recognizes as a PDF in the first
// place has no such toolbar to bypass.
//
// `data` must be the raw PDF bytes (ArrayBuffer/Uint8Array) — deliberately
// never a blob: URL, since a blob URL is still an openable resource
// (address bar, "open image in new tab", a devtools Network-tab replay)
// that could hand the original file to the native viewer just as easily
// as the bug being fixed here.
export default function PdfReader({ data, className = "", style }) {
  const containerRef = useRef(null);
  const [error, setError] = useState(false);
  const [rendering, setRendering] = useState(true);
  const generationRef = useRef(0);

  useEffect(() => {
    if (!data) return undefined;
    const generation = ++generationRef.current;
    const stillCurrent = () => generationRef.current === generation;
    let destroyed = false;
    let pdfDoc = null;

    setError(false);
    setRendering(true);
    const container = containerRef.current;
    if (container) container.innerHTML = "";

    // pdf.js can take ownership of (detach) the buffer it's handed —
    // slice() gives it a fresh copy each run instead of risking a
    // "buffer already detached" error on a quick retry/doc-switch.
    const bytes = data.slice(0);

    const renderPage = async (doc, pageNum) => {
      const page = await doc.getPage(pageNum);
      if (destroyed || !stillCurrent() || !container) return;
      // Fit-to-width against the actual container size, capped so a huge
      // monitor doesn't request an unnecessarily large canvas.
      const targetWidth = Math.min(container.clientWidth || 700, 900);
      const unscaled = page.getViewport({ scale: 1 });
      const scale = (targetWidth / unscaled.width) * (window.devicePixelRatio || 1);
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.className = "pdf-reader-page";
      canvas.style.width = "100%";
      canvas.style.height = "auto";
      container.appendChild(canvas);

      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    };

    pdfjsLib.getDocument({ data: bytes }).promise
      .then(async (doc) => {
        if (destroyed || !stillCurrent()) return;
        pdfDoc = doc;
        for (let i = 1; i <= doc.numPages; i++) {
          if (destroyed || !stillCurrent()) return;
          await renderPage(doc, i);
        }
        if (!destroyed && stillCurrent()) setRendering(false);
      })
      .catch(() => {
        if (!destroyed && stillCurrent()) {
          setError(true);
          setRendering(false);
        }
      });

    return () => {
      destroyed = true;
      if (pdfDoc) pdfDoc.destroy();
    };
  }, [data]);

  if (error) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-red-50 py-10 text-[13px] text-red-700">
        <AlertTriangle size={16} className="shrink-0" /> Náhled dokumentu se nepodařilo zobrazit.
      </div>
    );
  }

  return (
    <div
      className={`pdf-reader relative overflow-y-auto rounded-xl border border-slate-200 bg-slate-100 ${className}`}
      style={style}
      // Right-click on a native <img>/<embed> PDF is exactly how a person
      // reaches "Save image/file as" without ever touching this app's own
      // UI — blocking it here is a small extra layer on top of the real
      // fix (canvas isn't a PDF resource at all), not a substitute for it.
      onContextMenu={(e) => e.preventDefault()}
    >
      {rendering && (
        <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-slate-500">
          <Loader2 size={16} className="animate-spin" /> Načítám náhled…
        </div>
      )}
      <div ref={containerRef} className="flex flex-col items-center gap-2 p-2" />
    </div>
  );
}
