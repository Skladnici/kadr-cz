import React, { useState, useCallback, useRef, useEffect } from "react";
import {
  Upload, FileText, Check, AlertTriangle, X, Download,
  Printer, Loader2, ArrowRight, ArrowLeft, ScanLine, RotateCcw, ShieldCheck, MapPin
} from "lucide-react";

// NOTE: browser-side compression was removed here — it caused uploads to
// hang indefinitely for certain files (observed with photos forwarded
// through messaging apps), even with a timeout safety net in place. The
// backend already compresses/resizes images reliably and quickly before
// OCR, so sending the original file directly is both simpler and safer.

// Uploads a file via XMLHttpRequest instead of fetch(). Some browser
// extensions (crypto wallets in particular) monkey-patch window.fetch
// globally to inject their own behavior on every page — this can cause
// fetch() calls to silently hang forever on unrelated sites. XHR is a
// different, older browser API that such extensions typically don't
// touch, so it's a reliable way to sidestep that interference.
function uploadFileViaXHR(url, file, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.timeout = timeoutMs;
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (e) {
          reject(new Error("invalid JSON response"));
        }
      } else {
        reject(new Error(`server error ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("network error"));
    xhr.ontimeout = () => reject(new Error("timeout"));
    const formData = new FormData();
    formData.append("file", file);
    xhr.send(formData);
  });
}

const API_BASE = typeof window !== "undefined" && window.__HR_API_BASE__
  ? window.__HR_API_BASE__
  : "http://localhost:8000";

// Fields shown for review/editing after recognition, and sent to /api/fill.
// Third item marks which templates this field is relevant for — "all"
// shows it everywhere, otherwise a list of template-id prefixes. This
// keeps the form from showing e.g. "Důvod ukončení" while filling out a
// DPP, or "Mzda" while filling out a termination notice.
const FIELD_DEFS = [
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
const PERSON_FIELD_KEYS = new Set([
  "first_name", "last_name", "birth_date", "doc_number",
  "visa_number", "visa_validity", "residence_type",
]);

function isFieldRelevant(scope, templateId) {
  if (scope === "all" || !templateId) return true;
  return scope.some((prefix) => templateId.startsWith(prefix));
}

// Common Czech cities with their postal code (PSČ) — covers the large
// majority of real addresses without needing any external lookup
// service. Smaller towns aren't in this list; the person just types the
// PSČ manually in that case, same as before.
// Practical, sizeable set of Czech towns/city districts with PSČ — not
// the full official ~15,000-entry postal registry (that would need a
// real downloaded dataset), but covers the large majority of real
// addresses HR staff will type. Anything not listed here is simply
// typed in manually, same as before.
const CZ_CITY_PSC = {
  "Praha": "100 00",
  "Praha 1": "110 00", "Praha 2": "120 00", "Praha 3": "130 00", "Praha 4": "140 00",
  "Praha 5": "150 00", "Praha 6": "160 00", "Praha 7": "170 00", "Praha 8": "180 00",
  "Praha 9": "190 00", "Praha 10": "100 00", "Praha 11": "149 00", "Praha 12": "143 00",
  "Praha 13": "155 00", "Praha 14": "198 00", "Praha 15": "109 00", "Praha 16": "165 00",
  "Praha 17": "163 00", "Praha 18": "199 00", "Praha 19": "197 00", "Praha 20": "193 00",
  "Praha 21": "190 16", "Praha 22": "104 00",
  "Brno": "602 00", "Ostrava": "702 00", "Plzeň": "301 00", "Liberec": "460 01",
  "Olomouc": "779 00", "České Budějovice": "370 01", "Hradec Králové": "500 02",
  "Ústí nad Labem": "400 01", "Pardubice": "530 02", "Zlín": "760 01",
  "Havířov": "736 01", "Kladno": "272 01", "Most": "434 01", "Opava": "746 01",
  "Frýdek-Místek": "738 01", "Karviná": "733 01", "Jihlava": "586 01",
  "Teplice": "415 01", "Děčín": "405 02", "Karlovy Vary": "360 01",
  "Chomutov": "430 01", "Jablonec nad Nisou": "466 01", "Mladá Boleslav": "293 01",
  "Prostějov": "796 01", "Přerov": "750 02", "Česká Lípa": "470 01",
  "Třebíč": "674 01", "Třinec": "739 61", "Tábor": "390 02", "Znojmo": "669 02",
  "Kolín": "280 02", "Příbram": "261 01", "Cheb": "350 02", "Trutnov": "541 01",
  "Vsetín": "755 01", "Kroměříž": "767 01", "Litoměřice": "412 01",
  "Písek": "397 01", "Uherské Hradiště": "686 01", "Šumperk": "787 01",
  "Nový Jičín": "741 01", "Chrudim": "537 01", "Klatovy": "339 01",
  "Vyškov": "682 01", "Jindřichův Hradec": "377 01", "Břeclav": "690 02",
  "Rakovník": "269 01", "Strakonice": "386 01", "Havlíčkův Brod": "580 01",
  "Hodonín": "695 01", "Bruntál": "792 01", "Vlašim": "258 01",
  "Sokolov": "356 01", "Kutná Hora": "284 01", "Beroun": "266 01",
  "Blansko": "678 01", "Louny": "440 01", "Náchod": "547 01",
  "Svitavy": "568 02", "Jičín": "506 01", "Domažlice": "344 01",
  "Rokycany": "337 01", "Litvínov": "436 01", "Krnov": "794 01",
  "Kopřivnice": "742 21", "Otrokovice": "765 02", "Valašské Meziříčí": "757 01",
  "Rychnov nad Kněžnou": "516 01", "Semily": "513 01", "Žďár nad Sázavou": "591 01",
  "Nymburk": "288 02", "Benešov": "256 01", "Kralupy nad Vltavou": "278 01",
  "Neratovice": "277 11", "Roudnice nad Labem": "413 01", "Varnsdorf": "407 47",
  "Frýdlant": "464 01", "Rumburk": "408 01", "Vrchlabí": "543 01",
  "Kadaň": "432 01", "Žatec": "438 01", "Aš": "352 01",
  "Kyjov": "697 01", "Uherský Brod": "688 01", "Hranice": "753 01",
  "Studénka": "742 13", "Orlová": "735 14", "Bohumín": "735 81",
  "Boskovice": "680 01", "Kuřim": "664 34", "Ivančice": "664 91",
  "Slavkov u Brna": "684 01", "Tišnov": "666 01", "Rosice": "665 01",
  "Adamov": "679 04", "Rájec-Jestřebí": "679 02", "Letovice": "679 61",
  "Moravský Krumlov": "672 01", "Miroslav": "671 72", "Pohořelice": "691 23",
  "Dačice": "380 01", "Telč": "588 56", "Kamenice nad Lipou": "394 70",
  "Pelhřimov": "393 01", "Humpolec": "396 01", "Chotěboř": "583 01",
  "Světlá nad Sázavou": "582 91", "Ledeč nad Sázavou": "584 01",
  "Chlumec nad Cidlinou": "503 51", "Nový Bydžov": "504 01",
  "Dvůr Králové nad Labem": "544 01", "Broumov": "550 01",
  "Police nad Metují": "549 54", "Hostinné": "543 71",
  "Turnov": "511 01", "Český Dub": "463 43", "Železný Brod": "468 22",
  "Nová Paka": "509 01", "Hořice": "508 01", "Lomnice nad Popelkou": "512 51",
  "Sedlčany": "264 01", "Dobříš": "263 01", "Hořovice": "268 01",
  "Zdice": "267 51", "Mníšek pod Brdy": "252 10", "Jílové u Prahy": "254 01",
  "Říčany": "251 01", "Brandýs nad Labem-Stará Boleslav": "250 01",
  "Čelákovice": "250 88", "Lysá nad Labem": "289 22", "Poděbrady": "290 01",
  "Sadská": "289 12", "Milovice": "289 23", "Bakov nad Jizerou": "294 01",
  "Bělá pod Bezdězem": "294 21", "Dobrovice": "294 41", "Mšeno": "277 35",
  "Mělník": "276 01", "Kladruby": "349 61", "Stříbro": "349 01",
  "Přeštice": "334 01", "Nepomuk": "335 01", "Blovice": "336 01",
  "Nýřany": "330 23", "Stod": "333 01", "Horšovský Týn": "346 01",
  "Sušice": "342 01", "Horažďovice": "341 01", "Kašperské Hory": "341 92",
  "Vimperk": "385 01", "Prachatice": "383 01", "Netolice": "384 11",
  "Vodňany": "389 01", "Trhové Sviny": "374 01", "Kaplice": "382 41",
  "Český Krumlov": "381 01", "Lipno nad Vltavou": "382 78",
  "Třeboň": "379 01", "Suchdol nad Lužnicí": "378 06", "Nová Bystřice": "378 33",
  "Milevsko": "399 01", "Bechyně": "391 65", "Sezimovo Ústí": "391 02",
  "Soběslav": "392 01", "Veselí nad Lužnicí": "391 81",
  "Bystřice nad Pernštejnem": "593 01", "Nové Město na Moravě": "592 31",
  "Velké Meziříčí": "594 01", "Náměšť nad Oslavou": "675 71",
  "Moravské Budějovice": "676 02", "Jemnice": "675 31",
  "Slavonice": "378 81", "Jaroměřice nad Rokytnou": "675 51",
  "Bzenec": "696 81", "Veselí nad Moravou": "698 01",
  "Strážnice": "696 62", "Uherský Ostroh": "687 24",
  "Bojkovice": "687 71", "Luhačovice": "763 26", "Slavičín": "763 21",
  "Valašské Klobouky": "766 01", "Rožnov pod Radhoštěm": "756 61",
  "Frenštát pod Radhoštěm": "744 01", "Bílovec": "743 01",
  "Fulnek": "742 45", "Odry": "742 35", "Vítkov": "749 01",
  "Hlučín": "748 01", "Kravaře": "747 21", "Hať": "747 16",
};

// Ukrainian oblast capitals and major cities with the central poshtovyi
// indeks (postal code) for that city. Same practical, non-exhaustive
// approach as the Czech list above.
const UA_CITY_PSC = {
  "Київ / Kyjev": "01001", "Харків / Charkiv": "61001", "Одеса / Oděsa": "65001",
  "Дніпро / Dnipro": "49000", "Донецьк / Doněck": "83001", "Запоріжжя / Zaporižžja": "69001",
  "Львів / Lvov": "79000", "Кривий Ріг / Kryvyj Rih": "50000", "Миколаїв / Mykolajiv": "54000",
  "Маріуполь / Mariupol": "87500", "Луганськ / Luhansk": "91000", "Вінниця / Vinnycja": "21000",
  "Макіївка / Makijivka": "86100", "Севастополь / Sevastopol": "99000",
  "Сімферополь / Simferopol": "95000", "Херсон / Cherson": "73000",
  "Полтава / Poltava": "36000", "Чернігів / Černihiv": "14000",
  "Черкаси / Čerkasy": "18000", "Хмельницький / Chmelnyckyj": "29000",
  "Чернівці / Černivci": "58000", "Житомир / Žytomyr": "10000",
  "Суми / Sumy": "40000", "Рівне / Rivne": "33000",
  "Івано-Франківськ / Ivano-Frankivsk": "76000", "Тернопіль / Ternopil": "46000",
  "Луцьк / Luck": "43000", "Ужгород / Užhorod": "88000",
  "Кропивницький / Kropyvnyckyj": "25000", "Кременчук / Kremenčuk": "39600",
  "Біла Церква / Bila Cerkva": "09100", "Мелітополь / Melitopol": "72300",
  "Краматорськ / Kramatorsk": "84300", "Бердянськ / Berdjansk": "71100",
  "Слов'янськ / Slovjansk": "84100", "Умань / Uman": "20300",
  "Кам'янське / Kamjanske": "51900", "Алчевськ / Alčevsk": "94200",
  "Павлоград / Pavlohrad": "51400", "Сєвєродонецьк / Sjevjerodoneck": "93400",
  "Дрогобич / Drohobyč": "82100", "Бориспіль / Boryspil": "08300",
  "Нікополь / Nikopol": "53200", "Конотоп / Konotop": "41600",
  "Бердичів / Berdyčiv": "13300", "Шостка / Šostka": "41100",
  "Новомосковськ / Novomoskovsk": "51200", "Ізмаїл / Izmajil": "68600",
  "Коломия / Kolomyja": "78200", "Коростень / Korosten": "11500",
  "Бровари / Brovary": "07400", "Мукачево / Mukačevo": "89600",
  "Ковель / Kovel": "45000", "Нововолинськ / Novovolynsk": "45400",
  "Стрий / Stryj": "82400", "Червоноград / Červonohrad": "80100",
  "Калуш / Kaluš": "77300", "Долина / Dolyna": "77500",
  "Здолбунів / Zdolbuniv": "35700", "Дубно / Dubno": "35600",
  "Сарни / Sarny": "34500", "Новоград-Волинський / Novohrad-Volynskyj": "11700",
  "Обухів / Obuchiv": "08700", "Ірпінь / Irpin": "08200",
  "Буча / Buča": "08292", "Фастів / Fastiv": "08500",
  "Вишгород / Vyšhorod": "07300", "Переяслав / Perejaslav": "08400",
};

// Custom autocomplete dropdown for city fields — replaces the native
// <datalist>, which some browsers render as a huge, unstyled system
// popup. Shows up to 6 matches with the typed portion highlighted,
// supports arrow-key navigation + Enter, and calls onSelect(name, psc)
// so the caller can auto-fill PSČ/indeks in the same step.
function CityAutocomplete({ value, onChange, onSelect, cityTable, placeholder }) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const wrapRef = useRef(null);

  const query = (value || "").trim().toLowerCase();
  const matches = query
    ? Object.keys(cityTable).filter((c) => c.toLowerCase().includes(query)).slice(0, 6)
    : [];

  const highlight = (name) => {
    const idx = name.toLowerCase().indexOf(query);
    if (idx === -1) return name;
    return (
      <>
        {name.slice(0, idx)}
        <b className="font-semibold text-[#0B1220]">{name.slice(idx, idx + query.length)}</b>
        {name.slice(idx + query.length)}
      </>
    );
  };

  const select = (name) => {
    onSelect(name, cityTable[name]);
    setOpen(false);
    setActiveIndex(-1);
  };

  return (
    <div className="relative" ref={wrapRef}>
      <input
        value={value || ""}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setActiveIndex(-1); }}
        onFocus={() => value && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (!open || matches.length === 0) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setActiveIndex((i) => Math.min(i + 1, matches.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)); }
          else if (e.key === "Enter" && activeIndex >= 0) { e.preventDefault(); select(matches[activeIndex]); }
        }}
        placeholder={placeholder}
        autoComplete="off"
        className="mt-1 w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
      />
      {open && matches.length > 0 && (
        <div className="absolute z-20 top-full left-0 right-0 mt-1 rounded-lg border border-slate-200 bg-white shadow-lg max-h-52 overflow-y-auto p-1">
          {matches.map((name, i) => (
            <div
              key={name}
              onMouseDown={(e) => { e.preventDefault(); select(name); }}
              onMouseEnter={() => setActiveIndex(i)}
              className={`flex items-center gap-2 px-2.5 py-2 rounded-md text-[13px] text-slate-700 cursor-pointer ${i === activeIndex ? "bg-slate-100" : ""}`}
            >
              <MapPin size={13} className="text-slate-400 shrink-0" />
              <span>{highlight(name)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AddressBuilder({ czParts, setCzPart, originCountry, setOriginCountry, originParts, setOriginPart }) {
  const cityMatch = czParts.city
    ? Object.keys(CZ_CITY_PSC).find((c) => c.toLowerCase() === czParts.city.trim().toLowerCase())
    : null;
  const uaCityMatch = originCountry === "ua" && originParts.city
    ? Object.keys(UA_CITY_PSC).find((c) => c.toLowerCase() === originParts.city.trim().toLowerCase())
    : null;

  return (
    <div className="space-y-3">
      {/* Block 1 — always Czech residence address */}
      <div className="rounded-lg border border-slate-200 p-3 bg-slate-50/40">
        <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-2">Adresa pobytu v ČR</div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block col-span-2">
            <span className="text-[11px] text-slate-400">Ulice a číslo popisné</span>
            <input
              value={czParts.street || ""}
              onChange={(e) => setCzPart("street", e.target.value)}
              placeholder="Vinohradská 45"
              autoComplete="off"
              className="mt-1 w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-slate-400">Město</span>
            <CityAutocomplete
              value={czParts.city}
              onChange={(v) => setCzPart("city", v)}
              onSelect={(name, psc) => { setCzPart("city", name); setCzPart("psc", psc); }}
              cityTable={CZ_CITY_PSC}
              placeholder="Praha"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-slate-400">
              PSČ {cityMatch && <span className="text-emerald-600">· doplněno automaticky</span>}
            </span>
            <input
              value={czParts.psc || ""}
              onChange={(e) => setCzPart("psc", e.target.value)}
              placeholder="100 00"
              className="mt-1 w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
            />
          </label>
        </div>
      </div>

      {/* Block 2 — home country address, country picked via short tabs */}
      <div className="rounded-lg border border-slate-200 p-3 bg-slate-50/40">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[11px] uppercase tracking-wide text-slate-400">Adresa v zemi původu</div>
          <div className="flex gap-1">
            {[["ua", "UA"], ["eu", "EU"]].map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setOriginCountry(key)}
                className={`rounded-md px-2 py-0.5 text-[11px] font-medium border transition-colors
                  ${originCountry === key ? "bg-[#0B1220] text-white border-[#0B1220]" : "bg-white text-slate-500 border-slate-200 hover:border-slate-300"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {originCountry === "ua" ? (
          <div className="grid grid-cols-2 gap-3">
            <label className="block col-span-2">
              <span className="text-[11px] text-slate-400">Vulytsia, budynok (ulice, číslo)</span>
              <input
                value={originParts.street || ""}
                onChange={(e) => setOriginPart("street", e.target.value)}
                placeholder="vul. Chreščatyk 10"
                autoComplete="off"
                className="mt-1 w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
              />
            </label>
            <label className="block">
              <span className="text-[11px] text-slate-400">Misto (město)</span>
              <CityAutocomplete
                value={originParts.city}
                onChange={(v) => setOriginPart("city", v)}
                onSelect={(name, psc) => { setOriginPart("city", name); setOriginPart("psc", psc); }}
                cityTable={UA_CITY_PSC}
                placeholder="Kyjev"
              />
            </label>
            <label className="block">
              <span className="text-[11px] text-slate-400">
                Indeks {uaCityMatch && <span className="text-emerald-600">· auto</span>}
              </span>
              <input
                value={originParts.psc || ""}
                onChange={(e) => setOriginPart("psc", e.target.value)}
                placeholder="01001"
                className="mt-1 w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
              />
            </label>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <label className="block col-span-2">
              <span className="text-[11px] text-slate-400">Ulice a číslo</span>
              <input
                value={originParts.street || ""}
                onChange={(e) => setOriginPart("street", e.target.value)}
                autoComplete="off"
                className="mt-1 w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
              />
            </label>
            <label className="block">
              <span className="text-[11px] text-slate-400">Město</span>
              <input
                value={originParts.city || ""}
                onChange={(e) => setOriginPart("city", e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
              />
            </label>
            <label className="block">
              <span className="text-[11px] text-slate-400">PSČ</span>
              <input
                value={originParts.psc || ""}
                onChange={(e) => setOriginPart("psc", e.target.value)}
                className="mt-1 w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
              />
            </label>
            <label className="block col-span-2">
              <span className="text-[11px] text-slate-400">Země</span>
              <input
                value={originParts.country || ""}
                onChange={(e) => setOriginPart("country", e.target.value)}
                placeholder="Polsko, Slovensko, Německo…"
                className="mt-1 w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
              />
            </label>
          </div>
        )}
      </div>
    </div>
  );
}

// Splits a free-text recognized address into a street part and a postal
// code, when one can be confidently found — so the PSČ/indeks field gets
// auto-filled too, not just the street field.
function splitRecognizedAddress(raw) {
  if (!raw) return { street: "" };
  // Ukrainian postal codes: 5 digits. Czech: "NNN NN" (with or without space).
  const czMatch = raw.match(/\b(\d{3}\s?\d{2})\b/);
  const uaMatch = raw.match(/\b(\d{5})\b/);
  const match = czMatch || uaMatch;
  if (!match) return { street: raw.trim() };
  const psc = match[1].replace(/\s+/g, czMatch ? " " : "");
  const street = (raw.slice(0, match.index) + raw.slice(match.index + match[0].length))
    .replace(/[,\s]+$/, "")
    .replace(/^[,\s]+/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { street, psc };
}

// Tries to spot a known city name embedded in the recognized address
// text and split it out into its own field, using the same city lists
// that power the manual autocomplete — so a recognized address ends up
// with city + PSČ already separated, not just dumped into "street".
function smartSplitAddress(raw, countryGuess) {
  const base = splitRecognizedAddress(raw);
  if (!base.street) return base;

  // Search both city tables regardless of any pre-guessed country — a
  // real city-name match is a strong enough signal on its own, and
  // relying on a separately-guessed country (which can be stale from a
  // previous document) was causing the split to silently skip.
  const lowerStreet = base.street.toLowerCase();
  let bestMatch = null;
  let bestKey = null;
  let bestTable = null;
  for (const table of [CZ_CITY_PSC, UA_CITY_PSC]) {
    for (const cityName of Object.keys(table)) {
      // City keys may be "Cyrillic / Latin" (Ukraine) or a plain Czech
      // name — check every segment, since recognized address text is
      // usually in Latin transliteration even for Ukrainian addresses.
      for (const part of cityName.split(" / ").map((p) => p.trim())) {
        if (part.length >= 3 && lowerStreet.includes(part.toLowerCase())) {
          if (!bestMatch || part.length > bestMatch.length) {
            bestMatch = part;
            bestKey = cityName;
            bestTable = table;
          }
        }
      }
    }
  }
  if (!bestMatch) return base;

  const idx = lowerStreet.indexOf(bestMatch.toLowerCase());
  const street = (base.street.slice(0, idx) + base.street.slice(idx + bestMatch.length))
    .replace(/[,\s]+$/, "")
    .replace(/^[,\s]+/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return {
    street,
    city: bestMatch,
    psc: base.psc || bestTable[bestKey],
  };
}

// Saved company profiles persist in this browser (localStorage) so HR
// staff don't have to retype the same employer's IČO/DIČ/address on
// every single contract — pick one from the dropdown to auto-fill, or
// save the currently typed values as a new (or updated) profile.
// Stored server-side (Supabase) so the same list shows up for everyone
// using the site, on any computer — not just this browser.

// CompanyPicker only mounts while step 3 ("Vyplnit") is showing, and gets
// unmounted/remounted every time the user goes back to step 1 and works on
// another document. Without this cache, each remount would re-fetch (and,
// since /api/companies needs a password, potentially re-prompt for) data
// that hasn't changed — even though the user never left the "companies"
// section conceptually, just moved to a different document in the same
// visit. Module-level so it survives remounts but resets on a real page
// reload (see also Clear-Site-Data on the backend for the auth prompt).
let companiesCache = null;

function CompanyPicker({ fields, setFields }) {
  const [companies, setCompanies] = useState(companiesCache || []);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const loadCompanies = useCallback(async (force = false) => {
    if (!force && companiesCache) {
      setCompanies(companiesCache);
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/companies`, { credentials: "include" });
      if (!res.ok) throw new Error("failed");
      const data = await res.json();
      companiesCache = data;
      setCompanies(data);
      setError(null);
    } catch {
      setError("Sdílené firmy se nepodařilo načíst ze serveru.");
    }
  }, []);

  useEffect(() => { loadCompanies(); }, [loadCompanies]);

  const applyCompany = (c) => {
    setFields((f) => ({
      ...f,
      company_name: (c.name || "").toUpperCase(),
      company_ico: c.ico || "",
      company_dic: c.dic || "",
      company_address: c.address || "",
      company_representative: c.representative || "",
    }));
  };

  const handleSelect = (id) => {
    setSelectedId(id);
    if (!id) {
      // "— Vybrat uloženou firmu —" chosen — clear the fields rather
      // than leaving whatever the previously selected company filled in.
      setFields((f) => ({
        ...f,
        company_name: "",
        company_ico: "",
        company_dic: "",
        company_address: "",
        company_representative: "",
      }));
      return;
    }
    const c = companies.find((c) => c.id === id);
    if (c) applyCompany(c);
  };

  const handleSaveCurrent = async () => {
    if (!fields.company_name?.trim()) return;
    setLoading(true);
    setError(null);
    const profile = {
      name: fields.company_name || "",
      ico: fields.company_ico || "",
      dic: fields.company_dic || "",
      address: fields.company_address || "",
      representative: fields.company_representative || "",
    };
    try {
      const res = await fetch(
        selectedId ? `${API_BASE}/api/companies/${selectedId}` : `${API_BASE}/api/companies`,
        {
          method: selectedId ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(profile),
        }
      );
      if (!res.ok) throw new Error("failed");
      const saved = await res.json();
      await loadCompanies(true); // force: the list just changed server-side
      setSelectedId(saved.id);
    } catch {
      setError("Uložení se nezdařilo — zkontrolujte, zda je server dostupný.");
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/companies/${selectedId}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new Error("failed");
      setSelectedId("");
      await loadCompanies(true); // force: the list just changed server-side
    } catch {
      setError("Smazání se nezdařilo — zkontrolujte, zda je server dostupný.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 p-3 bg-slate-50/40 mb-3">
      <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-2">Sdílené firmy</div>
      {error && <p className="mb-2 text-[11.5px] text-red-600">{error}</p>}
      <div className="flex gap-2 items-center flex-wrap">
        <select
          value={selectedId}
          onChange={(e) => handleSelect(e.target.value)}
          className="flex-1 min-w-[160px] rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
        >
          <option value="">— Vybrat uloženou firmu —</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleSaveCurrent}
          disabled={loading}
          className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] font-medium text-slate-600 hover:bg-slate-50 whitespace-nowrap disabled:opacity-50"
        >
          {selectedId ? "Aktualizovat" : "Uložit jako novou"}
        </button>
        {selectedId && (
          <button
            type="button"
            onClick={handleDelete}
            disabled={loading}
            className="rounded-md border border-red-200 bg-white px-2.5 py-1.5 text-[12px] font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            Smazat
          </button>
        )}
      </div>
      <p className="mt-1.5 text-[10.5px] text-slate-400">
        Firmy jsou uložené na serveru — vidí je kdokoliv, kdo tento web používá.
      </p>
    </div>
  );
}

// Default statutory salary caps HR commonly uses when generating these
// contract types — pre-fills the "Mzda" field but stays fully editable,
// and only overwrites a previous *auto-filled* default (never a value
// the person typed themselves) when switching between templates.
const DEFAULT_SALARY_BY_TEMPLATE = {
  dpp_template: "11 999",
  hpp_template: "22 400",
};

function composeCzAddress(parts) {
  return [parts.street, [parts.psc, parts.city].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

function composeOriginAddress(country, parts) {
  if (country === "ua") {
    return [parts.street, parts.city, parts.psc].filter(Boolean).join(", ");
  }
  return [parts.street, [parts.psc, parts.city].filter(Boolean).join(" "), parts.country].filter(Boolean).join(", ");
}

export default function SimpleDocFiller() {
  const [step, setStep] = useState(1); // 1 upload, 2 scanning, 3 form, 4 done
  const [fields, setFields] = useState({});
  const [previewUrls, setPreviewUrls] = useState([]);
  const [czAddressParts, setCzAddressParts] = useState({});
  const [originCountry, setOriginCountry] = useState("ua");
  const [originAddressParts, setOriginAddressParts] = useState({});
  const [warnings, setWarnings] = useState([]);
  const [rawText, setRawText] = useState("");
  const [ocrMode, setOcrMode] = useState(null);
  const [docNumberVerified, setDocNumberVerified] = useState(false);
  const [pendingFiles, setPendingFiles] = useState([]);
  const [pastedText, setPastedText] = useState("");
  const [lightboxUrl, setLightboxUrl] = useState(null);
  const [error, setError] = useState(null);
  const [blanks, setBlanks] = useState([]);
  const [templateId, setTemplateId] = useState(null);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/blanks`)
      .then((r) => r.json())
      .then((data) => {
        setBlanks(data);
        if (data.length > 0) setTemplateId(data[0].id);
      })
      .catch(() => setError(`Nepodařilo se načíst seznam formulářů. Zkontrolujte, zda backend běží na ${API_BASE}.`));
  }, []);

  // Shared by both the file-upload path and the paste-text path: takes
  // an array of /api/recognize-shaped results and merges them into the
  // form's fields, address, and warnings — so pasting text goes through
  // exactly the same field-extraction and auto-fill logic as a photo.
  const applyRecognizedResults = useCallback((results) => {
    const pick = (key) => {
      for (const r of results) {
        if (r[key] && r[key] !== "—") return r[key];
      }
      return "";
    };

    setFields({
      first_name: pick("first_name").toUpperCase(),
      last_name: pick("last_name").toUpperCase(),
      birth_date: pick("birth_date"),
      nationality: pick("nationality"),
      doc_number: pick("doc_number"),
      visa_number: pick("visa_number"),
      visa_validity: pick("visa_validity"),
      position: "",
      workplace: "",
      salary: DEFAULT_SALARY_BY_TEMPLATE[templateId] || "",
      hours_per_week: "",
      start_date: "",
      end_date: "",
      bank_account: "",
      company_name: "",
      company_ico: "",
      company_dic: "",
      company_address: "",
      company_representative: "",
    });
    setDocNumberVerified(results.some((r) => r.doc_number_verified));

    const recognizedAddress = pick("address");
    const newWarnings = [...results.flatMap((r) => r.warnings || [])];
    if (recognizedAddress) {
      newWarnings.push(
        `V dokumentu byl nalezen možný adresní text: „${recognizedAddress}" — zkontrolujte a případně zkopírujte ručně, automaticky se nevyplňuje.`
      );
    }
    setWarnings(newWarnings);
    setRawText(results.map((r, i) => `--- Soubor ${i + 1} ---\n${r.ocr_raw_text || ""}`).join("\n\n"));
    setOcrMode(results[0]?.ocr_mode);
    setStep(3);
  }, [originCountry, templateId]);

  // Adds newly selected/dropped files to the pending queue and shows
  // their thumbnails right away — recognition itself only starts once
  // the person clicks "Rozpoznat a pokračovat", so they can add several
  // photos (and/or paste text) before triggering the actual processing.
  const addPendingFiles = useCallback((fileList) => {
    const files = Array.from(fileList || []).filter(Boolean);
    if (files.length === 0) return;
    setError(null);
    const previews = files.map((f) => {
      const isHeic = /heic|heif/i.test(f.type) || /\.hei[cf]$/i.test(f.name);
      const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
      return {
        name: f.name,
        isPdf,
        isHeic,
        url: !isPdf && !isHeic && f.type.startsWith("image/") ? URL.createObjectURL(f) : null,
      };
    });
    setPendingFiles((prev) => [...prev, ...files]);
    setPreviewUrls((prev) => [...prev, ...previews]);
  }, []);

  const removePendingFile = useCallback((index) => {
    setPreviewUrls((prev) => {
      const removed = prev[index];
      if (removed?.url) URL.revokeObjectURL(removed.url);
      return prev.filter((_, i) => i !== index);
    });
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleConfirmUpload = useCallback(async () => {
    if (pendingFiles.length === 0 && !pastedText.trim()) return;
    setStep(2);
    setError(null);
    try {
      const results = [];
      for (const file of pendingFiles) {
        console.log("[upload] sending", file.name, file.size, "bytes to", `${API_BASE}/api/recognize`);
        const data = await uploadFileViaXHR(`${API_BASE}/api/recognize`, file);
        console.log("[upload] got response", data);
        results.push(data);
      }
      if (pastedText.trim()) {
        const res = await fetch(`${API_BASE}/api/recognize-text`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: pastedText }),
        });
        if (!res.ok) throw new Error("server error");
        results.push(await res.json());
      }
      applyRecognizedResults(results);
    } catch (e) {
      if (e.message === "timeout") {
        setError("Rozpoznávání trvá příliš dlouho (přes 90 s) — server je pravděpodobně přetížený. Zkuste to znovu za chvíli, nebo nahrajte menší/ostřejší fotografii.");
      } else {
        setError(`Nepodařilo se rozpoznat dokument (${e.message}). Zkontrolujte, zda backend běží na ${API_BASE}.`);
      }
      setStep(1);
    }
  }, [pendingFiles, pastedText, applyRecognizedResults]);

  const skipUpload = () => {
    setFields({
      ...Object.fromEntries(FIELD_DEFS.map(([k]) => [k, ""])),
      salary: DEFAULT_SALARY_BY_TEMPLATE[templateId] || "",
    });
    setCzAddressParts({});
    setOriginCountry("ua");
    setOriginAddressParts({});
    setWarnings([]);
    setOcrMode(null);
    setDocNumberVerified(false);
    setPreviewUrls((prev) => { prev.forEach((p) => p.url && URL.revokeObjectURL(p.url)); return []; });
    setPendingFiles([]);
    setPastedText("");
    setStep(3);
  };

  const handleGenerate = async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/fill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          template_id: templateId,
          ...fields,
          address: composeCzAddress(czAddressParts),
          address_origin: composeOriginAddress(originCountry, originAddressParts),
        }),
      });
      if (!res.ok) throw new Error("server error");
      const data = await res.json();
      setResult(data);
      setStep(4);
    } catch (e) {
      setError(`Nepodařilo se vygenerovat dokument. Zkontrolujte, zda backend běží na ${API_BASE}.`);
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setStep(1);
    setFields({});
    setCzAddressParts({});
    setOriginCountry("ua");
    setOriginAddressParts({});
    setWarnings([]);
    setResult(null);
    setError(null);
    setDocNumberVerified(false);
    setPreviewUrls((prev) => { prev.forEach((p) => p.url && URL.revokeObjectURL(p.url)); return []; });
    setPendingFiles([]);
    setPastedText("");
  };

  const downloadUrl = (token) => `${API_BASE}/api/download/${token}`;

  return (
    <div
      className="min-h-screen w-full flex items-start justify-center py-10 px-4"
      style={{
        fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
        backgroundColor: "#FAFAF7",
      }}
    >
      <div className="w-full max-w-xl">
        {/* Header */}
        <div className="flex items-center gap-3 mb-7">
          <div
            className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
            style={{ background: "linear-gradient(135deg, #E8B84B, #C9932E)" }}
          >
            <ShieldCheck size={18} strokeWidth={2.25} className="text-[#0B1220]" />
          </div>
          <div>
            <div
              className="text-[16px] font-semibold tracking-tight text-[#0B1220] leading-none"
              style={{ fontFamily: "'Space Grotesk', sans-serif" }}
            >
              KADR.CZ
            </div>
            <div className="text-[11.5px] text-slate-500 mt-1">Rychlé vyplnění dokumentů</div>
          </div>
        </div>

        {/* Step tracker */}
        <div className="flex items-center gap-1.5 mb-6">
          {["Nahrát", "Rozpoznání", "Vyplnit", "Hotovo"].map((label, i) => {
            const n = i + 1;
            const state = step > n ? "done" : step === n ? "active" : "todo";
            return (
              <div
                key={label}
                className={`flex-1 h-[3px] rounded-full transition-colors ${
                  state === "done" || state === "active" ? "bg-[#C9932E]" : "bg-slate-200"
                }`}
                title={label}
              />
            );
          })}
        </div>
        <div className="flex items-center justify-between mb-6 -mt-4 px-0.5">
          {["Nahrát", "Rozpoznání", "Vyplnit", "Hotovo"].map((label, i) => {
            const n = i + 1;
            const state = step > n ? "done" : step === n ? "active" : "todo";
            return (
              <span
                key={label}
                className={`text-[10.5px] ${state === "todo" ? "text-slate-400" : "text-[#0B1220] font-medium"}`}
              >
                {label}
              </span>
            );
          })}
        </div>

        <div className="rounded-[20px] border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(11,18,32,0.04),0_12px_32px_-16px_rgba(11,18,32,0.18)] overflow-hidden">
          {error && (
            <div className="m-5 mb-0 flex items-start gap-2 rounded-lg bg-red-50 p-3 text-[12.5px] text-red-700">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
            </div>
          )}

          {/* Step 1: upload */}
          {step === 1 && (
            <div className="p-7">
              <h2 className="text-[19px] font-semibold text-[#0B1220]" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>Nahrajte doklady</h2>
              <p className="mt-1 text-[13px] text-slate-500">
                Pas, ID karta, povolení k pobytu, vízum — systém rozpozná a předvyplní údaje
                automaticky. Můžete přidat více souborů i text zároveň (např. pas + vízum).
              </p>

              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); addPendingFiles(e.dataTransfer.files); }}
                className="mt-5 flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-slate-200 bg-slate-50/50 py-10 cursor-pointer hover:border-slate-300 hover:bg-slate-50 transition-colors"
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white border border-slate-200">
                  <Upload size={18} className="text-slate-400" />
                </div>
                <div className="text-center">
                  <div className="text-[13px] font-medium text-[#0B1220]">Přetáhněte soubory nebo klikněte</div>
                  <div className="text-[11.5px] text-slate-400 mt-0.5">JPG, PNG, HEIC, PDF · lze přidat i více najednou</div>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".jpg,.jpeg,.png,.heic,.pdf"
                  className="hidden"
                  onChange={(e) => { addPendingFiles(e.target.files); e.target.value = ""; }}
                />
              </div>

              {previewUrls.length > 0 && (
                <div className="mt-4 flex gap-2 flex-wrap">
                  {previewUrls.map((p, i) => (
                    <div key={i} className="relative w-16 h-16 rounded-lg border border-slate-200 overflow-hidden bg-slate-50 shrink-0 group">
                      {p.url ? (
                        <img src={p.url} alt={p.name} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-slate-400">
                          <FileText size={18} />
                          <span className="text-[8px] leading-none">{p.isPdf ? "PDF" : "HEIC"}</span>
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => removePendingFile(i)}
                        className="absolute top-0.5 right-0.5 flex h-4.5 w-4.5 items-center justify-center rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Odebrat"
                      >
                        <X size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <details className="mt-4">
                <summary className="cursor-pointer text-[12px] text-slate-500 hover:text-[#0B1220]">
                  Nebo vložit text dokladu ručně
                </summary>
                <textarea
                  value={pastedText}
                  onChange={(e) => setPastedText(e.target.value)}
                  placeholder="Vložte sem text dokladu…"
                  rows={5}
                  className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2.5 text-[12.5px] font-mono text-slate-700 resize-none focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10 focus:border-slate-300"
                />
              </details>

              <div className="mt-5 flex items-center gap-2.5">
                <button
                  onClick={handleConfirmUpload}
                  disabled={pendingFiles.length === 0 && !pastedText.trim()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#0B1220] px-5 py-2.5 text-[13px] font-medium text-white hover:bg-[#16243A] disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Rozpoznat a pokračovat <ArrowRight size={14} />
                </button>
                <button
                  onClick={skipUpload}
                  className="text-[12.5px] text-slate-500 hover:text-[#0B1220] py-1"
                >
                  Přeskočit a vyplnit ručně
                </button>
              </div>
            </div>
          )}

          {/* Step 2: scanning */}
          {step === 2 && (
            <div className="p-7">
              <div className="flex flex-col items-center justify-center gap-4 py-14">
                <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-50 border border-slate-200 overflow-hidden">
                  <FileText size={26} className="text-slate-300" />
                  <div className="absolute left-0 right-0 h-0.5 bg-[#C9932E]/70 animate-[scan_1.6s_ease-in-out_infinite]" />
                </div>
                <div className="flex items-center gap-2 text-[13px] font-medium text-[#0B1220]">
                  <Loader2 size={14} className="animate-spin text-slate-400" /> Rozpoznávám dokument…
                </div>
              </div>
              <style>{`@keyframes scan { 0% { top: 4px; } 50% { top: 60px; } 100% { top: 4px; } }`}</style>
            </div>
          )}

          {/* Step 3: form */}
          {step === 3 && (
            <div className="p-7">
              {previewUrls.length > 0 && (
                <div className="mb-4 flex gap-2 flex-wrap">
                  {previewUrls.map((p, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => p.url && setLightboxUrl(p.url)}
                      className={`relative w-16 h-16 rounded-lg border border-slate-200 overflow-hidden bg-slate-50 shrink-0 ${p.url ? "cursor-zoom-in hover:border-slate-300" : "cursor-default"}`}
                      title={p.url ? "Klikněte pro zvětšení" : p.name}
                    >
                      {p.url ? (
                        <img src={p.url} alt={p.name} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-slate-400">
                          <FileText size={18} />
                          <span className="text-[8px] leading-none">{p.isPdf ? "PDF" : "HEIC"}</span>
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {ocrMode === "mock" && (
                <div className="mb-4 flex items-center justify-between rounded-lg bg-emerald-50 px-3 py-2">
                  <span className="text-[12px] text-emerald-700 font-medium">Údaje rozpoznány (demo data)</span>
                </div>
              )}
              {warnings.length > 0 && (
                <div className="mb-4 space-y-2">
                  {warnings.map((w, i) => (
                    <div key={i} className="flex items-start gap-2 rounded-lg bg-amber-50 p-2.5 text-[12px] text-amber-700">
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {w}
                    </div>
                  ))}
                </div>
              )}

              {rawText && rawText.trim() && (
                <details className="mb-4 rounded-lg border border-slate-200 bg-slate-50/60">
                  <summary className="cursor-pointer px-3 py-2 text-[12px] font-medium text-slate-600">
                    Zobrazit rozpoznaný text z dokumentu (pro ruční kopírování)
                  </summary>
                  <textarea
                    readOnly
                    value={rawText}
                    className="w-full h-24 px-3 py-2 text-[11.5px] font-mono text-slate-600 bg-white border-t border-slate-200 resize-none focus:outline-none"
                  />
                </details>
              )}

              <div className="mb-4">
                <label className="text-[11px] uppercase tracking-wide text-slate-400">Typ dokumentu</label>
                <select
                  value={templateId || ""}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    setTemplateId(nextId);
                    // Auto-fill (or clear) the salary default for this
                    // contract type — runs every time, even when the new
                    // template has no default (e.g. "ukončení", "výplatní
                    // páska"), so a stale amount from a previous DPP/HPP
                    // selection doesn't linger. Never touches a value the
                    // person typed themselves.
                    const knownDefaults = Object.values(DEFAULT_SALARY_BY_TEMPLATE);
                    const nextDefault = DEFAULT_SALARY_BY_TEMPLATE[nextId] || "";
                    setFields((f) => {
                      const current = (f.salary || "").trim();
                      if (!current || knownDefaults.includes(current)) {
                        return { ...f, salary: nextDefault };
                      }
                      return f;
                    });
                  }}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2.5 text-[13.5px] text-[#0B1220] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
                >
                  {blanks.map((b) => (
                    <option key={b.id} value={b.id}>{b.title}</option>
                  ))}
                </select>
              </div>

              {(() => {
                const relevantFields = FIELD_DEFS.filter(([, , scope]) => isFieldRelevant(scope, templateId));
                const personFields = relevantFields.filter(([key]) => PERSON_FIELD_KEYS.has(key));
                const restFields = relevantFields.filter(([key]) => !PERSON_FIELD_KEYS.has(key));

                const renderField = ([key, label]) => {
                  const isMono = key === "doc_number" || key.includes("date") || key === "visa_number";
                  const isUppercase = ["first_name", "last_name", "company_name"].includes(key);
                  const showVerified = key === "doc_number" && docNumberVerified && fields[key];
                  return (
                    <label key={key} className="block">
                      <span className="text-[11px] uppercase tracking-wide text-slate-400 inline-flex items-center gap-1.5">
                        {label}
                        {showVerified && (
                          <span className="inline-flex items-center gap-1 rounded-md bg-[#EAF3DE] text-[#3B6D11] text-[9.5px] font-medium px-1.5 py-0.5 normal-case tracking-normal">
                            <Check size={9} strokeWidth={3} /> Ověřeno kontrolním součtem
                          </span>
                        )}
                      </span>
                      <input
                        value={fields[key] || ""}
                        onChange={(e) =>
                          setFields((f) => ({
                            ...f,
                            [key]: isUppercase ? e.target.value.toUpperCase() : e.target.value,
                          }))
                        }
                        style={isMono ? { fontFamily: "'JetBrains Mono', monospace" } : undefined}
                        className={`mt-1 w-full rounded-md border px-2.5 py-1.5 text-[13px] text-[#0B1220] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10 focus:border-slate-300
                          ${showVerified ? "border-[#97C459] bg-[#F7FBF0]" : "border-slate-200"}`}
                      />
                    </label>
                  );
                };

                return (
                  <>
                    {/* 1. Person's own data first */}
                    <div className="grid grid-cols-2 gap-x-4 gap-y-3 mb-4">
                      {personFields.map(renderField)}
                    </div>

                    {/* 2. Addresses next */}
                    <div className="mb-3">
                      <AddressBuilder
                        czParts={czAddressParts}
                        setCzPart={(key, value) => setCzAddressParts((prev) => ({ ...prev, [key]: value }))}
                        originCountry={originCountry}
                        setOriginCountry={(next) => {
                          // Fields are shared between UA/EU modes (they don't
                          // mean the same thing in each — UA has no "country"
                          // field, EU has no "oblast" concept) — clear on
                          // switch so old values from one mode don't silently
                          // leak into the other.
                          setOriginCountry(next);
                          setOriginAddressParts({});
                        }}
                        originParts={originAddressParts}
                        setOriginPart={(key, value) => setOriginAddressParts((prev) => ({ ...prev, [key]: value }))}
                      />
                    </div>

                    {/* 3. Company + everything else (contract terms, payslip specifics) */}
                    <CompanyPicker fields={fields} setFields={setFields} />
                    <div className="grid grid-cols-2 gap-x-4 gap-y-3 max-h-[300px] overflow-y-auto pr-1">
                      {restFields.map(renderField)}
                    </div>
                  </>
                );
              })()}

              <div className="mt-6 flex justify-between items-center">
                <button
                  onClick={() => {
                    setPreviewUrls((prev) => { prev.forEach((p) => p.url && URL.revokeObjectURL(p.url)); return []; });
                    setPendingFiles([]);
                    setPastedText("");
                    setStep(1);
                  }}
                  className="inline-flex items-center gap-1.5 text-[13px] text-slate-500 hover:text-[#0B1220]"
                >
                  <ArrowLeft size={14} /> Zpět
                </button>
                <button
                  onClick={handleGenerate}
                  disabled={loading || !templateId}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#C9932E] px-5 py-2.5 text-[13px] font-medium text-white hover:bg-[#A97A24] disabled:opacity-60"
                >
                  {loading ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
                  {loading ? "Generuji…" : "Vytvořit dokument"}
                </button>
              </div>
            </div>
          )}

          {/* Step 4: done */}
          {step === 4 && result && (
            <div>
              {/* Signature: a torn-stub perforation, echoing an official
                  document/boarding-pass tear line — used once, here, as
                  the one deliberate flourish in an otherwise quiet UI. */}
              <div className="relative flex items-center px-8 pt-2">
                <div className="flex-1 border-t-2 border-dashed border-slate-200" />
              </div>
              <div className="p-8 pt-6 text-center">
                <div
                  className="mx-auto flex h-14 w-14 items-center justify-center rounded-full text-white"
                  style={{ background: "radial-gradient(circle at 30% 30%, #22a35f, #157a45)" }}
                >
                  <Check size={24} />
                </div>
                <h2 className="mt-4 text-[19px] font-semibold text-[#0B1220]" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                  Dokument je hotový
                </h2>
                <p className="mt-1 text-[13px] text-slate-500">Stáhněte si soubor nebo ho rovnou vytiskněte.</p>

                <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <a
                    href={downloadUrl(result.docx_token)}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-4 py-3 text-[13px] font-medium text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-colors"
                  >
                    <Download size={15} /> Stáhnout Word
                  </a>
                  {result.pdf_token && (
                    <a
                      href={downloadUrl(result.pdf_token)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-4 py-3 text-[13px] font-medium text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-colors"
                    >
                      <Printer size={15} /> Otevřít / Tisk (PDF)
                    </a>
                  )}
                  <button
                    onClick={reset}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#0B1220] px-4 py-3 text-[13px] font-medium text-white hover:bg-[#16243A] transition-colors"
                  >
                    <RotateCcw size={15} /> Nový dokument
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <p className="mt-4 text-center text-[11.5px] text-slate-400">
          Žádná data se neukládají — vše probíhá jednorázově.
        </p>
      </div>

      {lightboxUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
          onClick={() => setLightboxUrl(null)}
        >
          <img
            src={lightboxUrl}
            alt="Náhled dokumentu"
            className="max-h-full max-w-full rounded-lg shadow-2xl object-contain"
          />
          <button
            onClick={() => setLightboxUrl(null)}
            className="absolute top-5 right-5 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
          >
            <X size={18} />
          </button>
        </div>
      )}
    </div>
  );
}
