import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import SimpleDocFiller from "./SimpleDocFiller.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import "./index.css";

// sessionStorage flag guarding the one-shot auto-reload below — survives
// across the reload itself (that's the whole point) but not across a
// fresh tab/session, so a genuinely broken deployment still ends in the
// normal "Něco se pokazilo" screen rather than reloading forever.
const CHUNK_RELOAD_FLAG = "kadr_chunk_reload_attempted";

// A dynamic import() chunk fetch (what React.lazy does under the hood)
// has NO built-in retry — unlike every other network call on this exact
// page (see SignPage.jsx's own backoff loops for its status check and
// PDF fetches), which were hardened specifically because Render cold
// starts and flaky real employee mobile connections are an already-
// documented recurring problem here. Splitting SignPage into its own
// chunk (see the comment below) introduced exactly one more bare,
// un-retried network fetch into that same fragile path — a transient
// blip on the way to fetching it, or a stale chunk hash still cached
// from just before a fresh deploy, both surface as an unrecoverable-
// looking "Failed to fetch dynamically imported module" (Chrome) /
// "error loading dynamically imported module" (Firefox) / "Importing a
// module script failed" (Safari) — three different wordings for the
// same condition. A single full reload fixes both causes (a fresh
// index.html has the current chunk hashes, and a fresh request is a new
// chance for a transient blip to not repeat) — this automates the exact
// recovery step a hard refresh already does by hand, once, instead of
// leaving a real employee stuck on the generic error screen.
function lazyWithReload(importFn) {
  return lazy(() =>
    importFn()
      .then((mod) => {
        sessionStorage.removeItem(CHUNK_RELOAD_FLAG);
        return mod;
      })
      .catch((err) => {
        if (sessionStorage.getItem(CHUNK_RELOAD_FLAG)) throw err; // already tried once this session — a real problem, not a blip
        sessionStorage.setItem(CHUNK_RELOAD_FLAG, "1");
        window.location.reload();
        return new Promise(() => {}); // page is reloading — never resolve/reject further
      })
  );
}

// Lazy — SignPage pulls in pdfjs-dist (see PdfReader.jsx) for its
// read-before-signing preview, several hundred KB an admin filling out
// forms in SimpleDocFiller never needs to download at all. Splitting it
// into its own chunk means that cost only lands on someone who actually
// opens a /podepsat/{token} link.
const SignPage = lazyWithReload(() => import("./components/SignPage.jsx"));

// No router dependency for just one extra route — /podepsat/{token} is
// public (no login), so it can't reuse SimpleDocFiller's own app shell
// anyway. vercel.json rewrites every path to index.html so a direct
// visit/reload at this URL still reaches this same check instead of a
// static-hosting 404.
const signMatch = window.location.pathname.match(/^\/podepsat\/([^/]+)\/?$/);

// ErrorBoundary matters most here for /podepsat — an employee hitting a
// crash there has no console and no login/relogin escape hatch the way
// the admin app does, so an uncaught error must never just unmount to a
// blank white screen (React 18's default with no boundary in place).
ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      {signMatch ? (
        <Suspense fallback={null}>
          <SignPage token={signMatch[1]} />
        </Suspense>
      ) : (
        <SimpleDocFiller />
      )}
    </ErrorBoundary>
  </React.StrictMode>
);
