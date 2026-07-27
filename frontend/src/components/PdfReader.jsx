import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import { AlertTriangle, Loader2, Minus, Plus, Maximize2, X } from "lucide-react";

// Vite-native worker resolution — bundles the real worker file rather
// than fetching it from a CDN at runtime, so this still works offline/
// behind a restrictive network the same way the rest of the app does.
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).href;

// Zoom range for the +/- controls (inline reader and fullscreen modal
// alike). Pages are rendered once, up front, at enough native resolution
// to stay crisp all the way to ZOOM_MAX — zooming afterward is a plain
// CSS width change on the existing canvases, not a re-render, so it's
// instant regardless of how long the document is.
const ZOOM_MIN = 1;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.25;
// Hard cap on a single canvas's rendered pixel width, independent of
// devicePixelRatio * ZOOM_MAX — a retina phone (dpr 3) at max zoom would
// otherwise ask for a canvas several thousand pixels wide per page, which
// is real memory pressure on exactly the kind of device most likely to
// open a /podepsat link. 2400px is already sharper than the inline reader
// ever displays a page at (max ~900 CSS px wide × 2.5 zoom = 2250).
const MAX_RENDER_WIDTH_PX = 2400;
// The fullscreen modal starts from a much wider base (most of the
// viewport) and has its own zoom range on top of that, so it needs more
// native-resolution headroom than the inline reader.
const MODAL_MAX_RENDER_WIDTH_PX = 3200;

// Renders every page of an already-loaded pdf.js document into `container`
// at `targetWidth` CSS px, with enough native resolution to stay crisp up
// to `maxZoom` afterward (see the resize effects below). Shared by the
// inline reader and the fullscreen modal below, which reuse the SAME
// loaded `doc` (see pdfDocRef) rather than re-fetching/re-parsing the
// underlying PDF bytes a second time just to show it bigger.
// `isCancelled` is checked between (and effectively aborts) pages so a
// fast doc-switch or modal close doesn't keep rendering into a container
// nobody's looking at anymore; `onRenderTask` lets the caller track the
// in-flight render so its own cleanup can cancel it (see PdfReader's own
// history — destroying a document out from under an active render task
// is what caused a real "destroy is not a function" production crash).
async function renderAllPages(doc, container, targetWidth, maxZoom, maxRenderWidthPx, isCancelled, onRenderTask) {
  container.innerHTML = "";
  for (let i = 1; i <= doc.numPages; i++) {
    if (isCancelled()) return;
    const page = await doc.getPage(i);
    if (isCancelled()) return;

    const unscaled = page.getViewport({ scale: 1 });
    const idealWidth = targetWidth * maxZoom * (window.devicePixelRatio || 1);
    const renderWidth = Math.min(idealWidth, maxRenderWidthPx);
    const scale = renderWidth / unscaled.width;
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.className = "pdf-reader-page";
    canvas.style.width = `${targetWidth}px`; // zoom=1 display size
    canvas.style.height = "auto";
    container.appendChild(canvas);

    const renderTask = page.render({ canvasContext: canvas.getContext("2d"), viewport });
    onRenderTask(renderTask);
    await renderTask.promise;
    onRenderTask(null);
  }
}

// Pure CSS resize on zoom change — the canvases already carry enough
// native resolution (see renderAllPages above), so this never re-renders
// pdf.js output, just how large the existing bitmap is displayed.
function resizePages(container, baseWidth, zoom) {
  if (!container || !baseWidth) return;
  container.querySelectorAll(".pdf-reader-page").forEach((canvas) => {
    canvas.style.width = `${baseWidth * zoom}px`;
  });
}

