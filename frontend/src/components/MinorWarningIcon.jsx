import WarningIcon from "./WarningIcon";

// Thin wrapper around the generic WarningIcon (see that component for
// the interaction/styling reasoning) fixing the minor-specific aria
// label and message text — kept as its own component simply because
// every call site already imports it by this name.
export default function MinorWarningIcon() {
  return (
    <WarningIcon ariaLabel="Nezletilá osoba — zobrazit podrobnosti">
      Podle rozpoznaného data narození je této osobě méně než 18 let.
      Pracovní smlouvy s nezletilými mají zvláštní právní požadavky
      (souhlas zákonného zástupce, omezení druhu práce a pracovní doby).
      Ověřte prosím podmínky před vygenerováním dokumentu.
    </WarningIcon>
  );
}
