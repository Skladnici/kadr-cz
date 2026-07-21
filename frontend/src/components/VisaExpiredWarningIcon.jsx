import WarningIcon from "./WarningIcon";

// Same compact badge as MinorWarningIcon, next to visa_validity whenever
// utils/age.js's isPastDate says that date has already passed — advisory
// only, same as every other check here (never blocks generation).
export default function VisaExpiredWarningIcon() {
  return (
    <WarningIcon ariaLabel="Platnost víza vypršela — zobrazit podrobnosti">
      Platnost víza vypršela — zkontrolujte prosím aktuální stav pobytu
      této osoby před vygenerováním dokumentu.
    </WarningIcon>
  );
}
