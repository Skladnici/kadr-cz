// Practical, sizeable set of Czech towns/city districts with PSČ — not
// the full official ~15,000-entry postal registry (that would need a
// real downloaded dataset), but covers the large majority of real
// addresses HR staff will type. Anything not listed here (a small town
// or village) falls back to live Nominatim geocoding instead — see
// AddressBuilder.jsx's isUnlistedCity/shouldGeocode.
//
// A single PSČ per city name is only actually true for smaller towns
// with one post office. The 26 legally-defined "statutární města" (plus
// bare "Praha") are large enough to span several postal districts, so
// autofilling one fixed code for them would silently put a wrong PSČ on
// a real contract depending which part of the city the address is
// actually in. "Praha 1".."Praha 22" have the *same* problem: postal
// codes in Prague follow cadastral/post-office zones, not the numbered
// administrative-district boundaries, so a single "Praha 4" address can
// legitimately be 140 xx, 141 xx, or 143 xx depending on the street
// (confirmed via Nominatim, e.g. "Jihozápadní V 1023/15, Praha 4" is
// really 141 00, not the previously-hardcoded 140 00). A full audit of
// every non-statutory town then in this file (two independent Nominatim
// passes — post-office-name search, then spatial ring sampling around
// each town's center — each cross-checked against okres to reject same-
// name villages elsewhere) found 111 more towns with the same problem on
// a smaller scale (e.g. Kolín spans 280 02 *and* 280 00), all included
// below too. CZ_CITY_PSC has "" for everything in this set — see
// AddressBuilder.jsx, which treats that as "ask the person to type it
// themselves" (or resolves it via live geocoding) instead of auto-filling
// a potentially-wrong value.
export const CZ_AMBIGUOUS_PSC_CITIES = new Set([
  "Praha", "Brno", "Ostrava", "Plzeň", "Liberec", "Olomouc", "České Budějovice",
  "Hradec Králové", "Ústí nad Labem", "Pardubice", "Zlín", "Havířov", "Kladno",
  "Most", "Opava", "Frýdek-Místek", "Karviná", "Jihlava", "Teplice",
  "Karlovy Vary", "Chomutov", "Jablonec nad Nisou", "Mladá Boleslav",
  "Prostějov", "Přerov", "Třinec", "Děčín",
  "Praha 1", "Praha 2", "Praha 3", "Praha 4", "Praha 5", "Praha 6", "Praha 7",
  "Praha 8", "Praha 9", "Praha 10", "Praha 11", "Praha 12", "Praha 13",
  "Praha 14", "Praha 15", "Praha 16", "Praha 17", "Praha 18", "Praha 19",
  "Praha 20", "Praha 21", "Praha 22",
  // Non-statutory towns individually confirmed (via Nominatim, street-level
  // spot checks across multiple parts of each town) to actually span more
  // than one real PSČ, the same way the cities above do — just found later
  // because they're not statutory and so weren't in scope for the first pass.
  "Kolín", "Chrudim", "Uherské Hradiště", "Kutná Hora", "Náchod", "Česká Lípa",
  "Třebíč", "Tábor", "Znojmo", "Příbram", "Cheb", "Trutnov", "Vsetín",
  "Litoměřice", "Šumperk", "Nový Jičín", "Vyškov", "Jindřichův Hradec",
  "Břeclav", "Litvínov", "Otrokovice", "Kyjov", "Hranice", "Studénka",
  "Orlová", "Bohumín", "Broumov", "Brandýs nad Labem-Stará Boleslav",
  "Milovice", "Nepomuk", "Sušice", "Český Krumlov", "Bílovec", "Fulnek",
  "Vítkov", "Písek", "Havlíčkův Brod", "Nymburk", "Benešov", "Jičín",
  "Krnov", "Vrchlabí", "Boskovice", "Turnov", "Poděbrady", "Kaplice",
  // Second pass over the remaining ~118 towns using spatial sampling (16
  // reverse-geocoded points in two rings around each town's center, cross-
  // checked against the same okres as the point matching the previously-
  // hardcoded PSČ, to filter out same-name villages in other regions —
  // one such case, "Kladruby", was caught and correctly excluded this way:
  // its "extra" codes turned out to belong to a same-named village in
  // okres Benešov, not the real Kladruby u Stříbra this app means).
  "Klatovy", "Rakovník", "Hodonín", "Vlašim", "Sokolov", "Beroun", "Louny",
  "Svitavy", "Domažlice", "Rokycany", "Kopřivnice", "Valašské Meziříčí",
  "Rychnov nad Kněžnou", "Semily", "Žďár nad Sázavou", "Kralupy nad Vltavou",
  "Neratovice", "Roudnice nad Labem", "Varnsdorf", "Rumburk", "Žatec",
  "Uherský Brod", "Slavkov u Brna", "Tišnov", "Rosice", "Rájec-Jestřebí",
  "Letovice", "Miroslav", "Chotěboř", "Ledeč nad Sázavou", "Nový Bydžov",
  "Dvůr Králové nad Labem", "Police nad Metují", "Hostinné", "Železný Brod",
  "Hořice", "Sedlčany", "Dobříš", "Zdice", "Mníšek pod Brdy", "Říčany",
  "Čelákovice", "Lysá nad Labem", "Sadská", "Bakov nad Jizerou", "Přeštice",
  "Nýřany", "Stod", "Horšovský Týn", "Horažďovice", "Vodňany", "Třeboň",
  "Suchdol nad Lužnicí", "Milevsko", "Sezimovo Ústí", "Moravské Budějovice",
  "Jemnice", "Veselí nad Moravou", "Strážnice", "Uherský Ostroh",
  "Rožnov pod Radhoštěm", "Frenštát pod Radhoštěm", "Odry", "Hlučín", "Hať",
]);

