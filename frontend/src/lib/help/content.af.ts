// Afrikaans versions of the farmer glossary entries (farmer.ts, category
// 'farmer'; shown on /farm/words), WP-2.5. Only checked text goes here.
//
// Provenance (2026-09-26, issue #49): every entry was written by the
// af-translator agent and reviewed by the af-checker agent
// (.claude/agents/i18n/), then applied with `pnpm gen:i18n:apply`. No native
// speaker has reviewed it yet; that review is open in docs/followups.md
// § Afrikaans (WP-2.5). Corrections go straight into this file.
//
// `sourceHash` is the SHA-256 (hex) of the English `term + "\n" + short +
// "\n" + long` the translation was made from. content.af.test.ts fails when
// the English has changed since (the translation is stale), when an entry
// isn't a farmer entry, and when a farmer entry has neither a translation nor
// a row on docs/i18n/af-translation-sheet.md. An entry without a translation
// shows in English (marked lang="en"). Once the translator has re-checked a
// stale entry, `pnpm gen:i18n:stamp <id>` writes the current English's hash
// here and rewrites the sheet; `pnpm check:i18n` lists the stale ones.
//
// Only type imports: scripts/guards/i18n_sheet.mjs loads this file directly.

export interface HelpTranslation {
	term: string;
	short: string;
	long: string;
	sourceHash: string;
}

