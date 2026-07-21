import WarningIcon from "./WarningIcon";

// Same compact badge as MinorWarningIcon/VisaExpiredWarningIcon, shown
// when the visa's printed category code is the "SD" ("strpění")
// subtype — see utils/visaStatus.js's isStrpeniVisaCode. Advisory only,
// same as every other check here (never blocks generation).
export default function StrpeniWarningIcon() {
  return (
    <WarningIcon ariaLabel="Vízum se statusem strpění — zobrazit podrobnosti">
      Tato víza má status "strpění" (D/SD/91) — zvláštní kategorie pobytu,
      která se odlišuje od standardní krátkodobé/dlouhodobé víza. Ověřte
      prosím podmínky zaměstnání této osoby před vygenerováním dokumentu.
    </WarningIcon>
  );
}
