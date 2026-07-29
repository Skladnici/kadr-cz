// Shared sizing for the clickable document-photo thumbnails shown in
// both single mode (SimpleDocFiller's step 3 form) and batch mode
// (PersonCard's "Naskenované doklady" row) — kept as one constant so
// the two can't drift out of sync in size the way two separately
// hand-typed Tailwind classes eventually would. Smaller by default,
// full size from the md breakpoint up, so a batch card with several
// uploaded files still wraps cleanly instead of overflowing a narrow
// (mobile) card width.
export const DOC_THUMBNAIL_SIZE_CLASS = "w-[72px] h-[72px] md:w-[88px] md:h-[88px]";
