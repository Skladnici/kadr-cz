import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import SimpleDocFiller from "./SimpleDocFiller.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import "./index.css";

// Lazy — SignPage pulls in pdfjs-dist (see PdfReader.jsx) for its
// read-before-signing preview, several hundred KB an admin filling out
// forms in SimpleDocFiller never needs to download at all. Splitting it
// into its own chunk means that cost only lands on someone who actually
// opens a /podepsat/{token} link.
const SignPage = lazy(() => import("./components/SignPage.jsx"));

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
