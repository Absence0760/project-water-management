// Afrikaans wording of the farmer surfaces (WP-2.5). Only checked text goes
// here: the words go to real farmers. A message with no entry shows in
// English, and it is on docs/i18n/af-translation-sheet.md, the sheet the
// translator fills in.
//
// Provenance (2026-09-26, issue #49): every entry was written by the
// af-translator agent and reviewed by the af-checker agent
// (.claude/agents/i18n/), then applied with `pnpm gen:i18n:apply`. No native
// speaker has reviewed it yet; that review is open in docs/followups.md
// § Afrikaans (WP-2.5). Corrections go straight into this file.
//
// Each entry is keyed by the message's id, the Id column of the sheet (a hash
// of the English, $lib/i18n/msg.ts), with the English in a comment above it:
//
//   // Your dam
//   '1a2b3c4d': 'Jou dam',
//   // day / days
//   '5e6f7a8b': { one: 'dag', other: 'dae' },
//
// New wording goes in with `pnpm gen:i18n:apply <id → Afrikaans .json>`
// (checked, then written here in message order), or by hand followed by
// `pnpm gen:i18n:sheet` to take it off the sheet. If the English later changes, its id changes: the
// old entry is stale (`pnpm check:i18n` and catalogue.test.ts fail) until it
// is translated again under the new id, so an outdated translation never
// shows for new English.
//
// Loaded lazily (locale.svelte.ts), only for someone who picks Afrikaans.
// Only type imports: scripts/guards/i18n_sheet.mjs loads this file directly.
import type { Catalogue } from '../locale.svelte';

