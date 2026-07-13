// Fields shown for review/editing after recognition, and sent to /api/fill.
// Third item marks which templates this field is relevant for — "all"
// shows it everywhere, otherwise a list of template-id prefixes. This
// keeps the form from showing e.g. "Důvod ukončení" while filling out a
// DPP, or "Mzda" while filling out a termination notice.
export const FIELD_DEFS = [
  ["first_name", "Jméno", "all"],
  ["last_name", "Příjmení", "all"],
  ["birth_date", "Datum narození", "all"],
  // "nationality" is still used internally (to guess CZ/UA/EU for the
  // address auto-fill) but isn't shown as a form field or written into
  // any contract — the real DPP template you sent has no such line.
  ["doc_number", "Číslo dokladu", "all"],
  // "address" is handled separately below via <AddressBuilder> — not a plain text field.
  ["position", "Pozice", ["dpp", "dpc", "hpp", "ukonceni"]],
  ["workplace", "Místo výkonu práce", ["dpp", "dpc", "hpp"]],
  ["salary", "Mzda / odměna", ["dpp", "dpc", "hpp"]],
  ["hours_per_week", "Hodin týdně", ["dpp", "dpc", "hpp"]],
  ["start_date", "Datum nástupu", ["dpp", "dpc", "hpp"]],
  ["end_date", "Datum ukončení", ["dpp", "dpc", "hpp"]],
  ["bank_account", "Bankovní účet", "all"],
  ["company_name", "Firma (zaměstnavatel)", "all"],
  ["company_ico", "IČO", "all"],
  ["company_dic", "DIČ", "all"],
  ["company_address", "Adresa firmy", "all"],
  ["company_representative", "Zástupce firmy", "all"],
  ["visa_number", "Série a číslo víza (jen pro cizince)", "all"],
  ["visa_validity", "Platnost víza do (jen pro cizince)", "all"],
  ["residence_type", "Druh pobytu na území ČR (jen pro cizince)", "all"],
  ["signing_place", "Místo podpisu (výchozí: Praze)", "all"],
  ["termination_reason", "Důvod ukončení", ["ukonceni"]],
  ["last_working_day", "Poslední pracovní den", ["ukonceni"]],
  ["pay_period", "Zúčtovací období", ["vyplatni"]],
  ["gross_salary", "Hrubá mzda", ["vyplatni"]],
  ["health_insurance", "Zdravotní pojištění", ["vyplatni"]],
  ["social_insurance", "Sociální pojištění", ["vyplatni"]],
  ["income_tax", "Daň ze mzdy", ["vyplatni"]],
  ["net_salary", "Čistá mzda", ["vyplatni"]],
];

// Matches a field's allowed-template list against the currently chosen
// template id (e.g. "dpp_template" starts with "dpp") — "all" always
// passes, and if templateId isn't loaded yet everything shows so the
// form isn't empty during the brief initial load.
// Fields shown in the "person" group at the top of the review form —
// everything else (contract terms, company, payslip specifics) renders
// further down, after the address section.
export const PERSON_FIELD_KEYS = new Set([
  "first_name", "last_name", "birth_date", "doc_number",
  "visa_number", "visa_validity", "residence_type",
]);

export function isFieldRelevant(scope, templateId) {
  if (scope === "all" || !templateId) return true;
  return scope.some((prefix) => templateId.startsWith(prefix));
}

// Default statutory salary caps HR commonly uses when generating these
// contract types — pre-fills the "Mzda" field but stays fully editable,
// and only overwrites a previous *auto-filled* default (never a value
// the person typed themselves) when switching between templates.
export const DEFAULT_SALARY_BY_TEMPLATE = {
  dpp_template: "11 999",
  hpp_template: "22 400",
};
