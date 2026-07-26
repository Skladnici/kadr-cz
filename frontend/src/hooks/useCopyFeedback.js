import { useCallback, useEffect, useRef, useState } from "react";

const FEEDBACK_MS = 1800;

// navigator.clipboard.writeText() needs a secure context (HTTPS or
// localhost) and can be missing entirely in an older embedded webview —
// document.execCommand('copy') via a throwaway textarea is the fallback
// for exactly that case.
async function copyWithFallback(text) {
  // TEMP DEBUG — remove once the "button text never changes" report is
  // confirmed fixed on a real deploy. Search "COPY-DEBUG" to find every
  // line to strip.
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      console.log("[COPY-DEBUG] navigator.clipboard.writeText succeeded");
      return true;
    } catch (err) {
      console.error("[COPY-DEBUG] navigator.clipboard.writeText threw, falling back to execCommand:", err);
    }
  } else {
    console.log("[COPY-DEBUG] navigator.clipboard.writeText not available (no HTTPS/localhost, or unsupported) — using execCommand fallback");
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    // iOS Safari's execCommand('copy') is picky about the source element
    // in ways desktop browsers aren't: a zero-size or display:none node
    // (opacity:0 alone isn't enough) can silently fail to select, and
    // plain .select() on an off-screen textarea doesn't reliably select
    // its full contents on iOS — setSelectionRange below is the
    // well-documented workaround. Sized/positioned off-screen (not
    // display:none/width:0) rather than fully hidden, and font-size 16px
    // to stop iOS auto-zooming the page when it briefly gains focus.
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "0";
    textarea.style.width = "2em";
    textarea.style.height = "2em";
    textarea.style.padding = "0";
    textarea.style.border = "none";
    textarea.style.outline = "none";
    textarea.style.boxShadow = "none";
    textarea.style.background = "transparent";
    textarea.style.fontSize = "16px";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    textarea.remove();
    console.log("[COPY-DEBUG] execCommand('copy') returned:", ok);
    return ok;
  } catch (err) {
    console.error("[COPY-DEBUG] execCommand('copy') threw:", err);
    return false;
  }
}

// Shared "Kopírovat odkaz" -> "Zkopírováno ✓" -> back button feedback,
// used by SimpleDocFiller and PersonCard's sign-link copy buttons. The
// timeout ref (not just a plain setTimeout) is what keeps rapid repeat
// clicks from racing each other — each click clears whatever reset was
// already pending before scheduling its own, so the button only ever
// reverts FEEDBACK_MS after the LAST click, never mid-way through from
// an earlier one.
export default function useCopyFeedback() {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef(null);

  useEffect(() => () => clearTimeout(timeoutRef.current), []);

  const copy = useCallback(async (text) => {
    const ok = await copyWithFallback(text);
    console.log("[COPY-DEBUG] copyWithFallback returned:", ok, "— will setCopied(true)?", ok);
    if (!ok) return;
    setCopied(true);
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), FEEDBACK_MS);
  }, []);

  return [copied, copy];
}