export const HELP_AF: Record<string, HelpTranslation> = {
	'farm-even-share': {
		term: 'Gelyke deel',
		short: 'Die deel van hul behoefte wat plase oor die hele opvanggebied ontvang het. ’n Regverdigheidstoets, nie water wat jou toekom nie.',
		long: 'Tel op wat elke plaas in die opvanggebied nodig gehad het, en wat hulle almal ontvang het. Die gelyke deel is die tweede as ’n deel van die eerste: as dit 89 % is, het plase saam 89 % ontvang van wat hulle nodig gehad het.\n\nJou plaasbladsy wys jou eie syfer langsaan, sodat jy kan sien of jy ’n bietjie beter of slegter gevaar het as die opvanggebied as geheel. Dit is ’n regverdigheidstoets, nie ekstra water vir jou nie: of meer water jou plaas kan bereik, hang af van waar jy aan die rivier lê en wat in jou dam is.\n\nDit word net gewys as daar genoeg plase in die opvanggebied is dat dit nie ’n buurman se syfers kan verklap nie.',
		sourceHash: '12fb005bdc918fadd911d84f03a437ee73e2321ad9de86f2a4f959dd902c1296'
	},
	'farm-reserve': {
		term: 'Die rivier se reserwe',
		short: 'Water wat die wet in die rivier hou sodat dit gesond bly vir almal stroomaf.',
		long: 'Die Suid-Afrikaanse wet hou in elke rivier ’n deel van die water opsy: die Ekologiese Reserwe. Die model kyk dag vir dag of die rivier soveel water by die uitloop en by die meetstasies onder jou plaas wat vir die reserwe nagegaan word, behou het.\n\nOp dae toe dit nie so was nie, word die plase stroomop gevra om dit op te maak, elkeen in verhouding tot die water wat hy opgebruik of opgegaar het. Water wat terugvloei na die rivier tel nie teen jou nie. Op sommige dae was die rivier laag net weens min reën; daardie dae vra niks van enigiemand nie.',
		sourceHash: 'cd34e7832146ec7668bbf98836120eb2eba4ce0d2ca15f160bd99a5d89ec079f'
	},
	'farm-pump-less': {
		term: 'Pomp minder (vir die rivier)',
		short: 'Hoeveel minder jy sou gepomp het op die dae toe die rivier water nodig gehad het, sodat dit sy reserwe behou het.',
		long: 'Jou plaasbladsy gee dit per dag toe die rivier dit nodig gehad het, nie as ’n gemiddelde oor die hele seisoen nie: om elke dag ’n bietjie minder te pomp, help min op die dae wat saak maak.\n\nAs jou dam ook water teruggehou het wat die rivier nodig gehad het, sê die bladsy dit apart. Daardie deel word nie van jou pompwerk afgetrek nie; as jou dam ’n uitlaat of ’n omleiding het, help dit om daardie water deur te laat.\n\nDit is die model se skatting. Net ’n kennisgewing van jou WGV is ’n beperking.',
		sourceHash: 'b7937f7ab02e4b369a129bdda40a92fbd415b586417a6fe4bbe777a7ca9d0fee'
	},
	'farm-modelled': {
		term: 'Gemodelleer (deur die model bereken)',
		short: 'Deur ’n rekenaarmodel van die opvanggebied bereken uit reën, riviervloei en gewasse, nie van ’n meter of peilplaat afgelees nie.',
		long: 'Niemand meet jou dam of jou pomp vir hierdie bladsy nie. Die model bereken elke dag hoeveel reën geval het, hoeveel water met die rivier af na jou plaas gevloei het, wat jou gewasse nodig gehad het en wat jou dam gehou het.\n\nDit kan verkeerd wees. As jou meter of peilplaat heel anders lees, sê vir jou WGV: dit help hulle om die model reg te stel.',
		sourceHash: 'ded564c2423cd82906cc132c994961e5dc58bd65660a6026c9c2db17cf18ed9b'
	},
	'farm-needed': {
		term: 'Water wat jy nodig gehad het',
		short: 'Wat jou plaas vir sy gewasse sou moes pomp: wat die gewasse gebruik, met die water wat onderweg verlore gaan ingereken.',
		long: 'Gewasse het elke dag ’n sekere hoeveelheid water nodig, minus wat die reën hulle gee. Nie al die water wat jy pomp, bereik die gewas nie: ’n deel gaan verlore aan wind, verdamping en afloop. Die model reken dit in met jou besproeiingstelsel se doeltreffendheid (drup ongeveer 90 %, mikro of spilpunt 85 %, sproeiers 75 %, vloedbesproeiing 65 %).\n\nDus is "nodig" wat jy sou moes pomp, die hoeveelheid wat jou meter wys. As die bladsy die verkeerde besproeiingstelsel vir jou plaas noem, sê vir jou WGV.',
		sourceHash: 'a3d3b9f5fca5ee5462f7fda6adb105cc6f463fa988412dc1a0123cf9be0b2ac2'
	},
	'farm-stop-level': {
		term: 'Stopvlak',
		short: 'Die damvlak waar besproeiing stop: jou pompinlaat, of water wat jy terughou. Die model besproei nie daaronder nie.',
		long: '"Jy kan nog gebruik" is die water in jou dam bo hierdie vlak. Die reël oor die dae wat oorbly, deel dit deur wat jy die afgelope 14 dae gebruik het: ’n rowwe riglyn as niks instroom nie.\n\nAs die bladsy sê die model neem aan jou pomp kan die dam leegmaak, is daar nog geen stopvlak vir jou plaas gestel nie: sê vir jou WGV by watter vlak jou pomp stop.',
		sourceHash: '3a36166dd04a0856af9d3dc3183a21509dd7b4875f506eace83e72788ff25507'
	},
	'farm-model-band': {
		term: 'Model: goed, hou dop of tekort',
		short: 'Die model se eie beoordeling van jou seisoen tot dusver. Nie ’n beperking nie: net ’n kennisgewing van jou WGV is een.',
		long: 'Goed: jy sou minstens 90 % gehad het van die water wat jy nodig gehad het as jy minder vir die rivier gepomp het. Hou dop: 70 tot 90 %, of jou dam het water teruggehou wat die rivier nodig gehad het. Tekort: onder 70 %.\n\nHierdie drempels is ’n voorstel wat die WGV kan verander.',
		sourceHash: 'aacaa9467417def76b6cdb571cc957bd0c65b683504244df0509cd5671f4a9b9'
	},
	'farm-saved-copy': {
		term: 'Die kopie op jou foon',
		short: 'Jou plaas se jongste syfers, op hierdie foon gehou sodat hulle dadelik wys, ook as daar geen sein is nie.',
		long: 'Dit hou net jou eie plaas se syfers, wat jy in elk geval mag sien. Dit word verwyder wanneer jy uitteken, wanneer iemand anders op hierdie foon inteken, wanneer jy nie meer toegang tot die plaas het nie, en wanneer dit 30 dae lank nie oopgemaak is nie.\n\nOp ’n foon wat jy deel, kies "Moenie ’n kopie op hierdie foon hou nie" in die Kieslys.',
		sourceHash: '6cfcf9b3943e90fe604d0510c0f187b1d5376d22e433f0dd68186ca59ed9a4b4'
	},
};
