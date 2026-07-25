import React from "react";
import ReactDOM from "react-dom/client";
import SimpleDocFiller from "./SimpleDocFiller.jsx";
import SignPage from "./components/SignPage.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import "./index.css";

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
      {signMatch ? <SignPage token={signMatch[1]} /> : <SimpleDocFiller />}
    </ErrorBoundary>
  </React.StrictMode>
);
