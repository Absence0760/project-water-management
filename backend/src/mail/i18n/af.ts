// Afrikaans wording of the farmer emails (WP-2.5). Only checked text goes
// here. A key with no entry is sent in English (and the email is marked
// lang="en"), and it must be on docs/i18n/af-translation-sheet.md, which is
// what the translator fills in. Add returned wording with
// `pnpm gen:i18n:apply`, or by hand and then `pnpm gen:i18n:sheet`.
//
// Provenance (2026-09-26, issue #49): every entry was written by the
// af-translator agent and reviewed by the af-checker agent
// (.claude/agents/i18n/), then applied with `pnpm gen:i18n:apply`. No native
// speaker has reviewed it yet; that review is open in docs/followups.md
// § Afrikaans (WP-2.5). Corrections go straight into this file.
//
// Only type imports: scripts/guards/i18n_sheet.mjs loads this file directly.
import type { MailKey } from './en.js';

export const af: Partial<Record<MailKey, string>> = {
	// If the button doesn't work, copy this address into your browser:
	'mail.buttonFallback': 'As die knoppie nie werk nie, kopieer hierdie adres in jou blaaier:',
	// Confirm your email address — {product}
	'mail.verify.subject': 'Bevestig jou e-posadres — {product}',
	// Confirm your email address
	'mail.verify.heading': 'Bevestig jou e-posadres',
	// Please confirm that {email} is your email address for {product}.
	'mail.verify.body': 'Bevestig asseblief dat {email} jou e-posadres vir {product} is.',
	// Confirm email address
	'mail.verify.action': 'Bevestig e-posadres',
	// This link expires in 48 hours.
	'mail.verify.expires': 'Hierdie skakel verval oor 48 uur.',
	// If you didn't create an account, you can ignore this email.
	'mail.verify.ignore': 'As jy nie ’n rekening geskep het nie, kan jy hierdie e-pos ignoreer.',
	// Reset your password — {product}
	'mail.reset.subject': 'Stel jou wagwoord terug — {product}',
	// Reset your password
	'mail.reset.heading': 'Stel jou wagwoord terug',
	// Someone asked to reset the password for the {product} account {email}.
	'mail.reset.body': 'Iemand het gevra om die wagwoord van die {product}-rekening {email} terug te stel.',
	// Choosing a new password signs you out on every device.
	'mail.reset.signsOut': 'As jy ’n nuwe wagwoord kies, word jy op elke toestel uitgeteken.',
	// Choose a new password
	'mail.reset.action': 'Kies ’n nuwe wagwoord',
	// This link expires in 1 hour and works once.
	'mail.reset.expires': 'Hierdie skakel verval oor 1 uur en werk net een keer.',
	// If you didn't ask for this, you can ignore this email — your password stays the same.
	'mail.reset.ignore': 'As jy nie hiervoor gevra het nie, kan jy hierdie e-pos ignoreer — jou wagwoord bly dieselfde.',
	// You already have an account — {product}
	'mail.exists.subject': 'Jy het reeds ’n rekening — {product}',
	// You already have an account
	'mail.exists.heading': 'Jy het reeds ’n rekening',
	// Someone tried to create a {product} account for {email}, but this address already has one.
	'mail.exists.body': 'Iemand het probeer om ’n {product}-rekening vir {email} te skep, maar hierdie adres het reeds een.',
	// If it was you, sign in with your password. If you’ve forgotten it, choose a new one:
	'mail.exists.signIn': 'As dit jy was, teken in met jou wagwoord. As jy dit vergeet het, kies ’n nuwe een:',
	// Choose a new password
	'mail.exists.action': 'Kies ’n nuwe wagwoord',
	// If it wasn't you, you can ignore this email — nothing has changed on your account.
	'mail.exists.ignore': 'As dit nie jy was nie, kan jy hierdie e-pos ignoreer — niks aan jou rekening het verander nie.',
	// {inviter} invited you to see {farms} in {catchment}
	'mail.farmer.subject': '{inviter} het jou uitgenooi om {farms} in {catchment} te sien',
	// Your hydrological unit on {product}
	'mail.farmer.heading': 'Jou hidrologiese eenheid op {product}',
	// {inviter} invited you to see {farms} in {catchment}.
	'mail.farmer.body': '{inviter} het jou uitgenooi om {farms} in {catchment} te sien.',
	// You will see your own hydrological unit's water, dam and any restriction notice, and nothing about your neighbours' hydrological units.
	'mail.farmer.privacy': 'Jy sal jou eie hidrologiese eenheid se water, dam en enige beperkingskennisgewing sien, en niks oor jou bure se hidrologiese eenhede nie.',
	// The figures you will see are worked out by a computer model of the catchment. They are estimates, not measurements or instructions, and they can be wrong. Only a notice from your WUA or from the Department of Water and Sanitation (DWS) is a restriction.
	'mail.farmer.estimate': 'Die syfers wat jy sal sien, is deur ’n rekenaarmodel van die opvanggebied bereken. Dit is skattings, nie metings of opdragte nie, en dit kan verkeerd wees. Net ’n kennisgewing van jou WGV of van die Departement van Water en Sanitasie (DWS) is ’n beperking.',
	// your hydrological unit
	'mail.farmer.yourFarm': 'jou hidrologiese eenheid',
	// and
	'mail.farmer.and': 'en',
	// Create your {product} account with this email address ({email}) to accept.
	'mail.invite.signUp': 'Skep jou {product}-rekening met hierdie e-posadres ({email}) om te aanvaar.',
	// Create account and accept
	'mail.invite.signUpAction': 'Skep rekening en aanvaar',
	// This invitation expires in 7 days.
	'mail.invite.signUpExpires': 'Hierdie uitnodiging verval oor 7 dae.',
	// If you weren't expecting this, you can ignore this email.
	'mail.invite.signUpIgnore': 'As jy dit nie verwag het nie, kan jy hierdie e-pos ignoreer.',
	// How we handle your information: {url}
	'mail.invite.privacy': 'Hoe ons jou inligting hanteer: {url}',
	// There is already a {product} account for {email}. Confirm that this is your email address to accept.
	'mail.invite.confirm': 'Daar is reeds ’n {product}-rekening vir {email}. Bevestig dat dit jou e-posadres is om te aanvaar.',
	// Confirm email and accept
	'mail.invite.confirmAction': 'Bevestig e-pos en aanvaar',
	// This link expires in 48 hours.
	'mail.invite.confirmExpires': 'Hierdie skakel verval oor 48 uur.',
	// Sign in to {product} as {email} to accept or decline. You won't join until you accept.
	'mail.invite.accept': 'Teken as {email} by {product} in om te aanvaar of af te wys. Jy sluit eers aan wanneer jy aanvaar.',
	// See the invitation
	'mail.invite.acceptAction': 'Bekyk die uitnodiging',
	// If you never created a {product} account, someone else registered your address: don't confirm it — use “Forgot password” on the sign-in page to take the account over instead.
	'mail.invite.confirmTakeOver': 'As jy nooit ’n {product}-rekening geskep het nie, het iemand anders jou adres geregistreer: moenie dit bevestig nie — gebruik eerder “Wagwoord vergeet” op die intekenbladsy om die rekening oor te neem.',
	// {what} — {project}
	'mail.alert.subject': '{what} — {project}',
	// Open your hydrological unit
	'mail.alert.openFarm': 'Maak jou hidrologiese eenheid oop',
	// Open the catchment
	'mail.alert.openProject': 'Maak die opvanggebied oop',
	// This is the catchment model’s estimate, worked out from the figures your WUA published. It is not a measurement of your dam and not an instruction. Check your dam yourself, and ask your WUA if you are unsure. Only a notice from your WUA or from DWS is a restriction.
	'mail.alert.model': 'Dit is ’n skatting van die opvanggebied se model, bereken uit die syfers wat jou WGV gepubliseer het. Dit is nie ’n meting van jou dam nie, en nie ’n opdrag nie. Kyk self na jou dam, en vra jou WGV as jy onseker is. Net ’n kennisgewing van jou WGV of van die DWS is ’n beperking.',
	// This is the catchment model’s estimate, worked out from the figures the WUA published. It is not a measurement of the dam and not an instruction. Only a notice from the WUA or from DWS is a restriction.
	'mail.alert.model.dam.staff': 'Dit is ’n skatting van die opvanggebied se model, bereken uit die syfers wat die WGV gepubliseer het. Dit is nie ’n meting van die dam nie, en nie ’n opdrag nie. Net ’n kennisgewing van die WGV of van die DWS is ’n beperking.',
	// This is the catchment model’s estimate, from figures an auto run published by itself, without a person checking them first. It is not a measurement and not a restriction.
	'mail.alert.model.short.staff': 'Dit is ’n skatting van die opvanggebied se model, uit syfers wat ’n outomatiese lopie self gepubliseer het, sonder dat iemand dit eers nagegaan het. Dit is nie ’n meting nie, en nie ’n beperking nie.',
	// This comes from the newest forecast run of the catchment model, which may not be published yet. It is an estimate, not a measurement, and not a restriction.
	'mail.alert.model.staff': 'Dit kom uit die nuutste voorspellingslopie van die opvanggebied se model, wat dalk nog nie gepubliseer is nie. Dit is ’n skatting, nie ’n meting nie, en nie ’n beperking nie.',
	// You get this email because you get {kind} alerts for {project}.
	'mail.alert.why': 'Jy kry hierdie e-pos omdat jy waarskuwings oor {kind} vir {project} kry.',
	// Stop these emails
	'mail.alert.unsubscribe': 'Stop hierdie e-posse',
	// Manage your alerts
	'mail.alert.manage': 'Bestuur jou waarskuwings',
	// Was this alert useful?
	'mail.alert.feedback.question': 'Was hierdie waarskuwing nuttig?',
	// Was this summary useful?
	'mail.alert.feedback.digestQuestion': 'Was hierdie opsomming nuttig?',
	// Yes
	'mail.alert.feedback.yes': 'Ja',
	// No
	'mail.alert.feedback.no': 'Nee',
	// Your alerts for {project} — {product}
	'mail.alert.digest.subject': 'Jou waarskuwings vir {project} — {product}',
	// Your alerts for {project}
	'mail.alert.digest.heading': 'Jou waarskuwings vir {project}',
	// Since the last summary:
	'mail.alert.digest.intro': 'Sedert die vorige opsomming:',
	// …and {more} more alert. Open the catchment to see it.
	'mail.alert.digest.more.one': '…en nog {more} waarskuwing. Maak die opvanggebied oop om dit te sien.',
	// …and {more} more alerts. Open the catchment to see them all.
	'mail.alert.digest.more.other': '…en nog {more} waarskuwings. Maak die opvanggebied oop om hulle almal te sien.',
	// You get this daily summary because you chose daily alerts for {project}, or had more than {cap} alert emails in a day.
	'mail.alert.digest.why': 'Jy kry hierdie daaglikse opsomming omdat jy daaglikse waarskuwings vir {project} gekies het, of op een dag meer as {cap} waarskuwings-e-posse gekry het.',
	// Stop all alert emails for this catchment
	'mail.alert.digest.unsubscribe': 'Stop alle waarskuwings-e-posse vir hierdie opvanggebied',
	// dam level
	'mail.alert.kind.dam_below': 'die damvlak',
	// river flow forecast
	'mail.alert.kind.ewr_forecast_fail': 'die riviervloeivoorspelling',
	// missing data
	'mail.alert.kind.data_stale': 'ontbrekende data',
	// restriction notice
	'mail.alert.kind.restriction_published': 'beperkingskennisgewings',
	// failed background job
	'mail.alert.kind.job_dead': 'mislukte agtergrondtake',
	// failing data feed
	'mail.alert.kind.feed_failing': 'datavoere wat misluk',
	// hydrological units short of water
	'mail.alert.kind.farms_short': 'hidrologiese eenhede met ’n watertekort',
	// Dam low on {farm}
	'mail.alert.dam.what': 'Dam laag op {farm}',
	// The model puts the dam on {farm} at about {pct} of capacity on {date}, below the alert level of {threshold}.
	'mail.alert.dam.latest': 'Volgens die model was die dam op {farm} op {date} ongeveer {pct} vol, onder die waarskuwingsvlak van {threshold}.',
	// On the rain forecast of {madeOn}, the model expects the dam on {farm} to fall to about {pct} of capacity around {date}, below the alert level of {threshold}. Forecasts change.
	'mail.alert.dam.forecast': 'Volgens die reënvoorspelling van {madeOn} verwag die model dat die dam op {farm} rondom {date} tot ongeveer {pct} van sy kapasiteit sal daal, onder die waarskuwingsvlak van {threshold}. Voorspellings verander.',
	// River flow at risk in the forecast
	'mail.alert.ewr.what': 'Riviervloei in gevaar volgens die voorspelling',
	// On the rain forecast of {madeOn}, the model expects the river’s ecological reserve (EWR) at the outlet to be missed on {days} of the {of} forecast days ({from} to {to}). The alert is set at {threshold} days. Forecasts change.
	'mail.alert.ewr.body': 'Volgens die reënvoorspelling van {madeOn} verwag die model dat die rivier se ekologiese reserwe (EWR) by die uitloop op {days} van die {of} voorspelde dae ({from} tot {to}) nie gehaal sal word nie. Die waarskuwing is op {threshold} dae gestel. Voorspellings verander.',
	// Data feed behind
	'mail.alert.stale.what': 'Datavoer loop agter',
	// These data feeds are more than {threshold} day later than usual:
	'mail.alert.stale.body.one': 'Hierdie datavoere is meer as {threshold} dag later as gewoonlik:',
	// These data feeds are more than {threshold} days later than usual:
	'mail.alert.stale.body.other': 'Hierdie datavoere is meer as {threshold} dae later as gewoonlik:',
	// {feed}: newest day {newest}, {overdue} day late
	'mail.alert.stale.line.one': '{feed}: nuutste dag {newest}, {overdue} dag laat',
	// {feed}: newest day {newest}, {overdue} days late
	'mail.alert.stale.line.other': '{feed}: nuutste dag {newest}, {overdue} dae laat',
	// No new readings have come in through the API key for this series for more than {threshold} day:
	'mail.alert.stale.seriesBody.one': 'Daar het al meer as {threshold} dag lank geen nuwe lesings vir hierdie datareeks deur die API-sleutel ingekom nie:',
	// No new readings have come in through the API key for this series for more than {threshold} days:
	'mail.alert.stale.seriesBody.other': 'Daar het al meer as {threshold} dae lank geen nuwe lesings vir hierdie datareeks deur die API-sleutel ingekom nie:',
	// Hydrological units short of water
	'mail.alert.short.what': 'Hidrologiese eenhede met ’n watertekort',
	// An auto run published new figures on {publishedAt}. Hydrological units short of water on at least one day from {from} to {to}: {count} of {of}. The alert is set at {threshold}.
	'mail.alert.short.body': '’n Outomatiese lopie het op {publishedAt} nuwe syfers gepubliseer. Hidrologiese eenhede met ’n watertekort op minstens een dag van {from} tot {to}: {count} van {of}. Die waarskuwing is op {threshold} gestel.',
	// Data feed failing
	'mail.alert.failing.what': 'Datavoer misluk',
	// These data feeds have failed {threshold} or more times in a row:
	'mail.alert.failing.body': 'Hierdie datavoere het {threshold} of meer keer agtereenvolgens misluk:',
	// {feed}: {failures} failure in a row
	'mail.alert.failing.line.one': '{feed}: {failures} mislukking agtereenvolgens',
	// {feed}: {failures} failures in a row
	'mail.alert.failing.line.other': '{feed}: {failures} mislukkings agtereenvolgens',
	// Background jobs failed
	'mail.alert.jobs.what': 'Agtergrondtake het misluk',
	// {count} background job failed for good in the last 24 hours. See the jobs list in the catchment.
	'mail.alert.jobs.body.one': '{count} agtergrondtaak het die afgelope 24 uur finaal misluk. Kyk na die takelys in die opvanggebied.',
	// {count} background jobs failed for good in the last 24 hours. See the jobs list in the catchment.
	'mail.alert.jobs.body.other': '{count} agtergrondtake het die afgelope 24 uur finaal misluk. Kyk na die takelys in die opvanggebied.',
	// New restriction notice
	'mail.alert.restriction.what': 'Nuwe beperkingskennisgewing',
	// Restriction lifted
	'mail.alert.restriction.liftedWhat': 'Beperking opgehef',
	// The WUA published a notice for {project} on {date}: {level}.
	'mail.alert.restriction.body': 'Die WGV het op {date} ’n kennisgewing vir {project} gepubliseer: {level}.',
	// The WUA published a notice for {project} on {date}: {level}, a {pct} cut in registered water use.
	'mail.alert.restriction.bodyPct': 'Die WGV het op {date} ’n kennisgewing vir {project} gepubliseer: {level}, ’n besnoeiing van {pct} op geregistreerde watergebruik.',
	// The WUA lifted the restriction for {project} on {date}.
	'mail.alert.restriction.lifted': 'Die WGV het die beperking vir {project} op {date} opgehef.',
	// The WUA’s notice: “{notice}”
	'mail.alert.restriction.notice': 'Die WGV se kennisgewing: “{notice}”',
	// no restriction
	'mail.alert.restriction.level.none': 'geen beperking',
	// please use less water (advisory)
	'mail.alert.restriction.level.advisory': 'gebruik asseblief minder water (advies)',
	// restricted
	'mail.alert.restriction.level.restricted': 'beperk',
	// This notice is the WUA’s own. It is shown here as the WUA published it. Questions about it go to your WUA.
	'mail.alert.restriction.wua': 'Hierdie kennisgewing is die WGV s’n. Dit word hier gewys soos die WGV dit gepubliseer het. Rig vrae daaroor aan jou WGV.',
	// Evidence pack issued: {name} — {project}
	'mail.pack.issued.subject': 'Bewyspakket uitgereik: {name} — {project}',
	// Evidence pack issued
	'mail.pack.issued.heading': 'Bewyspakket uitgereik',
	// Version {version} of the evidence pack for {what} in {project} has been issued.
	'mail.pack.issued.body': 'Weergawe {version} van die bewyspakket vir {what} in {project} is uitgereik.',
	// It replaces version {previous}, which is now marked as superseded.
	'mail.pack.issued.supersedes': 'Dit neem die plek in van weergawe {previous}, wat nou as vervang gemerk is.',
	// Evidence pack withdrawn: {name} — {project}
	'mail.pack.withdrawn.subject': 'Bewyspakket teruggetrek: {name} — {project}',
	// Evidence pack withdrawn
	'mail.pack.withdrawn.heading': 'Bewyspakket teruggetrek',
	// Version {version} of the evidence pack for {what} in {project} has been withdrawn. It no longer stands as evidence, and the verify page now says so.
	'mail.pack.withdrawn.body': 'Weergawe {version} van die bewyspakket vir {what} in {project} is teruggetrek. Dit geld nie meer as bewys nie, en die verifikasiebladsy sê nou so.',
	// The reason given: “{reason}”
	'mail.pack.withdrawn.reason': 'Die rede wat gegee is: “{reason}”',
	// the application “{name}”
	'mail.pack.what.application': 'die aansoek “{name}”',
	// the baseline evidence
	'mail.pack.what.baseline': 'die basislynbewyse',
	// Baseline evidence
	'mail.pack.name.baseline': 'Basislynbewyse',
	// Its short code is {code}. Anyone with the code can check the pack, and whether it still stands, on the verify page.
	'mail.pack.code': 'Sy kort kode is {code}. Enigiemand met die kode kan die pakket, en of dit nog staan, op die verifikasiebladsy kontroleer.',
	// Check the pack
	'mail.pack.action': 'Kontroleer die pakket',
	// Open the pack in the catchment
	'mail.pack.open': 'Maak die pakket in die opvanggebied oop',
	// You get this email because you can issue and withdraw evidence packs in {project}.
	'mail.pack.why.editor': 'Jy kry hierdie e-pos omdat jy bewyspakkette in {project} kan uitreik en terugtrek.',
	// You get this email because the application “{name}” is yours.
	'mail.pack.why.applicant': 'Jy kry hierdie e-pos omdat die aansoek “{name}” joune is.',
};
