import { FileText, Check } from "lucide-react";
import { DOC_THUMBNAIL_SIZE_CLASS } from "../constants/ui";

// One thumbnail per uploaded file (same DOC_THUMBNAIL_SIZE_CLASS size as
// every other document-photo thumbnail in the app — this used to hard-
// code its own 56px regardless, a fourth spot missed when the others
// were enlarged to 72/88px), shown side by side, instead of a single
// large preview — used both while OCR is actively working through
// several files in sequence (activeIndex set, .ocr-scan-line animates on
// whichever one is current) and, in batch mode, as a plain static row
// once files have already been merged onto one person's card (activeIndex
// omitted — every thumbnail just shows its "done" checkmark). Single mode
// and batch mode share this exact component so both read as one system
// rather than two different-looking previews.
//
// `files`: [{ url, name, isPdf, isHeic }, ...] — same shape both modes
// already keep for their own preview state, so no adapting needed at the
// call site.
// `activeIndex`: index currently mid-scan (gets the moving scan line);
// indices before it are treated as already recognized (checkmark),
// indices after it as not yet started (dimmed, no badge). Omit entirely
// (undefined) for a static "all already done" row, e.g. an
// already-merged batch card.
export default function FileScanThumbnails({ files, activeIndex }) {
  if (!files || files.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {files.map((f, i) => {
        const isActive = activeIndex != null && i === activeIndex;
        const isDone = activeIndex == null || i < activeIndex;
        const isPending = activeIndex != null && i > activeIndex;
        return (
          <div
            key={i}
            title={f.name}
            className={`relative ${DOC_THUMBNAIL_SIZE_CLASS} shrink-0 overflow-hidden rounded-xl border bg-slate-50 transition-opacity ${
              isPending ? "border-slate-200 opacity-50" : "border-slate-200"
            }`}
          >
            {f.url ? (
              <img src={f.url} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center text-slate-300">
                <FileText size={18} />
              </div>
            )}
            {isActive && <div className="ocr-scan-line" aria-hidden="true" />}
            {isDone && (
              <span
                className="absolute bottom-0.5 right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#639922] text-white"
                aria-hidden="true"
              >
                <Check size={9} strokeWidth={3.5} />
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
