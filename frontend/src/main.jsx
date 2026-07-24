import React from "react";
import ReactDOM from "react-dom/client";
import SimpleDocFiller from "./SimpleDocFiller.jsx";
import SignPage from "./components/SignPage.jsx";
import "./index.css";

// No router dependency for just one extra route — /podepsat/{token} is
// public (no login), so it can't reuse SimpleDocFiller's own app shell
// anyway. vercel.json rewrites every path to index.html so a direct
// visit/reload at this URL still reaches this same check instead of a
// static-hosting 404.
const signMatch = window.location.pathname.match(/^\/podepsat\/([^/]+)\/?$/);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {signMatch ? <SignPage token={signMatch[1]} /> : <SimpleDocFiller />}
  </React.StrictMode>
);