// Renders a PDF as a stack of plain <canvas> pages instead of handing it
// to the browser as a navigable PDF resource — see SignPage.jsx's own
// comment on the bug this replaces: an <iframe src>/<a href> pointing at
// a PDF blob lets Chrome/Edge's built-in PDF viewer take over, and that
// viewer comes with ITS OWN download/print/draw toolbar layered on top of
// the file, bypassing "read-only until signed" no matter what this app's
// UI does. A canvas the browser never recognizes as a PDF in the first
// place has no such toolbar to bypass. The fullscreen modal below is the
// same guarantee at a larger size — never a real new tab/window (that
// would just reopen the original hole), only a bigger in-app canvas view.
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
  const [zoom, setZoom] = useState(1);
  const generationRef = useRef(0);
  // CSS px width of a page at zoom=1 (the fit-to-width size) — same value
  // for every page in practice (one document, not a mixed stack), so one
  // shared ref is enough to rescale every canvas on a zoom change without
  // re-measuring the container each time.
  const baseWidthRef = useRef(0);
  // The loaded pdf.js document, kept around after the effect that loaded
  // it finishes — the fullscreen modal reuses this SAME object (see its
  // own effect below) instead of fetching/parsing the PDF bytes again.
  const pdfDocRef = useRef(null);

  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [modalRendering, setModalRendering] = useState(true);
  const [modalError, setModalError] = useState(false);
  const [modalZoom, setModalZoom] = useState(1);
  const modalContainerRef = useRef(null);
  const modalBaseWidthRef = useRef(0);
  const modalGenerationRef = useRef(0);

  useEffect(() => {
    if (!data) return undefined;
    const generation = ++generationRef.current;
    const stillCurrent = () => generationRef.current === generation;
    let destroyed = false;
    let pdfDoc = null;
    let currentRenderTask = null;

    setError(false);
    setRendering(true);
    setZoom(1);
    pdfDocRef.current = null;
    const container = containerRef.current;
    if (container) container.innerHTML = "";

    // pdf.js can take ownership of (detach) the buffer it's handed —
    // slice() gives it a fresh copy each run instead of risking a
    // "buffer already detached" error on a quick retry/doc-switch.
    const bytes = data.slice(0);

    pdfjsLib.getDocument({ data: bytes }).promise
      .then(async (doc) => {
        if (destroyed || !stillCurrent() || !container) return;
        pdfDoc = doc;
        pdfDocRef.current = doc;
        // Fit-to-width against the actual container size, capped so a
        // huge monitor doesn't request an unnecessarily large canvas.
        const targetWidth = Math.min(container.clientWidth || 700, 900);
        baseWidthRef.current = targetWidth;
        await renderAllPages(
          doc, container, targetWidth, ZOOM_MAX, MAX_RENDER_WIDTH_PX,
          () => destroyed || !stillCurrent(),
          (task) => { currentRenderTask = task; },
        );
        if (!destroyed && stillCurrent()) setRendering(false);
      })
      .catch(() => {
        // Also fires for a render this same effect's own cleanup just
        // cancelled (see below) — stillCurrent() is false by then, so
        // that case is already excluded here; only a genuine failure
        // (corrupt PDF, truncated fetch, ...) for the CURRENT generation
        // ever reaches setError.
        if (!destroyed && stillCurrent()) {
          setError(true);
          setRendering(false);
        }
      });

    return () => {
      destroyed = true;
      pdfDocRef.current = null;
      // Cancel any render still in flight BEFORE destroying the
      // document — destroying it out from under an active page.render()
      // call is what produced a real "f.destroy is not a function"
      // crash in production (switching documents mid-render raced
      // pdf.js's own internal teardown, which doesn't expect the doc to
      // disappear while a render task is still using it). Both calls are
      // guarded and swallowed regardless: this is teardown for a
      // component that's already on its way out, so a hiccup here must
      // never surface as a page-crashing uncaught error the way it did
      // before.
      try {
        currentRenderTask?.cancel();
      } catch {
        // best-effort
      }
      try {
        if (pdfDoc && typeof pdfDoc.destroy === "function") pdfDoc.destroy();
      } catch {
        // best-effort — see comment above
      }
    };
  }, [data]);

  useEffect(() => {
    resizePages(containerRef.current, baseWidthRef.current, zoom);
  }, [zoom, rendering]);

  // A new document showing up (tab switch) always closes the modal —
  // in practice the modal's own full-viewport overlay already blocks
  // reaching the tab buttons underneath while it's open, but this stays
  // correct even if that ever changes.
  useEffect(() => {
    setFullscreenOpen(false);
  }, [data]);

  // Fullscreen modal — re-renders the SAME already-loaded document
  // (pdfDocRef.current) at a larger target width rather than re-fetching
  // or re-parsing the underlying PDF bytes. Only runs while open.
  useEffect(() => {
    if (!fullscreenOpen) return undefined;
    const doc = pdfDocRef.current;
    const container = modalContainerRef.current;
    if (!doc || !container) return undefined;

    const generation = ++modalGenerationRef.current;
    const stillCurrent = () => modalGenerationRef.current === generation;
    let cancelled = false;
    let currentRenderTask = null;

    setModalError(false);
    setModalRendering(true);
    setModalZoom(1);

    const targetWidth = Math.min(window.innerWidth * 0.92, 1400);
    modalBaseWidthRef.current = targetWidth;

    renderAllPages(
      doc, container, targetWidth, ZOOM_MAX, MODAL_MAX_RENDER_WIDTH_PX,
      () => cancelled || !stillCurrent(),
      (task) => { currentRenderTask = task; },
    )
      .then(() => {
        if (!cancelled && stillCurrent()) setModalRendering(false);
      })
      .catch(() => {
        if (!cancelled && stillCurrent()) {
          setModalError(true);
          setModalRendering(false);
        }
      });

    return () => {
      cancelled = true;
      // Only cancels THIS render — never destroys pdfDoc itself, which
      // the inline reader's own effect above still owns the lifetime of.
      try {
        currentRenderTask?.cancel();
      } catch {
        // best-effort
      }
    };
  }, [fullscreenOpen]);

  useEffect(() => {
    resizePages(modalContainerRef.current, modalBaseWidthRef.current, modalZoom);
  }, [modalZoom, modalRendering]);

  // Esc closes the modal, same as the visible × button.
  useEffect(() => {
    if (!fullscreenOpen) return undefined;
    const onKeyDown = (e) => { if (e.key === "Escape") setFullscreenOpen(false); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullscreenOpen]);

  // Locks background scroll while the modal covers the screen — without
  // this, a touch-scroll on a phone can scroll the page underneath the
  // overlay instead of the document inside it.
  useEffect(() => {
    if (!fullscreenOpen) return undefined;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prevOverflow; };
  }, [fullscreenOpen]);

  const roundZoom = (z) => Math.round(z * 100) / 100;
  const zoomIn = () => setZoom((z) => Math.min(ZOOM_MAX, roundZoom(z + ZOOM_STEP)));
  const zoomOut = () => setZoom((z) => Math.max(ZOOM_MIN, roundZoom(z - ZOOM_STEP)));
  const modalZoomIn = () => setModalZoom((z) => Math.min(ZOOM_MAX, roundZoom(z + ZOOM_STEP)));
  const modalZoomOut = () => setModalZoom((z) => Math.max(ZOOM_MIN, roundZoom(z - ZOOM_STEP)));

  if (error) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-red-50 py-10 text-[13px] text-red-700">
        <AlertTriangle size={16} className="shrink-0" /> Náhled dokumentu se nepodařilo zobrazit.
      </div>
    );
  }

  return (
    <>
      <div className={`pdf-reader relative flex flex-col rounded-xl border border-slate-200 bg-slate-100 ${className}`} style={style}>
        {/* Own header row rather than an overlay on top of the pages — no
            z-index/pointer-event fuss over content underneath, and it
            never covers a line of text the person is trying to read.
            Hidden until rendering finishes since there's nothing yet to
            zoom or expand. */}
        {!rendering && (
          <div className="flex shrink-0 items-center justify-end gap-0.5 rounded-t-xl border-b border-slate-200 bg-white/95 px-1.5 py-1">
            <button
              type="button"
              onClick={zoomOut}
              disabled={zoom <= ZOOM_MIN}
              title="Zmenšit"
              className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Minus size={14} />
            </button>
            <span className="w-10 text-center text-[11px] font-medium tabular-nums text-slate-500">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={zoomIn}
              disabled={zoom >= ZOOM_MAX}
              title="Přiblížit"
              className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Plus size={14} />
            </button>
            <span className="mx-0.5 h-4 w-px bg-slate-200" aria-hidden="true" />
            <button
              type="button"
              onClick={() => setFullscreenOpen(true)}
              title="Zobrazit na celou obrazovku"
              className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100"
            >
              <Maximize2 size={14} />
            </button>
          </div>
        )}
        <div
          className="relative min-h-0 flex-1 overflow-auto"
          // Right-click on a native <img>/<embed> PDF is exactly how a
          // person reaches "Save image/file as" without ever touching this
          // app's own UI — blocking it here is a small extra layer on top
          // of the real fix (canvas isn't a PDF resource at all), not a
          // substitute for it.
          onContextMenu={(e) => e.preventDefault()}
        >
          {rendering && (
            <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-slate-500">
              <Loader2 size={16} className="animate-spin" /> Načítám náhled…
            </div>
          )}
          <div ref={containerRef} className="flex flex-col items-center gap-2 p-2" />
        </div>
      </div>

      {/* Fullscreen modal — same canvas-only rendering as above, just
          bigger. Deliberately never a real new tab/window: that would
          hand the file to the browser as a navigable resource again,
          reopening the exact toolbar bug this whole component exists to
          close (see this file's own top comment). */}
      {fullscreenOpen && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-[#0B1220]/95"
          role="dialog"
          aria-modal="true"
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 bg-[#0B1220] px-3 py-2">
            {!modalRendering && !modalError ? (
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={modalZoomOut}
                  disabled={modalZoom <= ZOOM_MIN}
                  title="Zmenšit"
                  className="rounded-md p-1.5 text-slate-300 hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <Minus size={16} />
                </button>
                <span className="w-10 text-center text-[11px] font-medium tabular-nums text-slate-300">
                  {Math.round(modalZoom * 100)}%
                </span>
                <button
                  type="button"
                  onClick={modalZoomIn}
                  disabled={modalZoom >= ZOOM_MAX}
                  title="Přiblížit"
                  className="rounded-md p-1.5 text-slate-300 hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <Plus size={16} />
                </button>
              </div>
            ) : <span />}
            <button
              type="button"
              onClick={() => setFullscreenOpen(false)}
              title="Zavřít"
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium text-slate-200 hover:bg-white/10"
            >
              <X size={16} /> Zavřít
            </button>
          </div>
          <div className="relative min-h-0 flex-1 overflow-auto" onContextMenu={(e) => e.preventDefault()}>
            {modalError ? (
              <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-red-300">
                <AlertTriangle size={16} /> Náhled se nepodařilo zobrazit.
              </div>
            ) : (
              <>
                {modalRendering && (
                  <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-slate-300">
                    <Loader2 size={16} className="animate-spin" /> Načítám…
                  </div>
                )}
                <div ref={modalContainerRef} className="flex flex-col items-center gap-3 p-4" />
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
