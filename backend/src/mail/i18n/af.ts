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
	// {inviter} has given you access to {farms} in {catchment}
	'mail.farmer.subject': '{inviter} het jou toegang gegee tot {farms} in {catchment}',
	// Your farm on {product}
	'mail.farmer.heading': 'Jou plaas op {product}',
	// {inviter} has given you access to {farms} in {catchment}.
	'mail.farmer.body': '{inviter} het jou toegang gegee tot {farms} in {catchment}.',
	// You will see your own farm's water, dam and any restriction notice, and nothing about your neighbours' farms.
	'mail.farmer.privacy': 'Jy sal jou eie plaas se water, dam en enige beperkingskennisgewing sien, en niks oor jou bure se plase nie.',
	// your farm
	'mail.farmer.yourFarm': 'jou plaas',
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
	// If you never created a {product} account, someone else registered your address: don't confirm it — use “Forgot password” on the sign-in page to take the account over instead.
	'mail.invite.confirmTakeOver': 'As jy nooit ’n {product}-rekening geskep het nie, het iemand anders jou adres geregistreer: moenie dit bevestig nie — gebruik eerder “Wagwoord vergeet” op die intekenbladsy om die rekening oor te neem.',
	// {what} — {project}
	'mail.alert.subject': '{what} — {project}',
	// Open your farm
	'mail.alert.openFarm': 'Maak jou plaas oop',
	// Open the catchment
	'mail.alert.openProject': 'Maak die opvanggebied oop',
	// This is the catchment model’s estimate, worked out from the figures your WUA published. It is not a measurement of your dam and not an instruction. Check your dam yourself, and ask your WUA if you are unsure. Only a notice from your WUA or from DWS is a restriction.
	'mail.alert.model': 'Dit is ’n skatting van die opvanggebied se model, bereken uit die syfers wat jou WGV gepubliseer het. Dit is nie ’n meting van jou dam nie, en nie ’n opdrag nie. Kyk self na jou dam, en vra jou WGV as jy onseker is. Net ’n kennisgewing van jou WGV of van die DWS is ’n beperking.',
	// This is the catchment model’s estimate, worked out from the figures the WUA published. It is not a measurement of the dam and not an instruction. Only a notice from the WUA or from DWS is a restriction.
	'mail.alert.model.dam.staff': 'Dit is ’n skatting van die opvanggebied se model, bereken uit die syfers wat die WGV gepubliseer het. Dit is nie ’n meting van die dam nie, en nie ’n opdrag nie. Net ’n kennisgewing van die WGV of van die DWS is ’n beperking.',
	// This comes from the newest forecast run of the catchment model, which may not be published yet. It is an estimate, not a measurement, and not a restriction.
	'mail.alert.model.staff': 'Dit kom uit die nuutste voorspellingslopie van die opvanggebied se model, wat dalk nog nie gepubliseer is nie. Dit is ’n skatting, nie ’n meting nie, en nie ’n beperking nie.',
	// You get this email because you get {kind} alerts for {project}.
	'mail.alert.why': 'Jy kry hierdie e-pos omdat jy waarskuwings oor {kind} vir {project} kry.',
	// Stop these emails
	'mail.alert.unsubscribe': 'Stop hierdie e-posse',
	// Manage your alerts
	'mail.alert.manage': 'Bestuur jou waarskuwings',
	// Your alerts for {project} — {product}
	'mail.alert.digest.subject': 'Jou waarskuwings vir {project} — {product}',
	// Your alerts for {project}
	'mail.alert.digest.heading': 'Jou waarskuwings vir {project}',
	// Since the last summary:
	'mail.alert.digest.intro': 'Sedert die vorige opsomming:',
	// …and {more} more alerts. Open the catchment to see them all.
	'mail.alert.digest.more': '…en nog {more} waarskuwings. Maak die opvanggebied oop om hulle almal te sien.',
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
	// These data feeds are more than {threshold} days later than usual:
	'mail.alert.stale.body': 'Hierdie datavoere is meer as {threshold} dae later as gewoonlik:',
	// {feed}: newest day {newest}, {overdue} days late
	'mail.alert.stale.line': '{feed}: nuutste dag {newest}, {overdue} dae laat',
	// Data feed failing
	'mail.alert.failing.what': 'Datavoer misluk',
	// These data feeds have failed {threshold} or more times in a row:
	'mail.alert.failing.body': 'Hierdie datavoere het {threshold} of meer keer agtereenvolgens misluk:',
	// {feed}: {failures} failures in a row
	'mail.alert.failing.line': '{feed}: {failures} mislukkings agtereenvolgens',
	// Background jobs failed
	'mail.alert.jobs.what': 'Agtergrondtake het misluk',
	// {count} background jobs failed for good in the last 24 hours. See the jobs list in the catchment.
	'mail.alert.jobs.body': '{count} agtergrondtake het die afgelope 24 uur finaal misluk. Kyk na die takelys in die opvanggebied.',
	// New restriction notice
	'mail.alert.restriction.what': 'Nuwe beperkingskennisgewing',
	// Restriction lifted
	'mail.alert.restriction.liftedWhat': 'Beperking opgehef',
	// The WUA published a notice for {project} on {date}: {level}.
	'mail.alert.restriction.body': 'Die WGV het op {date} ’n kennisgewing vir {project} gepubliseer: {level}.',
	// The WUA published a notice for {project} on {date}: {level}, {pct} less water.
	'mail.alert.restriction.bodyPct': 'Die WGV het op {date} ’n kennisgewing vir {project} gepubliseer: {level}, {pct} minder water.',
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
};
