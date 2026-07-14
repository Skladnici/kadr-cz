// Practical, sizeable set of Czech towns/city districts with PSČ — not
// the full official ~15,000-entry postal registry (that would need a
// real downloaded dataset), but covers the large majority of real
// addresses HR staff will type. Anything not listed here (a small town
// or village) falls back to live Nominatim geocoding instead — see
// AddressBuilder.jsx's isUnlistedCity/shouldGeocode.
//
// A single PSČ per city name is only actually true for smaller towns
// with one post office. The 26 legally-defined "statutární města" (plus
// bare "Praha" — as opposed to "Praha 1".."Praha 22", which do each have
// their own accurate, real PSČ) are large enough to span several postal
// districts, so autofilling one fixed code for them would silently put a
// wrong PSČ on a real contract depending which part of the city the
// address is actually in. CZ_CITY_PSC below intentionally has "" for
// these — see AddressBuilder.jsx, which treats that as "ask the person
// to type it themselves" instead of auto-filling.
export const CZ_AMBIGUOUS_PSC_CITIES = new Set([
  "Praha", "Brno", "Ostrava", "Plzeň", "Liberec", "Olomouc", "České Budějovice",
  "Hradec Králové", "Ústí nad Labem", "Pardubice", "Zlín", "Havířov", "Kladno",
  "Most", "Opava", "Frýdek-Místek", "Karviná", "Jihlava", "Teplice",
  "Karlovy Vary", "Chomutov", "Jablonec nad Nisou", "Mladá Boleslav",
  "Prostějov", "Přerov", "Třinec", "Děčín",
]);

export const CZ_CITY_PSC = {
  "Praha": "",
  "Praha 1": "110 00", "Praha 2": "120 00", "Praha 3": "130 00", "Praha 4": "140 00",
  "Praha 5": "150 00", "Praha 6": "160 00", "Praha 7": "170 00", "Praha 8": "180 00",
  "Praha 9": "190 00", "Praha 10": "100 00", "Praha 11": "149 00", "Praha 12": "143 00",
  "Praha 13": "155 00", "Praha 14": "198 00", "Praha 15": "109 00", "Praha 16": "165 00",
  "Praha 17": "163 00", "Praha 18": "199 00", "Praha 19": "197 00", "Praha 20": "193 00",
  "Praha 21": "190 16", "Praha 22": "104 00",
  "Brno": "", "Ostrava": "", "Plzeň": "", "Liberec": "",
  "Olomouc": "", "České Budějovice": "", "Hradec Králové": "",
  "Ústí nad Labem": "", "Pardubice": "", "Zlín": "",
  "Havířov": "", "Kladno": "", "Most": "", "Opava": "",
  "Frýdek-Místek": "", "Karviná": "", "Jihlava": "",
  "Teplice": "", "Děčín": "", "Karlovy Vary": "",
  "Chomutov": "", "Jablonec nad Nisou": "", "Mladá Boleslav": "",
  "Prostějov": "", "Přerov": "", "Česká Lípa": "470 01",
  "Třebíč": "674 01", "Třinec": "", "Tábor": "390 02", "Znojmo": "669 02",
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
