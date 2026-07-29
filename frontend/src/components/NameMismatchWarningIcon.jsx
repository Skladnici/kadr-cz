import WarningIcon from "./WarningIcon";

// Same compact badge as MinorWarningIcon/VisaExpiredWarningIcon/
// StrpeniWarningIcon, shown on the name fields whenever
// recognizeMerge.js's nameMismatchHint fires — a passport and its own
// visa sticker routinely OCR the same name slightly differently, which
// is expected noise, not a sign the files don't belong together. Used
// to be a permanently-visible, paragraph-length "Pozor: ..." warning
// (in both single and batch mode) that read as a serious error even on
// a perfectly correct merge; this instead surfaces the exact per-file
// variants only once the person actually clicks to check, same as
// every other advisory-only badge here.
export default function NameMismatchWarningIcon({ detail }) {
  return (
    <WarningIcon ariaLabel="Jméno se liší mezi doklady — zobrazit podrobnosti">
      Jméno bylo na nahraných dokladech rozpoznáno odlišně — to je běžné
      (např. mírně jiný přepis na vízu než v pasu). {detail}
    </WarningIcon>
  );
}