export const CZ_CITY_PSC = {
  "Praha": "",
  "Praha 1": "", "Praha 2": "", "Praha 3": "", "Praha 4": "",
  "Praha 5": "", "Praha 6": "", "Praha 7": "", "Praha 8": "",
  "Praha 9": "", "Praha 10": "", "Praha 11": "", "Praha 12": "",
  "Praha 13": "", "Praha 14": "", "Praha 15": "", "Praha 16": "",
  "Praha 17": "", "Praha 18": "", "Praha 19": "", "Praha 20": "",
  "Praha 21": "", "Praha 22": "",
  "Brno": "", "Ostrava": "", "Plzeň": "", "Liberec": "",
  "Olomouc": "", "České Budějovice": "", "Hradec Králové": "",
  "Ústí nad Labem": "", "Pardubice": "", "Zlín": "",
  "Havířov": "", "Kladno": "", "Most": "", "Opava": "",
  "Frýdek-Místek": "", "Karviná": "", "Jihlava": "",
  "Teplice": "", "Děčín": "", "Karlovy Vary": "",
  "Chomutov": "", "Jablonec nad Nisou": "", "Mladá Boleslav": "",
  "Prostějov": "", "Přerov": "", "Česká Lípa": "",
  "Třebíč": "", "Třinec": "", "Tábor": "", "Znojmo": "",
  "Kolín": "", "Příbram": "", "Cheb": "", "Trutnov": "",
  "Vsetín": "", "Kroměříž": "767 01", "Litoměřice": "",
  "Písek": "", "Uherské Hradiště": "", "Šumperk": "",
  "Nový Jičín": "", "Chrudim": "", "Klatovy": "",
  "Vyškov": "", "Jindřichův Hradec": "", "Břeclav": "",
  "Rakovník": "", "Strakonice": "386 01", "Havlíčkův Brod": "",
  "Hodonín": "", "Bruntál": "792 01", "Vlašim": "",
  "Sokolov": "", "Kutná Hora": "", "Beroun": "",
  "Blansko": "678 01", "Louny": "", "Náchod": "",
  "Svitavy": "", "Jičín": "", "Domažlice": "",
  "Rokycany": "", "Litvínov": "", "Krnov": "",
  "Kopřivnice": "", "Otrokovice": "", "Valašské Meziříčí": "",
  "Rychnov nad Kněžnou": "", "Semily": "", "Žďár nad Sázavou": "",
  "Nymburk": "", "Benešov": "", "Kralupy nad Vltavou": "",
  "Neratovice": "", "Roudnice nad Labem": "", "Varnsdorf": "",
  "Frýdlant": "464 01", "Rumburk": "", "Vrchlabí": "",
  "Kadaň": "432 01", "Žatec": "", "Aš": "352 01",
  "Kyjov": "", "Uherský Brod": "", "Hranice": "",
  "Studénka": "", "Orlová": "", "Bohumín": "",
  "Boskovice": "", "Kuřim": "664 34", "Ivančice": "664 91",
  "Slavkov u Brna": "", "Tišnov": "", "Rosice": "",
  "Adamov": "679 04", "Rájec-Jestřebí": "", "Letovice": "",
  "Moravský Krumlov": "672 01", "Miroslav": "", "Pohořelice": "691 23",
  "Dačice": "380 01", "Telč": "588 56", "Kamenice nad Lipou": "394 70",
  "Pelhřimov": "393 01", "Humpolec": "396 01", "Chotěboř": "",
  "Světlá nad Sázavou": "582 91", "Ledeč nad Sázavou": "",
  "Chlumec nad Cidlinou": "503 51", "Nový Bydžov": "",
  "Dvůr Králové nad Labem": "", "Broumov": "",
  "Police nad Metují": "", "Hostinné": "",
  "Turnov": "", "Český Dub": "463 43", "Železný Brod": "",
  "Nová Paka": "509 01", "Hořice": "", "Lomnice nad Popelkou": "512 51",
  "Sedlčany": "", "Dobříš": "", "Hořovice": "268 01",
  "Zdice": "", "Mníšek pod Brdy": "", "Jílové u Prahy": "254 01",
  "Říčany": "", "Brandýs nad Labem-Stará Boleslav": "",
  "Čelákovice": "", "Lysá nad Labem": "", "Poděbrady": "",
  "Sadská": "", "Milovice": "", "Bakov nad Jizerou": "",
  "Bělá pod Bezdězem": "294 21", "Dobrovice": "294 41", "Mšeno": "277 35",
  "Mělník": "276 01", "Kladruby": "349 61", "Stříbro": "349 01",
  "Přeštice": "", "Nepomuk": "", "Blovice": "336 01",
  "Nýřany": "", "Stod": "", "Horšovský Týn": "",
  "Sušice": "", "Horažďovice": "", "Kašperské Hory": "341 92",
  "Vimperk": "385 01", "Prachatice": "383 01", "Netolice": "384 11",
  "Vodňany": "", "Trhové Sviny": "374 01", "Kaplice": "",
  "Český Krumlov": "", "Lipno nad Vltavou": "382 78",
  "Třeboň": "", "Suchdol nad Lužnicí": "", "Nová Bystřice": "378 33",
  "Milevsko": "", "Bechyně": "391 65", "Sezimovo Ústí": "",
  "Soběslav": "392 01", "Veselí nad Lužnicí": "391 81",
  "Bystřice nad Pernštejnem": "593 01", "Nové Město na Moravě": "592 31",
  "Velké Meziříčí": "594 01", "Náměšť nad Oslavou": "675 71",
  "Moravské Budějovice": "", "Jemnice": "",
  "Slavonice": "378 81", "Jaroměřice nad Rokytnou": "675 51",
  "Bzenec": "696 81", "Veselí nad Moravou": "",
  "Strážnice": "", "Uherský Ostroh": "",
  "Bojkovice": "687 71", "Luhačovice": "763 26", "Slavičín": "763 21",
  "Valašské Klobouky": "766 01", "Rožnov pod Radhoštěm": "",
  "Frenštát pod Radhoštěm": "", "Bílovec": "",
  "Fulnek": "", "Odry": "", "Vítkov": "",
  "Hlučín": "", "Kravaře": "747 21", "Hať": "",
};

// Ukrainian oblast capitals and major cities with the central poshtovyi
// indeks (postal code) for that city. Same practical, non-exhaustive
// approach as the Czech list above.
export const UA_CITY_PSC = {
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
