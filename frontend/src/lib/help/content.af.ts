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
		short: 'Die deel van hul behoefte wat hidrologiese eenhede oor die opvanggebied ontvang het. ’n Regverdigheidstoets, nie water wat jou toekom nie.',
		long: 'Tel op wat elke hidrologiese eenheid in die opvanggebied nodig gehad het, en wat hulle almal ontvang het. Die gelyke deel is die tweede as ’n deel van die eerste: as dit 89 % is, het hidrologiese eenhede saam 89 % ontvang van wat hulle nodig gehad het.\n\nDie bladsy oor jou hidrologiese eenheid wys jou eie syfer langsaan, sodat jy kan sien of jy ’n bietjie beter of slegter gevaar het as die opvanggebied as geheel. Dit is ’n regverdigheidstoets, nie ekstra water vir jou nie: of meer water jou hidrologiese eenheid kan bereik, hang af van waar jy aan die rivier lê en wat in jou dam is.\n\nDit word net gewys as daar genoeg hidrologiese eenhede in die opvanggebied is dat dit nie ’n buurman se syfers kan verklap nie.',
		sourceHash: 'f38e31e6cc3f9730938609c1244c8bb980fa498653f42e0c01fe13b789075c3f'
	},
	'farm-reserve': {
		term: 'Die rivier se reserwe',
		short: 'Water wat die wet in die rivier hou sodat dit gesond bly vir almal stroomaf.',
		long: 'Die Suid-Afrikaanse wet hou in elke rivier ’n deel van die water opsy: die Ekologiese Reserwe. Die model kyk dag vir dag of die rivier soveel water by die uitloop en by die meetstasies onder jou hidrologiese eenheid wat vir die reserwe nagegaan word, behou het.\n\nOp dae toe dit nie so was nie, word die hidrologiese eenhede stroomop gevra om dit op te maak, elkeen in verhouding tot die water wat dit opgebruik of opgegaar het. Water wat terugvloei na die rivier tel nie teen jou nie. Op sommige dae was die rivier laag net weens min reën; daardie dae vra niks van enigiemand nie.',
		sourceHash: '820fc041842de63c17b8d4d48c57a1553e5201100bc21bcbdbb2ff896a0f103a'
	},
	'farm-pump-less': {
		term: 'Pomp minder (vir die rivier)',
		short: 'Hoeveel minder jy sou gepomp het op die dae toe die rivier water nodig gehad het, sodat dit sy reserwe behou het.',
		long: 'Die bladsy oor jou hidrologiese eenheid gee dit per dag toe die rivier dit nodig gehad het, nie as ’n gemiddelde oor die hele seisoen nie: om elke dag ’n bietjie minder te pomp, help min op die dae wat saak maak.\n\nAs jou dam ook water teruggehou het wat die rivier nodig gehad het, sê die bladsy dit apart. Daardie deel word nie van jou pompwerk afgetrek nie; as jou dam ’n uitlaat of ’n omleiding het, help dit om daardie water deur te laat.\n\nDit is die model se skatting. Net ’n kennisgewing van jou WGV of van die DWS is ’n beperking.',
		sourceHash: '70347689f149f85c890f3a23485fd61ef9feebb382a26cdc9f6f252d14ac0ff7'
	},
	'farm-modelled': {
		term: 'Gemodelleer (deur die model bereken)',
		short: 'Deur ’n rekenaarmodel van die opvanggebied bereken uit reën, riviervloei en gewasse, nie van ’n meter of peilplaat afgelees nie.',
		long: 'Niemand meet jou dam of jou pomp vir hierdie bladsy nie. Die model bereken elke dag hoeveel reën geval het, hoeveel water met die rivier af na jou hidrologiese eenheid gevloei het, wat jou gewasse nodig gehad het en wat jou dam gehou het.\n\nDit kan verkeerd wees. As jou meter of peilplaat heel anders lees, sê vir jou WGV: dit help hulle om die model reg te stel.',
		sourceHash: 'e13ee4735a050d0437dd12bd188400d26fd23bc93d8f75d4a0c1292b5a472897'
	},
	'farm-needed': {
		term: 'Water wat jy nodig gehad het',
		short: 'Wat jou hidrologiese eenheid vir sy gewasse sou moes pomp: wat die gewasse gebruik, met die water wat onderweg verlore gaan ingereken.',
		long: 'Gewasse het elke dag ’n sekere hoeveelheid water nodig, minus wat die reën hulle gee. Nie al die water wat jy pomp, bereik die gewas nie: ’n deel gaan verlore aan wind, verdamping en afloop. Die model reken dit in met jou besproeiingstelsel se doeltreffendheid (drup ongeveer 90 %, mikro of spilpunt 85 %, sproeiers 75 %, vloedbesproeiing 65 %).\n\nDus is "nodig" wat jy sou moes pomp, die hoeveelheid wat jou meter wys. As die bladsy die verkeerde besproeiingstelsel vir jou hidrologiese eenheid noem, sê vir jou WGV.',
		sourceHash: '606c1a48e34ea0b844283ebe81691d9b82b786db80f19301080f4d3414f01e09'
	},
	'farm-stop-level': {
		term: 'Stopvlak',
		short: 'Die damvlak waar besproeiing stop: jou pompinlaat, of water wat jy terughou. Die model besproei nie daaronder nie.',
		long: '"Jy kan nog gebruik" is die water in jou dam bo hierdie vlak. Die reël oor die dae wat oorbly, deel dit deur wat jy die afgelope 14 dae gebruik het: ’n rowwe riglyn as niks instroom nie.\n\nAs die bladsy sê die model neem aan jou pomp kan die dam leegmaak, is daar nog geen stopvlak vir jou hidrologiese eenheid gestel nie: sê vir jou WGV by watter vlak jou pomp stop.',
		sourceHash: '4fa95b8cb679602824fe6a68314d3f71c45410a59e1ecb4c79230b1ac3361965'
	},
	'farm-model-band': {
		term: 'Model: goed, hou dop of tekort',
		short: 'Die model se eie beoordeling van jou seisoen tot dusver. Nie ’n beperking nie: net ’n kennisgewing van jou WGV of van die DWS is een.',
		long: 'Goed: jy sou minstens 90 % gehad het van die water wat jy nodig gehad het as jy minder vir die rivier gepomp het. Hou dop: 70 tot 90 %, of jou dam het water teruggehou wat die rivier nodig gehad het. Tekort: onder 70 %.\n\nHierdie drempels is ’n voorstel wat die WGV kan verander.',
		sourceHash: '9811a93d9dcbd39c8d22f9190a05098ed8ea58ac05ca2a5c0091726f508ebc4d'
	},
	'farm-saved-copy': {
		term: 'Die kopie op jou foon',
		short: 'Jou hidrologiese eenheid se jongste syfers, op hierdie foon gehou sodat hulle dadelik wys, ook as daar geen sein is nie.',
		long: 'Dit hou net jou eie hidrologiese eenheid se syfers, wat jy in elk geval mag sien. Dit word verwyder wanneer jy uitteken, wanneer iemand anders op hierdie foon inteken, wanneer jy nie meer toegang tot die hidrologiese eenheid het nie, en wanneer dit 30 dae lank nie oopgemaak is nie.\n\nOp ’n foon wat jy deel, kies "Moenie ’n kopie op hierdie foon hou nie" in die Kieslys.',
		sourceHash: '0215489e7daeec6a1feebe322f3922b245b362a08f37c4ab26138e1e671a00f5'
	},
	'farm-wua': {
		term: 'WGV (Watergebruikersvereniging)',
		short: 'Die liggaam van watergebruikers wat watergebruik in jou gebied bestuur. Dit publiseer die syfers op hierdie bladsy, en sy eie kennisgewings.',
		long: '’n Watergebruikersvereniging (WGV) is ’n liggaam van die watergebruikers in ’n gebied, wat ingevolge die Nasionale Waterwet gestig is. Dit bestuur hoe water onder sy lede gedeel word, en dit reik die kennisgewings uit wat vir boere sê hulle moet minder water gebruik. Sommige gebiede het nog ’n besproeiingsraad in plaas van ’n WGV; dit doen dieselfde werk totdat dit ’n WGV word.\n\nDie syfers op die bladsy oor jou hidrologiese eenheid is dié wat jou WGV gepubliseer het. Net ’n kennisgewing van jou WGV of van die Departement van Water en Sanitasie (DWS) is ’n beperking. Vra jou WGV as enigiets op die bladsy onduidelik is.',
		sourceHash: 'e5ee72d44b931e40ae7065ea5cc25ab12fd335fca4e7b9f33ec1e3381a3acc95'
	},
	'farm-season-outlook': {
		term: 'Seisoensvooruitsig (Hierdie seisoen)',
		short: 'Wat die besproeiingsvlak van jou WGV jou hidrologiese eenheid in vorige jare se weer gegee het. Nie ’n voorspelling of ’n belofte nie.',
		long: 'Voor die seisoen loop die model die hele seisoen deur, van waar die opvanggebied se damme op die seisoen se eerste dag gestaan het, een keer met elke vorige jaar se reën en riviervloei. Jou WGV kyk na wat verskeie besproeiingsvlakke sou gee, besluit op een en publiseer dit; die app kies nooit ’n vlak nie.\n\nDie afdeling "Hierdie seisoen" gee wat daardie vlak jou eie hidrologiese eenheid oor daardie vorige jare gegee het: ongeveer hoeveel jy gekry het van die water wat jy nodig gehad het, die spreiding in die meeste van die jare, en hoe vol jou dam aan die einde van die seisoen was. Dit wys nooit ’n buurman se syfers nie.\n\nHierdie seisoen se weer sal sy eie gang gaan, so jou deel kan buite daardie spreiding val. Jou WGV hersien die vlak op die datum wat in daardie afdeling staan. Net ’n kennisgewing van jou WGV of van die DWS is ’n beperking.',
		sourceHash: '547b779099c54a5860da5afa8c73aa7aac8d9bd34fbec024c9c5c5df9bd67aaf'
	},
	'farm-forecast': {
		term: 'Voorspelling (Volgende 14 dae)',
		short: 'Wat die model volgens die reënvoorspelling vir jou dam en water in die volgende dae verwag. Nie die seisoensvooruitsig of ’n belofte nie.',
		long: 'Wanneer jou WGV ’n voorspelling publiseer, loop die model die komende dae deur volgens die reënvoorspelling, van jou hidrologiese eenheid se jongste syfers af. Die afdeling gee die laagste vlak wat die model verwag jou dam sal bereik, en omstreeks watter dag, en op hoeveel van daardie dae jy dalk te min water sal hê.\n\nDit is nie die seisoensvooruitsig nie. Die seisoensvooruitsig kyk na die hele seisoen in vorige jare se weer; die voorspelling kyk net na die volgende paar dae, volgens die reënvoorspelling vir daardie dae.\n\nReënvoorspellings verander van dag tot dag, so kyk na die datum waarop die afdeling sê die voorspelling gemaak is: as dit meer as ’n paar dae oud is, sê die afdeling dit eerste. Net ’n kennisgewing van jou WGV of van die DWS is ’n beperking.',
		sourceHash: '3712bc7f40417bf769889dae9fe8eea78b5259f9aa5083b441593fd89eb46654'
	},
	'farm-registered': {
		term: 'Jou geregistreerde water',
		short: 'Watergebruik en damberging vir jou hidrologiese eenheid by die DWS geregistreer. Nie ’n reg op die water of bewys van wettige gebruik nie.',
		long: 'Watergebruikers registreer hul watergebruik by die Departement van Water en Sanitasie (DWS). Die afdeling wys wat vandag vir jou hidrologiese eenheid geregistreer is: die oppervlakwater en grondwater per jaar, en die damberging. Dit wys net jou eie totale, nooit ’n buurman s’n nie, en geen name of registrasienommers nie.\n\nLangsaan sit dit wat die model hierdie seisoen gelewer het en wat jou dam in die model hou wanneer hy vol is, sodat jy kan vergelyk. Die model bereken jou water uit reën, riviervloei en jou gewasse, nie uit wat geregistreer is nie, so die twee kan verskil.\n\n’n Geregistreerde volume is nie ’n reg op water nie: dit gee jou nie daardie water nie, en dit sê nie of ’n gebruik wettig is nie. As die geregistreerde syfers verkeerd lyk, vra jou WGV.',
		sourceHash: '328fb13cc84eac6c183a8a43f7a1c588ae8edc5113d650a22708feee8393633e'
	},
	'farm-pct-volume': {
		term: 'Persentasie, m³ en ML',
		short: '’n Persentasie vergelyk twee hoeveelhede, soos water wat jy ontvang het met wat jy nodig gehad het. m³ en ML meet water: 1 ML is 1 000 m³.',
		long: '"83 % van wat jy nodig gehad het" beteken jy het 83 dele ontvang vir elke 100 dele water wat jou hidrologiese eenheid hierdie seisoen nodig gehad het. "40 % vol" beteken jou dam hou 40 dele vir elke 100 wat hy hou wanneer hy vol is.\n\n’n Kubieke meter (m³) is 1 000 liter. ’n Megaliter (ML) is ’n miljoen liter, dit is 1 000 m³. Die ML- en m³-knoppies onder "Water wat jy hierdie seisoen ontvang het" skakel die volumes op die bladsye oor jou hidrologiese eenheid tussen die twee om: die water is dieselfde, net die maateenheid verander. Jou keuse word in jou rekening gestoor en op hierdie foon gehou; jy kan dit ook op jou rekeningbladsy verander, onder Taal en eenhede.',
		sourceHash: '0dd2795c6cb14c2908c58f21a2ec89ac0fe25299b7613f0ef91d984279ba4817'
	},
	'farm-alerts': {
		term: 'Waarskuwings-e-posse',
		short: 'E-posse wat sê wanneer jou dam volgens die model onder die vlak sak wat jou WGV gestel het, of jou WGV ’n beperkingskennisgewing publiseer.',
		long: 'Jou WGV besluit watter waarskuwings in die opvanggebied aangeskakel is, en vir ’n damwaarskuwing by watter vlak dit waarsku. Op die bladsy Waarskuwings-e-posse in jou rekening kies jy vir elkeen of jy dit dadelik kry, in ’n opsomming een keer ’n dag om 06:00, of glad nie. Op ’n dag met baie waarskuwings kom net die eerste paar dadelik; die res wag vir die volgende oggend se opsomming.\n\n’n Damwaarskuwing is die model se skatting, uit die jongste syfers of uit die reënvoorspelling. Dit is nie ’n beperking nie: net ’n kennisgewing van jou WGV of van die DWS is een.\n\nElke waarskuwings-e-pos het ’n skakel om daardie soort e-pos te stop, en een om te sê of dit nuttig was. As e-posse na jou adres terugbons, word waarskuwings-e-posse onderbreek; die bladsy Waarskuwings-e-posse sê so en laat jou toe om hulle weer aan te skakel.',
		sourceHash: 'b048c34f9cd6b6b8cb1b06fe3109626f49f30e6c5f083e72812c860583285a00'
	},
	'farm-two-step': {
		term: 'Tweestap-intekening',
		short: 'Ná jou wagwoord, ’n 6-syferkode van ’n app op jou foon of uit ’n e-pos, sodat iemand wat jou wagwoord uitvind, steeds nie kan inkom nie.',
		long: 'Dit is jou keuse: die bladsye oor jou hidrologiese eenheid het dit nie nodig nie. Skakel dit aan onder Tweestap-intekening op jou rekeningbladsy, op een of albei maniere. ’n Verifikasie-app op jou foon maak elke 30 sekondes ’n nuwe kode. ’n Kode per e-pos word elke keer gestuur wanneer jy inteken, en werk 10 minute lank. Die app is die veiligste van die twee, want enigiemand wat jou e-pos kan lees, kan ook ’n kode gebruik wat daarheen gestuur is.\n\nDie eerste keer dat jy dit aanskakel, kry jy tien herstelkodes, wat net een keer gewys word. Laai hulle af of kopieer hulle, en bêre hulle op ’n veilige plek, weg van jou foon. Elkeen werk een keer, in plaas van ’n kode. Jou rekeningbladsy sê hoeveel oor is, en skep ’n nuwe stel wanneer jy een nodig het.\n\nAs jy jou foon verloor, teken in met ’n herstelkode. As jy ook jou herstelkodes verloor het, kies by die stap wat na die kode vra om ’n herstelkode te gebruik, kies dan die skakel vir verlore herstelkodes, en ons e-pos vir jou ’n skakel. Sodra jy dit oopmaak, word tweestap-intekening ná 3 dae verwyder, en jy word op elke toestel uitgeteken; niks anders aan jou rekening verander nie. Die wagtyd beskerm jou rekening teen iemand wat jou wagwoord ken: ons e-pos jou tot dan elke dag met ’n skakel om dit te kanselleer, en as jy met ’n kode inteken, word dit ook gekanselleer.',
		sourceHash: '998649c054017e4c665b982f0ec316ffdba041fc7a6c079a1d95a3fe0549b693'
	},
	'farm-invitation': {
		term: '’n Uitnodiging na ’n opvanggebied',
		short: '’n E-pos wat jou vra om by ’n opvanggebied aan te sluit, gewoonlik van jou WGV. Niks verander totdat jy aanvaar nie, en jy kan dit afwys.',
		long: 'Jou WGV, of wie ook al die opvanggebied vir die WGV modelleer, stuur die uitnodiging na jou e-posadres. Die uitnodiging noem die opvanggebied, wie dit gestuur het, in watter rol jy aansluit, die hidrologiese eenhede waaraan dit jou koppel, en tot watter datum dit geldig is. Vra ná daardie datum die persoon wat dit gestuur het vir ’n nuwe een.\n\nAs jy as boer aanvaar, sien jy die bladsye van daardie hidrologiese eenhede: die syfers wat jou WGV vir hulle gepubliseer het, jou dam en jou water. Jy sien nooit ’n ander hidrologiese eenheid se naam of syfers nie. As jy dit afwys, sien die persoon wat dit gestuur het net dat jy afgewys het. Niemand kan jou dwing om aan te sluit nie.\n\nDie mense wat die opvanggebied se model bestuur, sien jou naam, jou e-posadres en aan watter hidrologiese eenhede jy gekoppel is. Ander boere in die opvanggebied sien nooit jou naam, jou e-posadres of jou syfers nie. As die hidrologiese eenhede wat genoem word nie joune is nie, wys dit af en laat weet jou WGV.',
		sourceHash: '2bb5c1e4a6ffe51d87c5fc8f6aefa63e6f8f0bda1077b511fe1916ec6b52e56d'
	},
};