export const af: Catalogue = {
	// Use at least 8 characters.
	'5aa9fe2a': 'Gebruik ten minste 8 karakters.',
	// Use at most 200 characters.
	'bb72711c': 'Gebruik hoogstens 200 karakters.',
	// The two passwords don’t match.
	'd62a92b9': 'Die twee wagwoorde stem nie ooreen nie.',
	// Right away
	'52eea1c1': 'Dadelik',
	// Once a day (06:00)
	'983ec4ee': 'Een keer ’n dag (06:00)',
	// Off
	'0dc6b4aa': 'Af',
	// Dam running low
	'25f39a9c': 'Dam raak laag',
	// River flow at risk in the forecast
	'0c0907e6': 'Riviervloei in gevaar volgens die voorspelling',
	// Data feed behind
	'b947a78d': 'Datavoer loop agter',
	// Restriction notices from the WUA
	'8cb73870': 'Beperkingskennisgewings van die WGV',
	// Failed background jobs
	'df3539b8': 'Mislukte agtergrondtake',
	// Failing data feeds
	'cf891bfc': 'Datavoere wat misluk',
	// dam level
	'17e428e3': 'die damvlak',
	// river flow forecast
	'd1fc2e28': 'die riviervloeivoorspelling',
	// missing data
	'081c1745': 'ontbrekende data',
	// restriction notice
	'ca03de5f': 'beperkingskennisgewings',
	// failed background job
	'8bc7a37b': 'mislukte agtergrondtake',
	// failing data feed
	'fb655347': 'datavoere wat misluk',
	// Dam running low: {farm}
	'21b1fd3a': 'Dam raak laag: {farm}',
	// You won’t get any alert emails for {project} any more.
	'd14653a3': 'Jy sal nie meer waarskuwings-e-posse vir {project} kry nie.',
	// You won’t get {kind} emails for {project} any more.
	'fa614c6b': 'Jy sal nie meer e-posse oor {kind} vir {project} kry nie.',
	// Your alert emails are paused. An email we sent to {email} was marked as spam, so we stopped sending.
	'554605ea': 'Jou waarskuwings-e-posse is onderbreek. ’n E-pos wat ons na {email} gestuur het, is as gemorspos gemerk, daarom het ons opgehou om te stuur.',
	// Your alert emails are paused. Our emails to {email} bounced back: the address may be wrong, or the mailbox full or closed.
	'51c58bae': 'Jou waarskuwings-e-posse is onderbreek. Ons e-posse na {email} het teruggebons: die adres is dalk verkeerd, of die posbus is vol of gesluit.',
	// Emails to this address were refused again less than a day after you turned them back on. Check the address, then try again tomorrow.
	'bf6a6804': 'E-posse na hierdie adres is minder as ’n dag nadat jy dit weer aangeskakel het, weer geweier. Kyk die adres na en probeer môre weer.',
	// On the rain forecast, your dam may fall below the alert level of {threshold}: about {pct} around {date}.
	'c184a764': 'Volgens die reënvoorspelling kan jou dam onder die waarskuwingsvlak van {threshold} daal: ongeveer {pct} rondom {date}.',
	// Your dam is below the alert level of {threshold}: about {pct} on {date}.
	'321b2d7f': 'Jou dam is onder die waarskuwingsvlak van {threshold}: ongeveer {pct} op {date}.',
	// Sent — check your inbox (and spam folder).
	'beb2912f': 'Gestuur — kyk in jou inkassie (en gemorspos).',
	// Email confirmation
	'307ccd54': 'E-posbevestiging',
	// Please confirm your email address. We sent a link to
	'1ec5e7a0': 'Bevestig asseblief jou e-posadres. Ons het ’n skakel gestuur na',
	// Sending…
	'967aa5dd': 'Stuur tans…',
	// Resend email
	'329d64e6': 'Stuur e-pos weer',
	// Dismiss
	'265915f3': 'Maak toe',
	// Hide (password field)
	'2bd339e0': 'Versteek',
	// Show (password field)
	'09ed6139': 'Wys',
	// Hide password
	'cd577cde': 'Versteek wagwoord',
	// Show password
	'500e3555': 'Wys wagwoord',
	// Compared with last season
	'3366c515': 'Vergeleke met verlede seisoen',
	// Your dam
	'184e3db0': 'Jou dam',
	// full
	'ff79b33c': 'vol',
	// Dam details
	'cc94dd23': 'Dambesonderhede',
	// Last 12 months
	'698f7893': 'Afgelope 12 maande',
	// Dam level at the end of each month
	'eaa19146': 'Damvlak aan die einde van elke maand',
	// Show the numbers
	'66acb5e9': 'Wys die syfers',
	// Month
	'a8761ba5': 'Maand',
	// Dam full
	'9309471e': 'Dam vol',
	// Alerts
	'18996e5e': 'Waarskuwings',
	// Choose your alert emails
	'ebbd21ba': 'Kies jou waarskuwings-e-posse',
	// Notes about your farm
	'9dd59c12': 'Notas oor jou plaas',
	// Your notes and the WUA’s on {farm}. Anything you add here is read by the WUA and anyone else linked to this farm.
	'6ee0c03c': 'Jou en die WGV se notas oor {farm}. Enigiets wat jy hier byvoeg, word gelees deur die WGV en enigiemand anders wat aan hierdie plaas gekoppel is.',
	// No notes about this farm yet.
	'd2af0a62': 'Nog geen notas oor hierdie plaas nie.',
	// Your figures will be kept on this phone.
	'c98e5cb5': 'Jou syfers sal op hierdie foon gehou word.',
	// Nothing is kept on this phone now.
	'6b7e2e01': 'Niks word nou op hierdie foon gehou nie.',
	// Your farms
	'ed984863': 'Jou plase',
	// My farm
	'eea9510d': 'My plaas',
	// Menu
	'00c6075a': 'Kieslys',
	// What do these words mean?
	'874e0640': 'Wat beteken hierdie woorde?',
	// Account
	'59f8a2fc': 'Rekening',
	// Privacy notice
	'016ac231': 'Privaatheidskennisgewing',
	// Don’t keep a copy on this phone
	'adfda47f': 'Moenie ’n kopie op hierdie foon hou nie',
	// Sign out
	'8b4f3c70': 'Teken uit',
	// Back to the workspace
	'9ab2f19d': 'Terug na die werkruimte',
	// Try again
	'213e90fa': 'Probeer weer',
	// Your farm
	'e9c21f82': 'Jou plaas',
	// Forecast
	'5f3a8bf0': 'Voorspelling',
	// Last 12 months, in ML
	'99e77075': 'Afgelope 12 maande, in ML',
	// Needed
	'dc508b54': 'Nodig',
	// Received
	'5cf817d2': 'Ontvang',
	// Water you needed and received each month
	'54a6fc83': 'Water wat jy elke maand nodig gehad en ontvang het',
	// Your farm on the river
	'e1a3c95e': 'Jou plaas aan die rivier',
	// Water you received this season
	'8b9ca333': 'Water wat jy hierdie seisoen ontvang het',
	// of what you needed
	'cf96dde6': 'van wat jy nodig gehad het',
	// Show volumes in
	'7ae028f6': 'Wys volumes in',
	// Show in
	'e557592b': 'Wys in',
	// Couldn’t save your choice to your account. It applies on this phone.
	'0515b26b': 'Kon nie jou keuse in jou rekening stoor nie. Dit geld op hierdie foon.',
	// Published by the WUA on {published}. Data up to {until}, {age} ago. Ask your WUA if newer figures are coming.
	'351d363e': 'Deur die WGV gepubliseer op {published}. Data tot {until}, {age} gelede. Vra jou WGV of nuwer syfers op pad is.',
	// Published by the WUA on {published}. Data up to {until}.
	'f51b7fed': 'Deur die WGV gepubliseer op {published}. Data tot {until}.',
	// Next update expected around {date}.
	'19024a1a': 'Volgende bywerking word omstreeks {date} verwag.',
	// Notice from the WUA · {level}
	'692d3ef2': 'Kennisgewing van die WGV · {level}',
	// Set by the WUA: {pct} of registered use.
	'091d4149': 'Deur die WGV bepaal: {pct} van geregistreerde gebruik.',
	// No restriction from the WUA
	'82c3a5ec': 'Geen beperking van die WGV nie',
	// drip
	'bda12fda': 'drup',
	// micro or centre pivot
	'28a56743': 'mikro of spilpunt',
	// sprinklers
	'169380a8': 'sproeiers',
	// flood
	'c2e71bdb': 'vloedbesproeiing',
	// Your farm needed very little water this season.
	'a87b6aad': 'Jou plaas het hierdie seisoen baie min water nodig gehad.',
	// You weren't short of water on any day this season.
	'6e9e3ebc': 'Jy het hierdie seisoen op geen dag te min water gehad nie.',
	// Short on {days} in {months}
	'936fdd7b': 'Te min water op {days} in {months}',
	// Short on {days}
	'0cfb399f': 'Te min water op {days}',
	// {head}, when the river was too low to take from.
	'6c55630d': '{head}, toe die rivier te laag was om uit te neem.',
	// {head}, all when the river was too low to take from.
	'a299ea88': '{head}, elke keer toe die rivier te laag was om uit te neem.',
	// {head}, when your dam was down to its stop level.
	'c6733c26': '{head}, toe jou dam tot by sy stopvlak gesak het.',
	// {head}, all when your dam was down to its stop level.
	'0bc9a7c5': '{head}, elke keer toe jou dam tot by sy stopvlak gesak het.',
	// {head}, when your dam was empty.
	'efed06e2': '{head}, toe jou dam leeg was.',
	// {head}, all when your dam was empty.
	'7673f82f': '{head}, elke keer toe jou dam leeg was.',
	// {head}, {n} of them when your dam was down to its stop level.
	'53fc0453': '{head}, {n} daarvan toe jou dam tot by sy stopvlak gesak het.',
	// {head}, {n} of them when your dam was empty.
	'aa2e5499': '{head}, {n} daarvan toe jou dam leeg was.',
	// {head}.
	'6c3f611f': '{head}.',
	// {got} of {need} since {from}
	'2937054a': '{got} van {need} sedert {from}',
	// Last 30 days: very little water needed
	'a91b9d31': 'Afgelope 30 dae: baie min water nodig',
	// Last 30 days: **{pct}** · {got} of {need}
	'4e9af1ae': 'Afgelope 30 dae: **{pct}** · {got} van {need}',
	// Worked out by the model, not read from your meter. It assumes {pct} of the water you pump reaches the crop ({system}). Wrong? Tell your WUA.
	'48170aeb': 'Deur die model bereken, nie van jou meter afgelees nie. Die model neem aan dat {pct} van die water wat jy pomp by die gewas uitkom ({system}). Verkeerd? Sê vir jou WGV.',
	// less than a day
	'e9f24832': 'minder as ’n dag',
	// about {span}
	'f95020de': 'ongeveer {span}',
	// The model assumes your pump can empty the dam. Tell your WUA the level your pump stops at.
	'b08c43fc': 'Die model neem aan dat jou pomp die dam heeltemal kan leegpomp. Sê vir jou WGV by watter vlak jou pomp stop.',
	// Your dam is down to the level where irrigation stops. There is no water above it to use until water flows in.
	'010bf2a1': 'Jou dam het tot by die vlak gesak waar besproeiing stop. Daar is geen water bo dié vlak om te gebruik voordat water weer instroom nie.',
	// Worked out by the model, not measured at your dam.
	'df26d8c9': 'Deur die model bereken, nie by jou dam gemeet nie.',
	// About the same as 30 days ago ({was})
	'314f6830': 'Omtrent dieselfde as 30 dae gelede ({was})',
	// Up {points} in 30 days (was {was})
	'100c3cb5': '{points} hoër in 30 dae (was {was})',
	// Down {points} in 30 days (was {was})
	'ef59dc0c': '{points} laer in 30 dae (was {was})',
	// At your use over the last 14 days (about {use} a day), that lasts **{lasts}** if nothing flows in. A rough guide: rain and river flow into the dam make it last longer.
	'1cc72e56': 'Teen jou gebruik oor die afgelope 14 dae (ongeveer {use} per dag) hou dit **{lasts}** as niks instroom nie. ’n Rowwe riglyn: reën en rivierwater wat in die dam instroom, laat dit langer hou.',
	// At your use over the last 14 days (about {use} a day), the water above the stop level lasts **{lasts}** if nothing flows in. A rough guide.
	'00f9df75': 'Teen jou gebruik oor die afgelope 14 dae (ongeveer {use} per dag) hou die water bo die stopvlak **{lasts}** as niks instroom nie. ’n Rowwe riglyn.',
	// irrigation stops at {pct}
	'e54e8052': 'besproeiing stop by {pct}',
	// {storage} of {capacity}
	'e25b39e5': '{storage} van {capacity}',
	// Model: OK
	'70c63e42': 'Model: goed',
	// Model: watch
	'1308106b': 'Model: hou dop',
	// Model: short
	'1b1d09f2': 'Model: tekort',
	// The model’s estimate, not an official restriction.
	'0c3464ae': 'Die model se skatting, nie ’n amptelike beperking nie.',
	// {from} to {to}
	'7385f2d1': '{from} tot {to}',
	// Looking back: {span}
	'66e7245b': 'Terugblik: {span}',
	// Why? What can I do?
	'7915a193': 'Hoekom? Wat kan ek doen?',
	// If you had pumped less on the days the river needed it, you would have had about **{pct}** of the water you needed.
	'0d0fa754': 'As jy minder gepomp het op die dae toe die rivier dit nodig gehad het, sou jy ongeveer **{pct}** gehad het van die water wat jy nodig gehad het.',
	// The river didn't need you to pump less this season. You had about **{pct}** of the water you needed.
	'd69891d7': 'Die rivier het nie hierdie seisoen nodig gehad dat jy minder pomp nie. Jy het ongeveer **{pct}** gehad van die water wat jy nodig gehad het.',
	// Why {pct}? What can I do?
	'3ea4ad58': 'Hoekom {pct}? Wat kan ek doen?',
	// The model’s look back and what you can do
	'4f85b1d2': 'Die model se terugblik en wat jy kan doen',
	// Not available: the model’s data doesn’t reach back to the same dates last season.
	'04bf0305': 'Nie beskikbaar nie: die model se data strek nie terug tot dieselfde datums verlede seisoen nie.',
	// very little needed
	'7d565e64': 'baie min nodig',
	// Water received
	'0764cc4b': 'Water ontvang',
	// Dam on {date}
	'0be5fdfe': 'Dam op {date}',
	// not available
	'd50e04d5': 'nie beskikbaar nie',
	// Your farm’s figures are seen by you, anyone else linked to this farm, and the WUA’s staff and modeller. Other farmers can’t see them, and you can’t see theirs.
	'24364e6e': 'Jou plaas se syfers word gesien deur jou, enigiemand anders wat aan hierdie plaas gekoppel is, en die WGV se personeel en modelleerder. Ander boere kan dit nie sien nie, en jy kan nie hulle s’n sien nie.',
	// No farm is
	'140855da': 'geen plaas',
	// 1 farm is
	'70cf71a0': '1 plaas',
	// {n} farms are
	'63385228': '{n} plase',
	// none is
	'a30f6eb1': 'geen plaas',
	// 1 is
	'22b49fbc': '1 plaas',
	// {n} are
	'c7fda361': '{n} plase',
	// {up} upstream of you and {down} downstream, of {count} in the catchment. The same rules apply to every farm.
	'7f35d413': 'Stroomop van jou: {up}. Stroomaf: {down}. Altesaam {count} in die opvanggebied. Dieselfde reëls geld vir elke plaas.',
	// River at {name}: kept its reserve on every one of the last {days}.
	'e3636500': 'Rivier by {name}: het op elkeen van die afgelope {days} sy reserwe behou.',
	// River at {name}: below its reserve on **all of the last {days}**.
	'384881b5': 'Rivier by {name}: onder sy reserwe op **al die afgelope {days}**.',
	// River at {name}: below its reserve on **{n} of the last {days}**.
	'0e68a86a': 'Rivier by {name}: onder sy reserwe op **{n} van die afgelope {days}**.',
	// Who can see my farm
	'1e0d6b44': 'Wie kan my plaas sien',
	// You
	'b5bdd13c': 'Jy',
	// Anyone else linked to this farm
	'a728cd62': 'Enigiemand anders wat aan hierdie plaas gekoppel is',
	// The WUA’s staff
	'452a58e5': 'Die WGV se personeel',
	// The WUA’s modeller
	'fae0a161': 'Die WGV se modelleerder',
	// Other farmers can’t see your farm’s figures, and you can’t see theirs.
	'b066abfc': 'Ander boere kan nie jou plaas se syfers sien nie, en jy kan nie hulle s’n sien nie.',
	// Loading the names…
	'e66cc2c6': 'Laai tans die name…',
	// Couldn’t load the names just now. Your WUA can tell you who these people are.
	'760d014c': 'Kon nie nou die name laai nie. Jou WGV kan vir jou sê wie hierdie mense is.',
	// linked to this farm
	'89c2c21d': 'gekoppel aan hierdie plaas',
	// WUA, can read
	'456f91da': 'WGV, kan lees',
	// WUA, can change the model
	'ca2e6460': 'WGV, kan die model verander',
	// WUA, manages who has access
	'7095cfda': 'WGV, bestuur wie toegang het',
	// WUA
	'aeedf2e8': 'WGV',
	// (you)
	'394c6255': '(jy)',
	// These figures are worked out by a computer model of the catchment. They are estimates, not measurements or instructions, and they can be wrong. Only a notice from your WUA or from the Department of Water and Sanitation (DWS) is a restriction.
	'5e0adb36': 'Hierdie syfers is deur ’n rekenaarmodel van die opvanggebied bereken. Dit is skattings, nie metings of opdragte nie, en dit kan verkeerd wees. Net ’n kennisgewing van jou WGV of van die Departement van Water en Sanitasie (DWS) is ’n beperking.',
	// very little water needed
	'ac1332f5': 'baie min water nodig',
	// {pct} of water needed
	'3a0d2f1b': '{pct} van die water wat nodig is',
	// dam {pct}
	'a648e736': 'dam {pct}',
	// no dam
	'ddebfbe0': 'geen dam',
	// Each farm’s figures are seen by the people linked to it and the WUA’s staff and modeller. Other farmers can’t see them.
	'71e0b4a4': 'Elke plaas se syfers word gesien deur die mense wat daaraan gekoppel is, en deur die WGV se personeel en modelleerder. Ander boere kan dit nie sien nie.',
	// Loading your farm…
	'c034131c': 'Laai tans jou plaas…',
	// Slow signal? This can take a moment.
	'4148b895': 'Swak sein? Dit kan ’n oomblik duur.',
	// We couldn’t load your farm
	'686ff28c': 'Ons kon nie jou plaas laai nie',
	// Check your signal and try again. Your figures are safe; nothing was changed.
	'5f465ddc': 'Kyk na jou sein en probeer weer. Jou syfers is veilig; niks is verander nie.',
	// Your WUA hasn’t published figures yet
	'f000a929': 'Jou WGV het nog nie syfers gepubliseer nie',
	// When they do, you’ll see the water you received, how your dam is doing, and any restrictions, here.
	'b8a972fb': 'Wanneer hulle dit doen, sien jy hier die water wat jy ontvang het, hoe jou dam lyk, en enige beperkings.',
	// Questions? Contact your WUA.
	'ecebdb11': 'Vrae? Kontak jou WGV.',
	// You no longer have access to this farm. Contact your WUA.
	'90bc6213': 'Jy het nie meer toegang tot hierdie plaas nie. Kontak jou WGV.',
	// Charts, “Why?” and downloads need a connection.
	'b3bbbaf7': 'Grafieke, “Hoekom?” en aflaaie het ’n verbinding nodig.',
	// Updating…
	'4f1bb013': 'Werk tans by…',
	// Still no connection. If this keeps happening, contact your WUA.
	'86547211': 'Steeds geen verbinding nie. As dit aanhou gebeur, kontak jou WGV.',
	// Still not working. If this keeps happening, contact your WUA.
	'5d76a1e6': 'Werk steeds nie. As dit aanhou gebeur, kontak jou WGV.',
	// No signal. These are the figures saved on this phone at {time}. We’ll update them when you’re back online.
	'c0d4aac6': 'Geen sein nie. Dit is die syfers wat om {time} op hierdie foon gestoor is. Ons werk dit by sodra jy weer aanlyn is.',
	// We couldn’t update your figures. These are the figures saved on this phone at {time}.
	'4829b397': 'Ons kon nie jou syfers bywerk nie. Dit is die syfers wat om {time} op hierdie foon gestoor is.',
	// You’re previewing {farm} as its farmer sees it
	'c16deffa': 'Jy sien ’n voorskou van {farm} soos die boer dit sien',
	// {n}st / {n}nd / {n}rd / {n}th
	'9d963c34': { one: '{n}', two: '{n}', few: '{n}', other: '{n}' },
	// 1–{day} {month}
	'037aec13': '1–{day} {month}',
	// {from} to {to}.
	'dadd876d': '{from} tot {to}.',
	// * {month} to the {day}.
	'c6056b3d': '* Tot {day} {month}.',
	// No monthly figures yet.
	'df723322': 'Nog geen maandsyfers nie.',
	// You were short in {months}.
	'86a76517': 'Jy het in {months} te min water gehad.',
	// You received all you needed every month.
	'6d1bd261': 'Jy het elke maand alles ontvang wat jy nodig gehad het.',
	// Water you needed and received each month, {from} to {to}. {short} The numbers are in the table below.
	'f66cc4c1': 'Water wat jy elke maand nodig gehad en ontvang het, {from} tot {to}. {short} Die syfers is in die tabel hieronder.',
	// No dam levels yet.
	'531d4239': 'Nog geen damvlakke nie.',
	// Dam level at the end of each month, {from} to {to}. Lowest {low} at the end of {lowMonth}, highest {high} at the end of {highMonth}, and {latest} on {to}. The numbers are in the table below.
	'f8cd4d40': 'Damvlak aan die einde van elke maand, {from} tot {to}. Laagste {low} aan die einde van {lowMonth}, hoogste {high} aan die einde van {highMonth}, en {latest} op {to}. Die syfers is in die tabel hieronder.',
	// no change
	'547b9d7a': 'geen verandering',
	// up {amount}
	'c0540250': '{amount} hoër',
	// down {amount}
	'7aaa0ad7': '{amount} laer',
	// not in the last 12 months
	'e61ebc6c': 'nie in die afgelope 12 maande nie',
	// Water in the dam
	'fbeb4492': 'Water in die dam',
	// Full
	'7fa5ff5c': 'Vol',
	// You can still use
	'f9fb4eaf': 'Jy kan nog gebruik',
	// Last 30 days
	'd0778b33': 'Afgelope 30 dae',
	// Same day last season
	'c273f6ec': 'Dieselfde dag verlede seisoen',
	// Last full and spilling
	'bd9ac3d7': 'Laas vol en oorgeloop',
	// {from} to {to}, end of each month.
	'9bfd8080': '{from} tot {to}, einde van elke maand.',
	// Dashed line: irrigation stops ({pct}).
	'af9974c3': 'Stippellyn: besproeiing stop ({pct}).',
	// You were short on {days} in {months}, while the dam sat at that line.
	'306af3a9': 'Jy het op {days} in {months} te min water gehad, terwyl die dam op daardie lyn gestaan het.',
	// You were short on {days} in {months}.
	'ee358f2d': 'Jy het op {days} in {months} te min water gehad.',
	// You were short on {days}, while the dam sat at that line.
	'3f835501': 'Jy het op {days} te min water gehad, terwyl die dam op daardie lyn gestaan het.',
	// You were short on {days}.
	'678f5d85': 'Jy het op {days} te min water gehad.',
	// full on {date}
	'191c8b97': 'vol op {date}',
	// “You can still use” is the water above the level where irrigation stops (your pump intake or reserve).
	'f16b1581': '“Jy kan nog gebruik” is die water bo die vlak waar besproeiing stop (jou pompinlaat of reserwe).',
	// Nobody measures your dam for this. The model works the level out every day from rain, the river flowing in, and the water your crops need.
	'096438fe': 'Niemand meet jou dam hiervoor nie. Die model bereken die vlak elke dag uit reën, die rivier wat invloei, en die water wat jou gewasse nodig het.',
	// If your gauge plate reads very differently, or your pump stops at another level, tell your WUA. It helps them correct the model.
	'294b89aa': 'As jou peilplaat heel anders lees, of jou pomp by ’n ander vlak stop, sê vir jou WGV. Dit help hulle om die model reg te stel.',
	// Forecasts change, and this is worked out by the model, not a promise. Only a notice from your WUA or from DWS is a restriction.
	'bcdaf277': 'Voorspellings verander, en dit is deur die model bereken, nie ’n belofte nie. Net ’n kennisgewing van jou WGV of van die DWS is ’n beperking.',
	// Next {days}
	'0f4c3e21': 'Volgende {days}',
	// Lowest dam level expected: about {pct} around {date}
	'45d78280': 'Laagste damvlak verwag: ongeveer {pct} rondom {date}',
	// Lowest dam level expected: about {pct}
	'eafa9db3': 'Laagste damvlak verwag: ongeveer {pct}',
	// The model doesn’t expect you to be short on any of these {days} days.
	'f0f4c8d4': 'Die model verwag nie dat jy op enige van hierdie {days} dae te min water sal hê nie.',
	// You may be short on {n} of the {days} days.
	'9d644bd9': 'Jy kan dalk op {n} van die {days} dae te min water hê.',
	// From the rain forecast of {made}, for {from} to {to}.
	'd81d6b5a': 'Volgens die reënvoorspelling van {made}, vir {from} tot {to}.',
	// This forecast is {age} old. Your WUA may publish a newer one.
	'76642b98': 'Hierdie voorspelling is {age} oud. Jou WGV kan dalk ’n nuwer een publiseer.',
	// {amount} a day
	'2111a4a0': '{amount} per dag',
	// day / days
	'fd1a1a20': { one: 'dag', other: 'dae' },
	// week / weeks
	'c2d97242': { one: 'week', other: 'weke' },
	// point / points
	'a3e2d360': { one: 'punt', other: 'punte' },
	// farm / farms
	'940baade': { one: 'plaas', other: 'plase' },
	// {time} on {date}
	'060fa091': '{time} op {date}',
	// Couldn’t load the notes. {reason}
	'ff2814ef': 'Kon nie die notas laai nie. {reason}',
	// Loading notes…
	'44437fd4': 'Laai tans notas…',
	// Notes
	'0ff01b6a': 'Notas',
	// Edit note
	'395e6e23': 'Wysig nota',
	// Save
	'4d2d5d68': 'Stoor',
	// Cancel
	'35afca3b': 'Kanselleer',
	// A former member
	'1062f5ed': '’n Voormalige lid',
	// edited
	'6df599e8': 'gewysig',
	// Edited {date}
	'68202858': 'Gewysig {date}',
	// Edit
	'c2c76cb1': 'Wysig',
	// Delete
	'5797ea6a': 'Vee uit',
	// note from {date}
	'd1097925': 'nota van {date}',
	// Delete your note? It is hidden from everyone; the WUA’s editors keep it in the record of changes.
	'1882f376': 'Vee jou nota uit? Dit word vir almal versteek; die WGV se redigeerders hou dit in die rekord van veranderinge.',
	// Delete {author}’s note? It is hidden from everyone; the WUA’s editors keep it in the record of changes.
	'fe7cbd34': 'Vee {author} se nota uit? Dit word vir almal versteek; die WGV se redigeerders hou dit in die rekord van veranderinge.',
	// Add a note
	'1ce96c5d': 'Voeg ’n nota by',
	// Plain text.
	'91c537d0': 'Gewone teks.',
	// Read by the WUA and anyone else linked to this farm.
	'6cff79ac': 'Word gelees deur die WGV en enigiemand anders wat aan hierdie plaas gekoppel is.',
	// Add note
	'b6439108': 'Voeg nota by',
	// Saving…
	'74119e7f': 'Stoor tans…',
	// Write something first.
	'81dc7120': 'Skryf eers iets.',
	// Too long: {length} of {max} characters.
	'0081fb6e': 'Te lank: {length} van {max} karakters.',
	// No restriction
	'ea44e200': 'Geen beperking',
	// Advisory
	'1597c5ce': 'Advies',
	// Restriction
	'9db32ccd': 'Beperking',
	// The WUA wrote this notice in {language} only.
	'c2ecebc9': 'Die WGV het hierdie kennisgewing net in {language} geskryf.',
	// What the model found
	'6312837d': 'Wat die model gevind het',
	// Why about {pct}?
	'd8487d8c': 'Hoekom ongeveer {pct}?',
	// Looking back over {from} to {to}, the model checks two things: was water shared fairly between farms, and did the river keep enough water flowing?
	'4c86f524': 'Die model kyk terug oor {from} tot {to} en toets twee dinge: is water regverdig tussen plase gedeel, en het die rivier genoeg water laat vloei?',
	// Not shown: with so few farms in the catchment, it could reveal a neighbour’s figures.
	'1ede5f43': 'Nie gewys nie: met so min plase in die opvanggebied kan dit ’n buurman se syfers verklap.',
	// about an even share
	'8babe8ec': 'ongeveer ’n gelyke deel',
	// a little less than an even share (about {amount})
	'8bf5fde0': '’n bietjie minder as ’n gelyke deel (ongeveer {amount})',
	// a little more than an even share (about {amount})
	'fa998f28': '’n bietjie meer as ’n gelyke deel (ongeveer {amount})',
	// It isn’t part of the model’s look back.
	'af600ca5': 'Dit is nie deel van die model se terugblik nie.',
	// It isn’t part of the {pct}.
	'53be7341': 'Dit is nie deel van die {pct} nie.',
	// Across the catchment, farms received **{share}** of what they needed. We call that the **even share**.
	'db912bbe': 'Oor die hele opvanggebied het plase **{share}** ontvang van wat hulle nodig gehad het. Ons noem dit die **gelyke deel**.',
	// even share {pct}
	'ab92f385': 'gelyke deel {pct}',
	// you {pct}
	'90f45e1f': 'jy {pct}',
	// You received **{pct}**: {comparison}.
	'a8445071': 'Jy het **{pct}** ontvang: {comparison}.',
	// **This is a fairness check, not extra water for you.** Whether more water can reach your farm depends on where you are on the river and what is in your dam. {notPart}
	'813eaac7': '**Dit is ’n regverdigheidstoets, nie ekstra water vir jou nie.** Of meer water jou plaas kan bereik, hang af van waar jy aan die rivier is en wat in jou dam is. {notPart}',
	// The law keeps some water in the river so it stays healthy for everyone downstream. This is the river’s **reserve**.
	'923c70c6': 'Die wet hou ’n deel van die water in die rivier sodat dit gesond bly vir almal stroomaf. Dit is die rivier se **reserwe**.',
	// Farms upstream are asked to make that up in proportion to the water each one used up or stored. Water that flows back to the river doesn’t count against you.
	'9c3f2d8e': 'Plase stroomop word gevra om dit op te maak in verhouding tot die water wat elkeen opgebruik of opgegaar het. Water wat terugvloei na die rivier tel nie teen jou nie.',
	// The river’s share of your water is more than an even share of the catchment’s supply. The WUA may need to look at this.
	'1adee368': 'Die rivier se deel van jou water is meer as ’n gelyke deel van die opvanggebied se watervoorraad. Die WGV sal dalk hierna moet kyk.',
	// The river kept its reserve every day this season, at every point below your farm.
	'0c5e3afe': 'Die rivier het elke dag hierdie seisoen sy reserwe behou, by elke punt onderkant jou plaas.',
	// and
	'0f29c2a6': 'en',
	// at {name} on **{days}**
	'977a32db': 'by {name} op **{days}**',
	// The river was below its reserve {sites}.
	'ae466978': 'Die rivier was {sites} onder sy reserwe.',
	// On that day, water taken upstream was part of the reason, not only low rain.
	'71e03a95': 'Op daardie dag was water wat stroomop geneem is deel van die rede, nie net min reën nie.',
	// On every one of those days, water taken upstream was part of the reason, not only low rain.
	'e86702c8': 'Op elkeen van daardie dae was water wat stroomop geneem is deel van die rede, nie net min reën nie.',
	// It was only because of low rain: water taken upstream wasn’t part of the reason.
	'7b2a3430': 'Dit was net weens min reën: water wat stroomop geneem is, was nie deel van die rede nie.',
	// {days} at {name}
	'a3792c6a': '{days} by {name}',
	// Water taken upstream was part of the reason on the other days; on {list} it was only because of low rain.
	'48966770': 'Water wat stroomop geneem is, was op die ander dae deel van die rede; op {list} was dit net weens min reën.',
	// **Pump about {amount} a day less**{ls}. Averaged over all {days} that is {average}.
	'7e1f2974': '**Pomp ongeveer {amount} per dag minder**{ls}. Gemiddeld oor al {days} is dit {average}.',
	// Your dam also held back about **{amount} a day** the river needed. If your dam has an outlet or a bypass, letting that through helps. If it doesn’t, the WUA may talk to you about it.
	'b6ff3b6b': 'Jou dam het ook ongeveer **{amount} per dag** teruggehou wat die rivier nodig gehad het. As jou dam ’n uitlaat of ’n omleiding het, help dit om daardie water deur te laat. As dit nie een het nie, sal die WGV dalk met jou daaroor praat.',
	// Your dam held back about **{amount} a day** the river needed. If your dam has an outlet or a bypass, letting that through helps. If it doesn’t, the WUA may talk to you about it.
	'76abd9c6': 'Jou dam het ongeveer **{amount} per dag** teruggehou wat die rivier nodig gehad het. As jou dam ’n uitlaat of ’n omleiding het, help dit om daardie water deur te laat. As dit nie een het nie, sal die WGV dalk met jou daaroor praat.',
	// You were asked to help on {n} of the {days}. On those days:
	'c7dfe948': 'Jy is op {n} van die {days} gevra om te help. Op daardie dae:',
	// You were asked to help on {n} of the {days}.
	'488ab009': 'Jy is op {n} van die {days} gevra om te help.',
	// You weren’t asked to help on any day this season.
	'd7b526ca': 'Jy is hierdie seisoen op geen dag gevra om te help nie.',
	// Holding back less in the dam doesn’t come off today’s pumping, so it isn’t in this sum. But it leaves less in your dam for later in the season.
	'659a5e81': 'As jy minder in die dam terughou, kom dit nie van vandag se pompwerk af nie, so dit is nie in hierdie som nie. Maar dit laat minder in jou dam vir later in die seisoen.',
	// 3. Where {pct} comes from
	'737e3ce3': '3. Waar {pct} vandaan kom',
	// Daily averages over {span}
	'c6fa2900': 'Daaglikse gemiddeldes oor {span}',
	// You received
	'e36fd697': 'Jy het ontvang',
	// Pump less for the river
	'06470532': 'Pomp minder vir die rivier',
	// Leaves
	'eb4bd3e9': 'Laat oor',
	// You needed
	'e31fe149': 'Jy het nodig gehad',
	// {leaves} is about **{pct}** of the {need} you needed.
	'78fd83cd': '{leaves} is ongeveer **{pct}** van die {need} wat jy nodig gehad het.',
	// Only a notice from your WUA or from DWS is a restriction. Right now: **no restriction**.
	'4967ee19': 'Net ’n kennisgewing van jou WGV of van die DWS is ’n beperking. Op die oomblik is daar **geen beperking** nie.',
	// Only a notice from your WUA or from DWS is a restriction. Right now: **{level}**.
	'4ddcc30a': 'Net ’n kennisgewing van jou WGV of van die DWS is ’n beperking. Op die oomblik: **{level}**.',
	// Not your allocation or licence. It doesn’t know your registered water use.
	'678ca7b2': 'Nie jou toekenning of lisensie nie. Dit ken nie jou geregistreerde watergebruik nie.',
	// Not a forecast. It looks back over {span}.
	'94fee914': 'Nie ’n voorspelling nie. Dit kyk terug oor {span}.',
	// Not measured. It comes from a model of the catchment, which can be wrong.
	'0d7ba988': 'Nie gemeet nie. Dit kom van ’n model van die opvanggebied, wat verkeerd kan wees.',
	// Who it’s for
	'00ffc54f': 'Vir wie dit is',
	// Consulting hydrologists
	'e7a496c2': 'Raadgewende hidroloë',
	// Build and calibrate a catchment model, or import your b023 workbook. Run decades of daily flows in seconds and compare what-ifs.
	'79147a4a': 'Bou en kalibreer ’n opvanggebiedmodel, of voer jou b023-werkboek in. Bereken dekades se daaglikse vloei in sekondes en vergelyk wat-as-scenario’s.',
	// Water user associations
	'f78d4851': 'Watergebruikersverenigings',
	// One shared model for the whole catchment: who is short this week, and what a restriction would do before you apply it.
	'061ece1a': 'Een gedeelde model vir die hele opvanggebied: wie hierdie week te min water het, en wat ’n beperking sou doen voordat jy dit oplê.',
	// Licence applicants and assessors
	'0414bada': 'Lisensie-aansoekers en -beoordelaars',
	// Model a new dam or more hectares against the catchment as it is, with evidence an assessor can open and reproduce.
	'424e66e1': 'Modelleer ’n nuwe dam of meer hektaar in die opvanggebied soos dit nou is, met bewyse wat ’n beoordelaar kan oopmaak en herhaal.',
	// Farmers
	'858cd593': 'Boere',
	// Your farm’s supply, your dam and any restriction, on your phone, in English or Afrikaans.
	'942f0d27': 'Die water wat jou plaas kry, jou dam en enige beperking, op jou foon, in Engels of Afrikaans.',
	// An illustrated catchment: rain over the mountains, two farm dams, an orchard and a vineyard, and a river winding down to a gauging weir.
	'eb2f0a73': '’n Tekening van ’n opvanggebied: reën oor die berge, twee plaasdamme, ’n boord en ’n wingerd, en ’n rivier wat afkronkel na ’n meetstuwal.',
	// Catchment water balance
	'2d2f00a3': 'Waterbalans van die opvanggebied',
	// Every drop in the catchment, accounted for.
	'633902ad': 'Elke druppel in die opvanggebied word verreken.',
	// Model a catchment day by day, from rainfall to river: what each farm is supplied, what its dam holds, and whether the river keeps its ecological reserve.
	'557501b3': 'Modelleer ’n opvanggebied dag vir dag, van reën tot rivier: hoeveel water elke plaas kry, wat in sy dam is, en of die rivier sy ekologiese reserwe behou.',
	// Sign in
	'744be623': 'Teken in',
	// Create an account
	'd7f6c093': 'Skep ’n rekening',
	// Reserve met on {pct} % of days
	'bc8fde2e': 'Reserwe behou op {pct} % van die dae',
	// Example catchment, {years} years
	'828ebfcc': 'Voorbeeld-opvanggebied, {years} jaar',
	// How it works
	'd03ba450': 'Hoe dit werk',
	// Build the network
	'9325094e': 'Bou die netwerk',
	// Draw the farms, dams, transfers and gauges on the river, or import your b023 workbook as it is.
	'ca672fee': 'Teken die plase, damme, oordragte en meetstasies op die rivier, of voer jou b023-werkboek in soos dit is.',
	// Add the data
	'ac61f1bd': 'Voeg die data by',
	// Upload rainfall, flow and evaporation, or let the CHIRPS and DWS feeds keep them up to date every day.
	'3db163ba': 'Laai reënval, vloei en verdamping op, of laat die CHIRPS- en DWS-datavoere dit elke dag bywerk.',
	// Run and compare
	'26609b94': 'Laat loop en vergelyk',
	// Run the model, then try a what-if and see what it changes for each farm and for the river, in plain words.
	'ec2ecc6c': 'Laat die model loop, probeer dan ’n wat-as en sien in gewone woorde wat dit vir elke plaas en vir die rivier verander.',
	// Water Management: daily water balance for a catchment
	'3dac521e': 'Water Management: daaglikse waterbalans vir ’n opvanggebied',
	// An illustrated catchment at dusk, with the words: Every drop in the catchment, accounted for.
	'2f037a30': '’n Tekening van ’n opvanggebied teen skemer, met die woorde: Elke druppel in die opvanggebied word verreken.',
	// Water Management, home
	'02a86054': 'Water Management, tuisblad',
	// See your catchment day by day.
	'ff101d6d': 'Sien jou opvanggebied dag vir dag.',
	// Footer
	'575cffd2': 'Voetskrif',
	// Terms of use
	'953dc886': 'Gebruiksvoorwaardes',
	// What you get
	'89089e78': 'Wat jy kry',
	// Screens from the app itself.
	'f48a005d': 'Skerms uit die app self.',
	// A catchment’s Summary: the ecological reserve, supply to each farm and the dams today.
	'dc9eb4cd': '’n Opvanggebied se opsommingsblad (Summary): die ekologiese reserwe, die lewering aan elke plaas en die damme vandag.',
	// A farmer’s view of their own farm on a phone: their dam, their supply and any restriction.
	'972acdeb': 'Die plaas soos die boer dit op ’n foon sien: die dam, die water wat die plaas kry en enige beperking.',
	// The farmer sees their own share on their phone, in English or Afrikaans.
	'a5ce8553': 'Die boer sien die plaas se eie deel op die foon, in Engels of Afrikaans.',
	// The network: farms, dams and gauges on the river, upstream to downstream.
	'c5f92701': 'Die netwerk: plase, damme en meetstasies op die rivier, van stroomop tot stroomaf.',
	// The network
	'991c376a': 'Die netwerk',
	// Farms, dams, transfers and gauges on the river, from the headwaters to the outlet.
	'b710dde8': 'Plase, damme, oordragte en meetstasies op die rivier, van die oorsprong tot by die uitloop.',
	// The river against its ecological reserve, day by day, with the days below it marked.
	'a67f5236': 'Die rivier teenoor sy ekologiese reserwe, dag vir dag, met die dae daaronder gemerk.',
	// River and reserve
	'18beff9c': 'Rivier en reserwe',
	// Flow at every gauge against the reserve, and which farms’ use it falls short by.
	'61c83fbb': 'Vloei by elke meetstasie teenoor die reserwe, en aan watter plase se gebruik die tekort toegeskryf word.',
	// From rainfall to river
	'2c4de2ff': 'Van reën tot rivier',
	// What the model works out for every day of the record, one step at a time. The charts are the {year} water year of an example catchment, by week.
	'6fde5c37': 'Wat die model vir elke dag van die waarnemingstydperk bereken, een stap op ’n slag. Die grafieke wys die waterjaar {year} van ’n voorbeeld-opvanggebied, per week.',
	// Rain on the mountains
	'791b781b': 'Reën op die berge',
	// Daily rainfall from the catchment’s own gauges, with CHIRPS satellite estimates to fill the gaps and check them.
	'a90570df': 'Daaglikse reënval van die opvanggebied se eie reënmeters, met CHIRPS-satellietskattings om die gapings te vul en die metings na te gaan.',
	// mm a week
	'8e5c53d0': 'mm per week',
	// Rainfall
	'58b1f77a': 'Reënval',
	// {total} mm over the year; the wettest week {peak} mm.
	'0bdc1bdc': '{total} mm oor die jaar; die natste week {peak} mm.',
	// Runoff from the slopes
	'9fb53226': 'Afloop van die hange',
	// A rainfall–runoff model (GR4J or Pitman), calibrated against the weir’s record, turns rain into the streams’ flow.
	'8b60aa1f': '’n Reënval-afloopmodel (GR4J of Pitman), gekalibreer teen die meetstuwal se rekord, verander reën in die strome se vloei.',
	// Natural runoff
	'b108b500': 'Natuurlike afloop',
	// Highest in winter: {peak} m³/s in the wettest week.
	'cc6879f0': 'Die hoogste in die winter: {peak} m³/s in die natste week.',
	// Dams fill and draw down
	'41ee0ca8': 'Damme vul en sak',
	// Each farm dam catches its share of the flow, loses some to evaporation and seepage, and spills when it is full.
	'e113d616': 'Elke plaasdam vang sy deel van die vloei op, verloor ’n deel daarvan aan verdamping en syfering, en loop oor wanneer hy vol is.',
	// % full
	'1032f885': '% vol',
	// {dam} dam
	'5df21495': '{dam}-dam',
	// Full through winter, down to {low} % by the end of summer.
	'fcd5d4a5': 'Vol deur die winter, teen die einde van die somer af tot {low} %.',
	// Farms take their share
	'69b3583e': 'Plase kry hul deel',
	// Crops need water by the month. The model supplies what the dam and the river can give, and counts the days a farm runs short.
	'66ee8a7a': 'Gewasse het elke maand water nodig. Die model lewer wat die dam en die rivier kan gee, en tel die dae waarop ’n plaas te min water het.',
	// m³ a day
	'd7857240': 'm³ per dag',
	// Supplied to {farm}
	'30e67df4': 'Gelewer aan {farm}',
	// {share} % of what it needed over the year; short in {weeks} weeks (shaded).
	'9fabf9f8': '{share} % van wat dit oor die jaar nodig gehad het; te min in {weeks} weke (ingekleur).',
	// The river below
	'6aa266af': 'Die rivier stroomaf',
	// What is left reaches the outlet. Every day, the model checks it against the ecological reserve the river needs.
	'643c2d08': 'Wat oorbly, bereik die uitloop. Elke dag toets die model dit teen die ekologiese reserwe wat die rivier nodig het.',
	// m³/s, on a square-root scale
	'f161fe05': 'm³/s, op ’n vierkantswortelskaal',
	// Flow at the outlet
	'916671c6': 'Vloei by die uitloop',
	// Reserve
	'57d1f6eb': 'Reserwe',
	// Below the reserve in {weeks} of 52 weeks (shaded), mostly in summer.
	'310b8b7c': 'Onder die reserwe in {weeks} van 52 weke (ingekleur), meestal in die somer.',
	// years of daily water balance
	'f8c0f358': 'jaar se daaglikse waterbalans',
	// days in one run
	'e4291d84': 'dae in een lopie',
	// fit to the weir’s measured flow (NSE, where 1 is perfect)
	'32f438d7': 'ooreenstemming met die meetstuwal se gemete vloei (NSE, waar 1 perfek is)',
	// Why trust it
	'458b8568': 'Hoekom jy dit kan vertrou',
	// The engine is judged against documented hydrology, not against a spreadsheet, and every place it departs from the workbook is written down.
	'eb8912c3': 'Die rekenenjin word aan gedokumenteerde hidrologie gemeet, nie aan ’n sigblad nie, en elke plek waar dit van die werkboek afwyk, is neergeskryf.',
	// Every run can be reproduced, and every change has an audit trail.
	'b8b917a9': 'Elke lopie kan herhaal word, en elke verandering het ’n ouditspoor.',
	// Each project is private to its members, enforced by the database itself (row-level security).
	'49027b5c': 'Elke projek is privaat vir sy lede, afgedwing deur die databasis self (row-level security).',
	// Daily data from CHIRPS rainfall and the DWS gauges.
	'746a0c9c': 'Daaglikse data van CHIRPS-reënval en die DWS-meetstasies.',
	// In the example catchment
	'fb86138c': 'In die voorbeeld-opvanggebied',
	// This is the farm as it is today. Move a slider to change it.
	'8b81fde5': 'Dit is die plaas soos dit vandag is. Beweeg ’n skuifbalk om dit te verander.',
	// It costs the river {days} more days a year below the reserve
	'b7fe266e': 'Dit kos die rivier {days} meer dae per jaar onder die reserwe',
	// It gives the river {days} fewer days a year below the reserve
	'2ad50462': 'Die rivier is {days} minder dae per jaar onder die reserwe',
	// The river is below the reserve about as often as today
	'7f951aa0': 'Die rivier is omtrent net so dikwels soos vandag onder die reserwe',
	// and the farm gets about as much of what it needs.
	'140e03db': 'en die plaas kry omtrent net soveel van wat dit nodig het.',
	// and the farm gets {points} points more of what it needs.
	'30a8c782': 'en die plaas kry {points} punte meer van wat dit nodig het.',
	// and the farm gets {points} points less of what it needs.
	'5f29d43a': 'en die plaas kry {points} punte minder van wat dit nodig het.',
	// Try a what-if
	'c3eedfbb': 'Probeer ’n wat-as',
	// {farm}, a farm in the example catchment, grows {ha} ha of apples. It wants to plant more, and could build a bigger dam. What would that do to the farm, and to the river?
	'b258bd4a': '{farm}, ’n plaas in die voorbeeld-opvanggebied, verbou {ha} ha appels. Die plaas wil meer aanplant, en kan ’n groter dam bou. Wat sou dit aan die plaas doen, en aan die rivier?',
	// Worked out in advance from {runs} runs of the model.
	'090688fd': 'Vooraf bereken uit {runs} lopies van die model.',
	// More apples
	'36b73a49': 'Meer appels',
	// +{ha} ha
	'0e94a772': '+{ha} ha',
	// {ha} more hectares
	'68a991f8': '{ha} hektaar meer',
	// Dam size
	'6b8a7e32': 'Damgrootte',
	// {times} times today’s dam
	'64eb41e6': '{times} keer so groot as vandag se dam',
	// Irrigation supplied
	'37645529': 'Besproeiingswater gelewer',
	// {pct} % of what the farm needs
	'b57d6692': '{pct} % van wat die plaas nodig het',
	// Today
	'e7c0775e': 'Vandag',
	// This plan
	'ec26a6ec': 'Hierdie plan',
	// River below the reserve
	'c8adc657': 'Rivier onder die reserwe',
	// {days} days a year
	'aa84b70d': '{days} dae per jaar',
	// Change from today: supply {supply} points, river {days} days a year.
	'a3a08f59': 'Verandering teenoor vandag: lewering {supply} punte, rivier {days} dae per jaar.',
	// Legal
	'de7530aa': 'Regsinligting',
	// About Water Management
	'a156f424': 'Oor Water Management',
	// Catchment water balance, from rainfall to river.
	'7b2abdbd': 'Waterbalans van die opvanggebied, van reën tot rivier.',
	// Model farms, dams and transfers on a river network.
	'd8aeaac5': 'Modelleer plase, damme en oordragte op ’n riviernetwerk.',
	// Run decades of daily flows in seconds.
	'd0e44714': 'Bereken dekades se daaglikse vloei in sekondes.',
	// Check the environmental flow requirement (EWR) against every farm’s use.
	'65909895': 'Vergelyk die omgewingsvloeivereiste (EWR) met elke plaas se gebruik.',
	// River flow each month, in m³ a day
	'a0ddf26e': 'Riviervloei elke maand, in m³ per dag',
	// Ecological reserve
	'16bf7d51': 'Ekologiese reserwe',
	// Mean flow at the outlet and the ecological reserve each month, in m³ a day
	'4702e852': 'Gemiddelde vloei by die uitloop en die ekologiese reserwe elke maand, in m³ per dag',
	// Flow
	'3df462b5': 'Vloei',
	// No flows to show.
	'be1887a5': 'Geen vloei om te wys nie.',
	// The mean flow was above the reserve in every month.
	'bb92196c': 'Die gemiddelde vloei was elke maand bo die reserwe.',
	// The mean flow was below the reserve in every month.
	'd9bcae10': 'Die gemiddelde vloei was elke maand onder die reserwe.',
	// The mean flow was below the reserve in {n} of the {months} months.
	'0a3709bf': 'Die gemiddelde vloei was in {n} van die {months} maande onder die reserwe.',
	// River flow at the catchment outlet each month against its ecological reserve, {from} to {to}. {verdict} The numbers are in the table below.
	'8ca58fb8': 'Riviervloei by die opvanggebied se uitloop elke maand teenoor sy ekologiese reserwe, {from} tot {to}. {verdict} Die syfers is in die tabel hieronder.',
	// {from} to {to}. Monthly means of the modelled daily flow.
	'ac863279': '{from} tot {to}. Maandgemiddeldes van die daaglikse vloei, deur die model bereken.',
	// Published by {name} on {date}. Data up to {until}.
	'0a953858': 'Op {date} deur {name} gepubliseer. Data tot {until}.',
	// a former member
	'51eae74d': '’n voormalige lid',
	// At the catchment outlet
	'82aa7d85': 'By die opvanggebied se uitloop',
	// At {place}
	'60d1632f': 'By {place}',
	// Kept its reserve on every one of the last {days}.
	'03ac8a80': 'Het sy reserwe op elkeen van die afgelope {days} behou.',
	// Below its reserve on all of the last {days}.
	'ac4d93a5': 'Onder sy reserwe op al die afgelope {days}.',
	// Below its reserve on {n} of the last {days}.
	'cd1a360e': 'Onder sy reserwe op {n} van die afgelope {days}.',
	// {n} of {days} below it this season (since {date}).
	'a8344db9': '{n} van {days} hierdie seisoen daaronder (sedert {date}).',
	// {farms} in the catchment.
	'aecf2c05': '{farms} in die opvanggebied.',
	// Language
	'9a73db9b': 'Taal',
	// Couldn’t save your choice to your account. It applies on this device.
	'9883f14f': 'Kon nie jou keuse in jou rekening stoor nie. Dit geld op hierdie toestel.',
	// You’re not signed in. Sign in and try again.
	'bcf9b210': 'Jy is nie ingeteken nie. Teken in en probeer weer.',
	// An account with that email address already exists. Sign in, or reset your password.
	'18840a52': 'Daar is reeds ’n rekening met daardie e-posadres. Teken in, of stel jou wagwoord terug.',
	// Wrong email or password.
	'753da152': 'Verkeerde e-pos of wagwoord.',
	// Confirm your email address before you sign in: open the link we emailed you.
	'0f7f36bd': 'Bevestig jou e-posadres voordat jy inteken: maak die skakel oop wat ons vir jou ge-e-pos het.',
	// Too many sign-in attempts for this address. Try again in {wait}, or reset your password.
	'7f8f9853': 'Te veel pogings om met hierdie adres in te teken. Probeer weer oor {wait}, of stel jou wagwoord terug.',
	// Too many accounts were made from your network. Try again in {wait}.
	'f8d1f4b2': 'Te veel rekeninge is van jou netwerk af geskep. Probeer weer oor {wait}.',
	// The Terms of use or Privacy notice changed since this page opened. Reload the page, read them, and sign up again.
	'c3395d0e': 'Die Gebruiksvoorwaardes of die Privaatheidskennisgewing het verander sedert jy hierdie bladsy oopgemaak het. Herlaai die bladsy, lees hulle en registreer weer.',
	// Your current password is wrong.
	'ee4b7db1': 'Jou huidige wagwoord is verkeerd.',
	// Your password was changed somewhere else a moment ago. Sign in again.
	'c5d6716a': 'Jou wagwoord is ’n oomblik gelede elders verander. Teken weer in.',
	// This link is invalid or has expired. Ask for a new one.
	'17b132df': 'Hierdie skakel is ongeldig of het verval. Vra vir ’n nuwe een.',
	// Your email address is already confirmed.
	'fccf74a7': 'Jou e-posadres is reeds bevestig.',
	// A confirmation email was sent a moment ago. Check your inbox, or try again in a minute.
	'1f0dc36b': '’n Bevestigings-e-pos is ’n oomblik gelede gestuur. Kyk in jou inkassie, of probeer oor ’n minuut weer.',
	// Too many confirmation emails were sent to this address today. Check your inbox, or try again tomorrow.
	'e35608b7': 'Te veel bevestigings-e-posse is vandag na hierdie adres gestuur. Kyk in jou inkassie, of probeer môre weer.',
	// This invitation is invalid or has expired.
	'a2aa61f9': 'Hierdie uitnodiging is ongeldig of het verval.',
	// You can add notes only to your own farm.
	'84fea91c': 'Jy kan net notas by jou eie plaas voeg.',
	// Only a note on a farm can be shown to its farmers.
	'09cd5bcf': 'Net ’n nota op ’n plaas kan aan sy boere gewys word.',
	// Only the person who wrote a note can change it.
	'7d1f4730': 'Net die persoon wat ’n nota geskryf het, kan dit verander.',
	// Only the person who wrote a note, or the WUA, can delete it.
	'b1f091c0': 'Net die persoon wat ’n nota geskryf het, of die WGV, kan dit uitvee.',
	// This link doesn’t work any more.
	'8db26af3': 'Hierdie skakel werk nie meer nie.',
	// You downloaded your data a moment ago. Try again in {wait}.
	'9c2638b9': 'Jy het jou data ’n oomblik gelede afgelaai. Probeer weer oor {wait}.',
	// You turned alert emails back on less than a day ago, and your email address was refused again. Check the address, then try again tomorrow.
	'e5a8dee0': 'Jy het waarskuwings-e-posse minder as ’n dag gelede weer aangeskakel, en jou e-posadres is weer geweier. Kyk die adres na en probeer môre weer.',
	// Something in what you sent can’t be saved (a hidden control character, or a number far too large). Check what you entered and try again.
	'f3414d07': 'Iets in wat jy gestuur het, kan nie gestoor word nie (’n verborge beheerkarakter, of ’n getal wat heeltemal te groot is). Kyk na wat jy ingevul het en probeer weer.',
	// This run wasn’t stored by the model run itself, so it can’t be signed off or decided on. Delete it and run it again.
	'04f58c9d': 'Hierdie lopie is nie deur die modellopie self gestoor nie, so dit kan nie afgeteken word nie, en geen besluit kan daaroor geneem word nie. Vee dit uit en laat dit weer loop.',
	// {n} minute / {n} minutes
	'a60f17d2': { one: '{n} minuut', other: '{n} minute' },
	// Couldn’t reach the server. Check your connection and try again.
	'058318a7': 'Kon nie die bediener bereik nie. Kyk jou verbinding na en probeer weer.',
	// Something went wrong on our side. Try again in a moment.
	'9da83d63': 'Iets het aan ons kant verkeerd geloop. Probeer oor ’n oomblik weer.',
	// That wasn’t accepted. Check what you entered and try again.
	'7343f1e9': 'Dit is nie aanvaar nie. Kyk na wat jy ingevul het en probeer weer.',
	// You don’t have access to that.
	'a7684194': 'Jy het nie toegang daartoe nie.',
	// That isn’t there any more.
	'f0aa79de': 'Dit is nie meer daar nie.',
	// That clashes with a change made a moment ago. Reload the page and try again.
	'b1fbe570': 'Dit bots met ’n verandering wat ’n oomblik gelede gemaak is. Herlaai die bladsy en probeer weer.',
	// That is too large to send.
	'806c91e6': 'Dit is te groot om te stuur.',
	// Too many tries. Wait a minute and try again.
	'45db8d33': 'Te veel pogings. Wag ’n minuut en probeer weer.',
	// Something went wrong. Try again.
	'9df7013d': 'Iets het verkeerd geloop. Probeer weer.',
	// The reminder to confirm your email address could not be loaded. Check your connection, then reload the page.
	'25601c1d': 'Die herinnering om jou e-posadres te bevestig kon nie gelaai word nie. Kyk jou verbinding na en herlaai dan die bladsy.',
	// Reload page
	'4abb303f': 'Herlaai bladsy',
	// Enter a display name.
	'a7f2031b': 'Tik ’n vertoonnaam in.',
	// Use at most 100 characters.
	'c5951029': 'Gebruik hoogstens 100 karakters.',
	// Enter your current password.
	'f555922c': 'Tik jou huidige wagwoord in.',
	// {page} · Water Management
	'96d7c65d': '{page} · Water Management',
	// Email
	'43352167': 'E-pos',
	// Status
	'005ef20f': 'Status',
	// Confirmed
	'382d99ae': 'Bevestig',
	// Not confirmed
	'6cef8c0f': 'Nie bevestig nie',
	// Use the link we emailed you. The banner above can send it again.
	'5c3e0092': 'Gebruik die skakel wat ons vir jou ge-e-pos het. Die strook hierbo kan dit weer stuur.',
	// Profile
	'cd17328e': 'Profiel',
	// Display name
	'4e167b8c': 'Vertoonnaam',
	// Save name
	'7692acbb': 'Stoor naam',
	// Shown to people you share projects and teams with.
	'5eaf8d89': 'Word gewys aan mense met wie jy projekte en spanne deel.',
	// Name saved.
	'6c898a5d': 'Naam gestoor.',
	// Password
	'2cc30838': 'Wagwoord',
	// Changing your password signs you out on every other device. This browser stays signed in.
	'a7a7cd70': 'As jy jou wagwoord verander, word jy op elke ander toestel uitgeteken. Hierdie blaaier bly ingeteken.',
	// Current password
	'8eedf1f3': 'Huidige wagwoord',
	// New password
	'6a3aaab2': 'Nuwe wagwoord',
	// At least 8 characters.
	'28fdf9ef': 'Ten minste 8 karakters.',
	// Repeat new password
	'b8f627b1': 'Herhaal nuwe wagwoord',
	// Changing…
	'e0345c10': 'Verander tans…',
	// Change password
	'87f6bf6e': 'Verander wagwoord',
	// Password changed. Every other device has been signed out.
	'12bb2549': 'Wagwoord verander. Elke ander toestel is uitgeteken.',
	// Language and units
	'65eef061': 'Taal en eenhede',
	// Your farm pages, the sign-in pages and the emails we send you use this language.
	'a2fc07cd': 'Jou plaasbladsye, die intekenbladsye en die e-posse wat ons vir jou stuur, gebruik hierdie taal.',
	// Volumes on your farm pages
	'93a111b0': 'Volumes op jou plaasbladsye',
	// Cubic metres (m³)
	'66535c7a': 'Kubieke meter (m³)',
	// Megalitres (ML)
	'7b231e72': 'Megaliter (ML)',
	// Saved.
	'ae0ab8fe': 'Gestoor.',
	// Alert emails
	'ef1f00de': 'Waarskuwings-e-posse',
	// Once {email} can receive email again, turn alert emails back on. Your choices are kept.
	'3a253624': 'Sodra {email} weer e-pos kan ontvang, skakel waarskuwings-e-posse weer aan. Jou keuses word behou.',
	// Turning them back on…
	'8a32f572': 'Skakel hulle tans weer aan…',
	// Turn alert emails back on
	'41c28629': 'Skakel waarskuwings-e-posse weer aan',
	// Alert emails are back on.
	'd01ae81a': 'Waarskuwings-e-posse is weer aan.',
	// Choose which alerts you get by email, and how often.
	'8c942903': 'Kies watter waarskuwings jy per e-pos kry, en hoe gereeld.',
	// Your data
	'0819f3fe': 'Jou data',
	// Download a copy of what we keep about you: your account, the projects and farms you’re linked to, your farms’ figures and registered volumes, notes you wrote, and the history of what you did and what was done about you. It’s a JSON file.
	'745aefa7': 'Laai ’n kopie af van wat ons oor jou hou: jou rekening, die projekte en plase waaraan jy gekoppel is, jou plase se syfers en geregistreerde volumes, notas wat jy geskryf het, en die geskiedenis van wat jy gedoen het en wat oor jou gedoen is. Dit is ’n JSON-lêer.',
	// The download could not be loaded. Check your connection, then reload the page.
	'c4c6488f': 'Die aflaai kon nie gelaai word nie. Kyk jou verbinding na en herlaai dan die bladsy.',
	// Preparing…
	'bf0c7feb': 'Berei tans voor…',
	// Download my data
	'7247e23b': 'Laai my data af',
	// Your data has been downloaded.
	'a51c54d9': 'Jou data is afgelaai.',
	// Choose which alerts you get by email for each catchment, and how often. Alerts come from the catchment model: estimates, not instructions.
	'2ba7c149': 'Kies watter waarskuwings jy per e-pos kry vir elke opvanggebied, en hoe gereeld. Waarskuwings kom van die opvanggebied se model: skattings, nie opdragte nie.',
	// Back to your account
	'eb3bc0dd': 'Terug na jou rekening',
	// At most {cap} alert emails a day come right away. Any more wait for the next morning’s summary (06:00).
	'6e6c53b1': 'Hoogstens {cap} waarskuwings-e-posse per dag kom dadelik. Die res wag vir die volgende oggend se opsomming (06:00).',
	// None of your catchments can send you alerts yet.
	'8349b21d': 'Nie een van jou opvanggebiede kan nog vir jou waarskuwings stuur nie.',
	// All alert emails for this catchment are off.
	'b99a108a': 'Alle waarskuwings-e-posse vir hierdie opvanggebied is af.',
	// Not switched on for this catchment yet: you get nothing until the WUA turns it on.
	'2e3ec238': 'Nog nie vir hierdie opvanggebied aangeskakel nie: jy kry niks totdat die WGV dit aanskakel nie.',
	// Stop alert emails
	'ac585d38': 'Stop waarskuwings-e-posse',
	// Stop getting these alert emails? You can turn them back on from your account at any time.
	'72528562': 'Wil jy ophou om hierdie waarskuwings-e-posse te kry? Jy kan dit enige tyd weer vanaf jou rekening aanskakel.',
	// One moment…
	'cf936b69': 'Net ’n oomblik…',
	// Stop these emails
	'c156b4db': 'Stop hierdie e-posse',
	// Manage alerts
	'5ac110b9': 'Bestuur waarskuwings',
	// This link doesn’t work any more: a newer email may have replaced it, or you may no longer be a member of the catchment.
	'd526c5e1': 'Hierdie skakel werk nie meer nie: ’n nuwer e-pos het dit dalk vervang, of jy is dalk nie meer ’n lid van die opvanggebied nie.',
	// This link is incomplete. Open it again from the email, or copy the whole link.
	'aa5e9817': 'Hierdie skakel is onvolledig. Maak dit weer vanuit die e-pos oop, of kopieer die hele skakel.',
	// {page} · My farm
	'299fd967': '{page} · My plaas',
	// My farms
	'328b495a': 'My plase',
	// No farm is linked to your account yet. Your WUA links your farm to your account.
	'1d79071b': 'Nog geen plaas is aan jou rekening gekoppel nie. Jou WGV koppel jou plaas aan jou rekening.',
	// Your projects
	'1ec4a724': 'Jou projekte',
	// Not published yet
	'b17ad0ae': 'Nog nie gepubliseer nie',
	// Your farms in this catchment
	'899c33fd': 'Jou plase in hierdie opvanggebied',
	// WUA notice · {level}
	'5849b249': 'WGV-kennisgewing · {level}',
	// At a glance
	'2b760ced': 'In ’n oogopslag',
	// of the water you needed this season
	'3e1ec91d': 'van die water wat jy hierdie seisoen nodig gehad het',
	// dam full
	'07095e7e': 'dam vol',
	// More
	'4f34d900': 'Meer',
	// Download my figures (CSV)
	'defc0d3b': 'Laai my syfers af (CSV)',
	// {farm} has no dam in the model.
	'189ba2c7': '{farm} het geen dam in die model nie.',
	// Back to my farm
	'b0f24bf9': 'Terug na my plaas',
	// How full it is
	'29b90af1': 'Hoe vol dit is',
	// Where these figures come from
	'78baf9da': 'Waar hierdie syfers vandaan kom',
	// What is “modelled”?
	'b7c8226b': 'Wat beteken “deur die model bereken”?',
	// Why?
	'50d99212': 'Hoekom?',
	// 1. Was water shared fairly?
	'2064df9f': '1. Is water regverdig gedeel?',
	// 2. Did the river keep flowing?
	'0701a4df': '2. Het die rivier aanhou vloei?',
	// What the WUA decided
	'9ca5252f': 'Wat die WGV besluit het',
	// Read the notice
	'6aca3fee': 'Lees die kennisgewing',
	// What this is not
	'b3e48362': 'Wat dit nie is nie',
	// What is the river’s reserve?
	'a0ea4b15': 'Wat is die rivier se reserwe?',
	// Reset your password
	'42f0a3dc': 'Stel jou wagwoord terug',
	// Check your email
	'26eb828a': 'Kyk in jou e-pos',
	// Enter the email address you signed up with and we’ll send you a link to choose a new password.
	'7d035662': 'Tik die e-posadres in waarmee jy geregistreer het, en ons stuur vir jou ’n skakel om ’n nuwe wagwoord te kies.',
	// If there is an account for **{email}**, we’ve emailed it a link to choose a new password.
	'2715f554': 'As daar ’n rekening vir **{email}** is, het ons ’n skakel daarheen gestuur om ’n nuwe wagwoord te kies.',
	// The link works once and expires in 1 hour. Check your spam folder if it doesn’t arrive in a few minutes.
	'e89fdeca': 'Die skakel werk een keer en verval oor 1 uur. Kyk in jou gemorspos as dit nie binne ’n paar minute aankom nie.',
	// Use a different address
	'9cc79b0e': 'Gebruik ’n ander adres',
	// Send reset link
	'e10f2988': 'Stuur terugstelskakel',
	// Remembered it?
	'3bf754b9': 'Onthou jy dit?',
	// If {email} still needs confirming, a new link is on its way. Check your inbox and spam folder.
	'9a0aaea5': 'As {email} nog bevestig moet word, is ’n nuwe skakel op pad. Kyk in jou inkassie en gemorspos.',
	// Welcome back. Sign in to your catchment projects.
	'0650eb3f': 'Welkom terug. Teken in by jou opvanggebiedprojekte.',
	// Check your email to finish signing up
	'6460f76e': 'Kyk in jou e-pos om klaar te registreer',
	// We sent a confirmation link to **{email}**. Open it to confirm your address, then sign in here.
	'02962730': 'Ons het ’n bevestigingskakel na **{email}** gestuur. Maak dit oop om jou adres te bevestig, en teken dan hier in.',
	// We sent you a confirmation link. Open it to confirm your address, then sign in here.
	'd1cccf96': 'Ons het vir jou ’n bevestigingskakel gestuur. Maak dit oop om jou adres te bevestig, en teken dan hier in.',
	// You can’t sign in until your address is confirmed. The link lasts 48 hours.
	'1c157712': 'Jy kan nie inteken voordat jou adres bevestig is nie. Die skakel bly 48 uur geldig.',
	// Send the link again
	'1ed87a58': 'Stuur die skakel weer',
	// **Your email address isn’t confirmed yet.** Open the link we emailed to {email}, then sign in again.
	'5b10b774': '**Jou e-posadres is nog nie bevestig nie.** Maak die skakel oop wat ons na {email} ge-e-pos het, en teken dan weer in.',
	// Forgot password?
	'e2619568': 'Wagwoord vergeet?',
	// Signing in…
	'1a982eaf': 'Teken tans in…',
	// No account?
	'07494a6a': 'Geen rekening nie?',
	// Create one
	'67674c65': 'Skep een',
	// Sent. Check your inbox (and spam folder) for the confirmation link.
	'3aff6ef6': 'Gestuur. Kyk in jou inkassie (en gemorspos) vir die bevestigingskakel.',
	// Your address is already confirmed.
	'fe63a2c7': 'Jou adres is reeds bevestig.',
	// the project {name}
	'4b568eda': 'die projek {name}',
	// the team {name}
	'bbe4f51e': 'die span {name}',
	// By creating an account, you agree to the {terms} and {privacy}.
	'db2110ec': 'Deur ’n rekening te skep, aanvaar jy die {terms} en die {privacy}.',
	// Password must be 8–200 characters.
	'fe087f11': 'Wagwoord moet 8–200 karakters lank wees.',
	// The two passwords don’t match. Type the same password in both.
	'8289fa95': 'Die twee wagwoorde stem nie ooreen nie. Tik dieselfde wagwoord in albei velde in.',
	// Create account (page title)
	'c91c4fa3': 'Skep rekening',
	// You’re already signed in
	'3fe0bfdd': 'Jy is reeds ingeteken',
	// Signed in as **{email}**.
	'4084a860': 'Ingeteken as **{email}**.',
	// Checking the invitation…
	'606b0a25': 'Kontroleer tans die uitnodiging…',
	// **{inviter}** invited this address to **{target}**.
	'15014a63': '**{inviter}** het hierdie adres na **{target}** uitgenooi.',
	// Your address is confirmed, so you should have access already. If {target} isn’t in your projects, ask {inviter} to add you again.
	'183e62a9': 'Jou adres is bevestig, so jy behoort reeds toegang te hê. As {target} nie by jou projekte is nie, vra {inviter} om jou weer by te voeg.',
	// You’ll join as soon as you confirm your email address: use the link we sent to {email}.
	'adf70fb7': 'Jy sluit aan sodra jy jou e-posadres bevestig: gebruik die skakel wat ons na {email} gestuur het.',
	// Resend confirmation email
	'8417462b': 'Stuur bevestigings-e-pos weer',
	// Go to your projects
	'd3b436ab': 'Gaan na jou projekte',
	// This invitation to **{target}** is for **{email}**, not the account you’re signed in with.
	'a33d5294': 'Hierdie uitnodiging na **{target}** is vir **{email}**, nie vir die rekening waarmee jy ingeteken is nie.',
	// To accept it, sign out and create an account for {email}. To use this account instead, ask {inviter} to invite {me}.
	'd7e05349': 'Om dit te aanvaar, teken uit en skep ’n rekening vir {email}. Om eerder hierdie rekening te gebruik, vra {inviter} om {me} uit te nooi.',
	// Signing out…
	'53ed2592': 'Teken tans uit…',
	// Sign out and accept as {email}
	'f5eed39b': 'Teken uit en aanvaar as {email}',
	// Stay signed in and go to your projects
	'7882be4a': 'Bly ingeteken en gaan na jou projekte',
	// We couldn’t check this invitation right now. Try the link again later.
	'd0bf5972': 'Ons kon nie hierdie uitnodiging nou kontroleer nie. Probeer die skakel later weer.',
	// This invitation link is invalid, was revoked, or has expired (they last 7 days). Ask whoever invited you to send a new one.
	'1f58c58c': 'Hierdie uitnodigingskakel is ongeldig, is teruggetrek of het verval (hulle is 7 dae geldig). Vra die persoon wat jou uitgenooi het om ’n nuwe een te stuur.',
	// Not you?
	'03c04bca': 'Nie jy nie?',
	// Accept your invitation
	'4252753f': 'Aanvaar jou uitnodiging',
	// Model your own catchments, or join a team’s.
	'23534e88': 'Modelleer jou eie opvanggebiede, of sluit by ’n span s’n aan.',
	// Checking your invitation…
	'6422c1b3': 'Kontroleer tans jou uitnodiging…',
	// **{inviter}** invited you to **{target}**.
	'dae1dc58': '**{inviter}** het jou na **{target}** uitgenooi.',
	// Create your account to join. You’ll have access straight away.
	'4747998e': 'Skep jou rekening om aan te sluit. Jy kry dadelik toegang.',
	// This invitation link has expired or was withdrawn. You can still create an account, then ask to be invited again.
	'd52caaa3': 'Hierdie uitnodigingskakel het verval of is teruggetrek. Jy kan steeds ’n rekening skep en dan vra om weer uitgenooi te word.',
	// We couldn’t check your invitation right now. You can still create an account; you’ll join once your email address is confirmed.
	'bb9d18b6': 'Ons kon nie jou uitnodiging nou kontroleer nie. Jy kan steeds ’n rekening skep; jy sluit aan sodra jou e-posadres bevestig is.',
	// The invitation was sent to this address. To use another, ask {inviter} to invite that one instead.
	'ece15e61': 'Die uitnodiging is na hierdie adres gestuur. Om ’n ander een te gebruik, vra {inviter} om eerder daardie adres uit te nooi.',
	// We’ll email you a link to confirm your address. You can sign in once it’s confirmed.
	'2af00cee': 'Ons stuur vir jou ’n skakel per e-pos om jou adres te bevestig. Jy kan inteken sodra dit bevestig is.',
	// At least 8 characters. A short passphrase works well.
	'73c4cd8e': 'Ten minste 8 karakters. ’n Kort wagfrase werk goed.',
	// Confirm password
	'5ad9dc20': 'Bevestig wagwoord',
	// Creating…
	'1aa1a030': 'Skep tans…',
	// Create account and join
	'eda60971': 'Skep rekening en sluit aan',
	// Create account
	'50dc6622': 'Skep rekening',
	// Already registered?
	'0fa8342a': 'Reeds geregistreer?',
	// Choose a new password
	'042e1946': 'Kies ’n nuwe wagwoord',
	// Pick a password you don’t use anywhere else.
	'87daf9cc': 'Kies ’n wagwoord wat jy nêrens anders gebruik nie.',
	// Your password has been changed and you’ve been signed out everywhere. Sign in with your new password.
	'ff89913b': 'Jou wagwoord is verander en jy is oral uitgeteken. Teken in met jou nuwe wagwoord.',
	// This reset link is invalid, already used, or older than 1 hour.
	'67cb9269': 'Hierdie terugstelskakel is ongeldig, reeds gebruik of ouer as 1 uur.',
	// Send a new link
	'02ef5686': 'Stuur ’n nuwe skakel',
	// You’re signed in as **{email}**. Setting a new password signs this browser out too.
	'eedbdfff': 'Jy is ingeteken as **{email}**. As jy ’n nuwe wagwoord stel, word hierdie blaaier ook uitgeteken.',
	// At least 8 characters. Changing it signs you out on every device.
	'8c040ccc': 'Ten minste 8 karakters. As jy dit verander, word jy op elke toestel uitgeteken.',
	// Set new password
	'4a62d996': 'Stel nuwe wagwoord',
	// Back to your projects
	'5b46b440': 'Terug na jou projekte',
	// Back to sign in
	'5b7ba2af': 'Terug na inteken',
	// {name} · Shared catchment view
	'd520e65e': '{name} · Gedeelde aansig van die opvanggebied',
	// Shared catchment view
	'7c6df5c8': 'Gedeelde aansig van die opvanggebied',
	// Shared view
	'6d06bb05': 'Gedeelde aansig',
	// Loading…
	'2e7e4ae3': 'Laai tans…',
	// This link doesn’t open anything
	'6595c259': 'Hierdie skakel maak niks oop nie',
	// This link has expired or was withdrawn. Ask whoever sent it for a new one.
	'519fdd9e': 'Hierdie skakel het verval of is teruggetrek. Vra die persoon wat dit gestuur het vir ’n nuwe een.',
	// This page needs the whole link. Open the link you were sent again, or ask whoever sent it for a new one.
	'5950d7c5': 'Hierdie bladsy het die hele skakel nodig. Maak die skakel wat vir jou gestuur is weer oop, of vra die persoon wat dit gestuur het vir ’n nuwe een.',
	// Couldn’t load this just now. Check your connection and try again.
	'79725e4a': 'Kon dit nie nou laai nie. Kyk jou verbinding na en probeer weer.',
	// Catchment water balance, shared read-only
	'bc8ea99f': 'Waterbalans van die opvanggebied, leesalleen gedeel',
	// A model estimate that can be wrong, not a measurement, licence or restriction. As far as the law allows, the operator of this software accepts no responsibility to anyone who relies on this page.
	'8431cc26': '’n Modelskatting wat verkeerd kan wees, nie ’n meting, lisensie of beperking nie. Sover die wet dit toelaat, aanvaar die operateur van hierdie sagteware geen verantwoordelikheid teenoor enigiemand wat op hierdie bladsy staatmaak nie.',
	// The river’s ecological reserve
	'd593593a': 'Die rivier se ekologiese reserwe',
	// Couldn’t load the flow chart just now.
	'c1e6e998': 'Kon nie die vloeigrafiek nou laai nie.',
	// The flow chart isn’t shown for this catchment: with so few farms, the river’s flows could reveal a farm’s water use.
	'c67f2840': 'Die vloeigrafiek word nie vir hierdie opvanggebied gewys nie: met so min plase kan die rivier se vloei ’n plaas se watergebruik verklap.',
	// About this page
	'254af6c5': 'Oor hierdie bladsy',
	// This is the catchment’s published result from its water balance model: whether the river kept its ecological reserve (the flow it needs to stay healthy) and the Water User Association’s notice. It is read-only, and it shows no farm’s figures.
	'60cadb22': 'Dit is die opvanggebied se gepubliseerde uitslag van sy waterbalansmodel: of die rivier sy ekologiese reserwe behou het (die vloei wat dit nodig het om gesond te bly) en die Watergebruikersvereniging se kennisgewing. Dit is net om te lees, en dit wys geen plaas se syfers nie.',
	// A model of the catchment, not measurements; it can be wrong. This link works until it expires or is withdrawn.
	'e4b3fdc4': '’n Model van die opvanggebied, nie metings nie; dit kan verkeerd wees. Hierdie skakel werk totdat dit verval of teruggetrek word.',
	// It is not a water-use authorisation, licence, allocation or restriction under the National Water Act: only the responsible authority and the Water User Association’s own notices decide those. Don’t rely on it alone for a decision.
	'7a517563': 'Dit is nie ’n magtiging vir watergebruik, ’n lisensie, ’n toekenning of ’n beperking kragtens die Nasionale Waterwet nie: net die verantwoordelike owerheid en die Watergebruikersvereniging se eie kennisgewings besluit daaroor. Moenie net hierop staatmaak vir ’n besluit nie.',
	// We’ve sent a new link to {email}.
	'c77d6547': 'Ons het ’n nuwe skakel na {email} gestuur.',
	// your address
	'9fbfb0f6': 'jou adres',
	// Confirm your email
	'62aee4d2': 'Bevestig jou e-pos',
	// Confirming your email address…
	'14532712': 'Bevestig tans jou e-posadres…',
	// Thanks — **{email}** is confirmed. Any projects or teams you were invited to are now in your list.
	'313d15b2': 'Dankie — **{email}** is bevestig. Enige projekte of spanne waarheen jy uitgenooi is, is nou in jou lys.',
	// Thanks — your email address is confirmed. Sign in to see any projects or teams you were invited to.
	'43343d8b': 'Dankie — jou e-posadres is bevestig. Teken in om enige projekte of spanne te sien waarheen jy uitgenooi is.',
	// This confirmation link is invalid, already used, or older than 48 hours.
	'44951451': 'Hierdie bevestigingskakel is ongeldig, reeds gebruik of ouer as 48 uur.',
	// Sign in and use **Resend email** in the banner at the top of the page to get a new link.
	'b2820f54': 'Teken in en gebruik **Stuur e-pos weer** in die strook bo-aan die bladsy om ’n nuwe skakel te kry.',
	// No account yet?
	'd6cf81c0': 'Nog nie ’n rekening nie?',
};
