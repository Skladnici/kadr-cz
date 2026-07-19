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

// Wraps an apiFetch(...)-style call with a hard timeout via
// AbortController. A bare fetch() (what apiFetch wraps) can hang
// indefinitely with nothing to blame it on — see uploadFileViaXHR's own
// docstring above for one well-observed cause (browser extensions that
// monkey-patch window.fetch globally) — and /api/fill in particular
// also does real server-side work (LibreOffice PDF conversion) that can
// occasionally run long on a free-tier instance. Without this, one
// stuck request inside batch mode's sequential "Vygenerovat všechny"
// loop froze the whole run behind an endless spinner with no
// explanation, since nothing ever rejected to let the loop move on.
export async function apiFetchWithTimeout(apiFetch, path, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await apiFetch(path, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === "AbortError") throw new Error("timeout");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Download tokens are single-use — the file is deleted server-side right
// after being served (see backend/app/main.py's /api/download), so a
// second click on the same link (browser back+retry, opening twice,
// re-clicking a stale card) now 404s. A plain <a href> can't distinguish
// that from a normal download, so this fetches the file itself and
// reports an honest message instead of a raw browser download-failed
// error. Shared by SimpleDocFiller (single mode) and BatchDocFiller (one
// call per generated card) so both stay identical instead of drifting
// into two slightly different copies over time.
export async function downloadGeneratedFile(apiFetch, token, { filename, openInNewTab } = {}, onError) {
  try {
    const res = await apiFetchWithTimeout(apiFetch, `/api/download/${token}`, {}, 30000);
    if (!res.ok) {
      if (res.status !== 401) {
        onError?.(
          res.status === 404
            ? "Tento odkaz ke stažení už byl použit (soubor se maže hned po prvním stažení). Vygenerujte dokument znovu."
            : describeRequestError(res.status, "Stažení se nezdařilo.")
        );
      }
      return;
    }
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    if (openInNewTab) {
      window.open(blobUrl, "_blank", "noopener,noreferrer");
    } else {
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename || token;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
  } catch (e) {
    onError?.(
      e.message === "timeout"
        ? "Stahování trvalo příliš dlouho — zkuste to prosím znovu."
        : "Stažení se nezdařilo — zkontrolujte připojení a zkuste to znovu."
    );
  }
}
