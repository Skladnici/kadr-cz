export const API_BASE = typeof window !== "undefined" && window.__HR_API_BASE__
  ? window.__HR_API_BASE__
  : "http://localhost:8000";

// Turns a failed request's HTTP status into an honest Czech message,
// instead of always blaming "the backend isn't running". A 401 here
// normally never reaches the user — apiFetch() already reacts to it by
// clearing the stored login and showing LoginForm again — this text only
// covers the rare case where something else surfaces a 401 message
// before that re-render happens.
export function describeRequestError(status, fallbackAction) {
  if (status === 401) {
    return "Přihlášení vypršelo nebo je neplatné — zadejte prosím přihlašovací údaje znovu.";
  }
  if (status === 503) {
    return "Tato funkce není na serveru nastavená — kontaktujte správce webu.";
  }
  if (status === 404) {
    return "Požadovaná data nebyla nalezena.";
  }
  if (typeof status === "number" && status >= 500) {
    return "Na serveru došlo k chybě — zkuste to prosím za chvíli znovu.";
  }
  return `${fallbackAction} Zkontrolujte, zda backend běží na ${API_BASE}.`;
}

// Basic Auth credentials, built and attached by hand instead of relying
// on the browser's native login prompt — that prompt turned out not to
// fire reliably for cross-site fetch()/XHR requests to a different
// origin (frontend on Vercel, backend on Render), especially in
// Incognito/Private browsing, where browsers restrict HTTP-auth-cache
// behavior across sites as an anti-tracking measure. FastAPI's
// HTTPBasic() on the backend only inspects the Authorization header, so
// it doesn't care how it got there — this is a drop-in replacement from
// its point of view.
export function toBasicAuthHeader(username, password) {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return "Basic " + btoa(binary);
}

// Uploads a file via XMLHttpRequest instead of fetch(). Some browser
// extensions (crypto wallets in particular) monkey-patch window.fetch
// globally to inject their own behavior on every page — this can cause
// fetch() calls to silently hang forever on unrelated sites. XHR is a
// different, older browser API that such extensions typically don't
// touch, so it's a reliable way to sidestep that interference.
export function uploadFileViaXHR(url, file, authHeader, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.timeout = timeoutMs;
    xhr.setRequestHeader("Authorization", authHeader);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (e) {
          reject(new Error("invalid JSON response"));
        }
      } else {
        const err = new Error(`server error ${xhr.status}`);
        err.status = xhr.status;
        reject(err);
      }
    };
    xhr.onerror = () => reject(new Error("network error"));
    xhr.ontimeout = () => reject(new Error("timeout"));
    const formData = new FormData();
    formData.append("file", file);
    xhr.send(formData);
  });
}
