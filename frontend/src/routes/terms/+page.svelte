<script lang="ts">
	// The terms of use (issue #57's footer), in the estate's shape (the
	// jaredhoward site's Terms: the same party, liability cap, one-way
	// indemnity, informal-first disputes, no arbitration), adapted to a free
	// modelling service. Governing law is per user (§15): South African law and
	// courts for anyone in South Africa, Virginia otherwise. Research-based
	// wording the operator accepted without counsel: docs/legal-status.md
	// tracks what is open. A material change bumps LEGAL_VERSION, which asks
	// every account to accept again.
	import { base } from '$app/paths';
	import { legalEffective } from '@water-management/engine/legal';
	import LegalPage from '$lib/components/legal/LegalPage.svelte';
	import { SUMMARY_POINTS } from '$lib/components/legal/termsSummary';

	const sections = [
		{ id: 'short', label: 'The short version' },
		{ id: 'agreement', label: '1. This agreement' },
		{ id: 'service', label: '2. The service' },
		{ id: 'results', label: '3. Model results are estimates' },
		{ id: 'accounts', label: '4. Accounts' },
		{ id: 'organisations', label: '5. Organisations, projects and invitations' },
		{ id: 'content', label: '6. Your content and data' },
		{ id: 'use', label: '7. Acceptable use' },
		{ id: 'fees', label: '8. Fees' },
		{ id: 'third-party', label: '9. Third-party data and services' },
		{ id: 'ours', label: '10. Our software' },
		{ id: 'ending', label: '11. Suspension and ending' },
		{ id: 'warranties', label: '12. Disclaimer of warranties' },
		{ id: 'liability', label: '13. Limitation of liability' },
		{ id: 'indemnity', label: '14. Indemnification' },
		{ id: 'law', label: '15. Governing law and disputes' },
		{ id: 'changes', label: '16. Changes to these terms' },
		{ id: 'general', label: '17. General' },
		{ id: 'notices', label: '18. Notices' },
		{ id: 'contact', label: '19. Contact' }
	];
</script>

<LegalPage
	title="Terms of use"
	description="The terms for using Water Management, the catchment water-balance modelling service."
	effective={legalEffective()}
	{sections}
>
	<!-- The same points as the sign-up form's summary (termsSummary.ts), in English. -->
	<h2 id="short">The short version</h2>
	<ul>
		{#each SUMMARY_POINTS as point (point)}<li>{point}</li>{/each}
	</ul>
	<p>The rest of this page is the full text, and it is the part that applies.</p>

	<h2 id="agreement">1. This agreement</h2>
	<p>
		These terms are an agreement between <strong>Jared Howard</strong>, a sole proprietor based in Virginia, United States (“we”,
		“us”), and you, the person using Water Management (“the service”), or the organisation you use it for. By creating an account,
		accepting an invitation or otherwise using the service, you accept these terms and our
		<a href="{base}/privacy">privacy notice</a>. If you use the service for an organisation, you confirm you may accept these terms
		for it. If you don’t accept them, don’t use the service.
	</p>

	<h2 id="service">2. The service</h2>
	<p>
		Water Management models a catchment’s water balance day by day: rainfall and runoff, farm dams, irrigation supply and demand,
		transfers, and the river’s flow against its ecological reserve. It lets an organisation build and calibrate a model, run it,
		compare scenarios, publish results to its members, and let each farmer see their own farm. We may change, add or remove
		features, and we will try to give notice of changes that remove something you rely on.
	</p>

	<h2 id="results">3. Model results are estimates</h2>
	<p>
		Everything the service calculates is a <strong>model estimate</strong>, only as good as the data, parameters and assumptions
		put into it. It is not a measurement, a forecast you can rely on, a guarantee of water availability, or professional advice.
		In particular:
	</p>
	<ul>
		<li>
			Results are not a water-use authorisation, licence, allocation or restriction. Only the relevant authority, and your water
			user association’s own notices, decide those.
		</li>
		<li>
			Decisions about irrigation, dams, licence applications, the ecological reserve or anything else remain yours and those of
			the qualified professionals advising you. Check the results against your own knowledge and data before relying on them.
		</li>
		<li>
			A sign-off in the service records who reviewed a run or an evidence pack; it is that person’s professional statement, not ours.
			It is an electronic professional statement in this app, not the signer’s signature on any form or report the authority
			requires: sign those as the authority asks. The professional registration shown with it is typed in by the person signing: we
			don’t check it against the professional body’s register. A project’s host may record that it checked one, and the pack’s verify
			page then says by whom and when; that check is the host’s, not ours. Signing off, and issuing or withdrawing an evidence pack,
			need a code from your authenticator app from the last 10 minutes.
		</li>
	</ul>
	<p>
		Reports the service produces carry their own disclaimer, which says the same thing for anyone a report is shared with,
		including that a report is not an authorisation to use water: only the responsible authority decides that, under the
		National Water Act, 1998 (sections 22, 27 and 41).
	</p>
	<p>
		If you give a report, export or share link to anyone else, pass it on whole, with its disclaimer. Don’t present a run as
		evidence for a water-use licence application unless a registered professional has signed it off.
	</p>

	<h2 id="accounts">4. Accounts</h2>
	<ul>
		<li>You must be 18 or older, give a real email address you can receive mail at, and confirm it before you can sign in.</li>
		<li>Keep your password to yourself. You are responsible for what is done with your account; tell us straight away if you think someone else is using it.</li>
		<li>One person per account: don’t share an account or make one in someone else’s name.</li>
	</ul>

	<h2 id="organisations">5. Organisations, projects and invitations</h2>
	<p>
		A project belongs to the person or team that owns it. Its owners decide who is invited, with which role, and which farm a
		farmer is linked to. If you invite people or link a farmer to a farm, you confirm that you have a proper reason and the right
		to share that information with them, and you are responsible for that under data-protection law (see the
		<a href="{base}/privacy#roles">privacy notice</a>). If you publish results or create a share link, you decide who sees them.
	</p>

	<h2 id="content">6. Your content and data</h2>
	<p>
		You keep all rights in what you put into the service: models, uploaded data, notes and documents (“your content”). You give us
		permission to store, process, copy and display your content only as needed to run the service for you and the people you give
		access to, and to keep backups. We don’t use your content for anything else, and we don’t sell it.
	</p>
	<p>
		You confirm you have the right to upload your content, including data from third parties (such as gauging records or
		registration records), and that doing so doesn’t break any law or agreement. You can download a project’s data and your own
		personal information at any time.
	</p>

	<h2 id="use">7. Acceptable use</h2>
	<p>Don’t:</p>
	<ul>
		<li>break the law, or use the service to mislead an authority or anyone relying on the results;</li>
		<li>try to reach projects, accounts or data you weren’t given access to, or get around the service’s limits or security;</li>
		<li>test, probe or attack the service’s security, except with our written permission (see our security policy);</li>
		<li>overload the service, or scrape or copy it by automated means, other than through the API keys it offers, within their limits;</li>
		<li>upload malicious code, or content you have no right to share;</li>
		<li>put special personal information (such as health or religious information) or anything unlawful in notes or data.</li>
	</ul>

	<h2 id="fees">8. Fees</h2>
	<p>
		The service is currently provided without charge. If we introduce fees, we will tell you in advance, and nothing will be charged
		without your agreement to the price and terms at that time.
	</p>

	<h2 id="third-party">9. Third-party data and services</h2>
	<p>
		The service can read public data sources, such as CHIRPS satellite rainfall and the Department of Water and Sanitation’s
		gauging records. They are provided by others, as they are; we don’t control their accuracy, availability or terms, and your use
		of them is also subject to their own terms. The service is hosted on Amazon Web Services. The data sources it uses, and the
		credit each one’s licence asks for, are listed on the <a href="{base}/data-sources">data sources</a> page.
	</p>
	<!-- Map data licensed to us (HydroRIVERS first, docs/maps.md § Sources): the end-user terms the HydroSHEDS licence
	     asks for (§ 2.1.2, terms at least as protective as its own; § 2.1.3, no reverse engineering), written for any
	     licensed source. Pre-counsel wording (docs/legal-status.md, 2026-10-02); a material change (LEGAL_VERSION 2026-10-03). -->
	<p>
		<strong>Map data licensed to us.</strong> Some of the map data the service shows is licensed to us by others, such as the
		HydroRIVERS river network from WWF’s HydroSHEDS database. You may use it within the service, and as part of your projects and
		the results, reports and maps you make with it. You may not copy, extract or distribute that data on its own, as a stand-alone
		dataset, and you may not decompile, reverse engineer or disassemble it. It remains the property of its licensors, who provide it
		as it is, without any warranty, and are not liable for your use of it.
	</p>

	<h2 id="ours">10. Our software</h2>
	<p>
		The service’s source code is published under the MIT License, which governs that code. These terms govern your use of the
		hosted service we run: the right to use it, not ownership of it, the Water Management name, or anyone else’s content in it.
		Feedback you give us may be used without any obligation to you.
	</p>

	<h2 id="ending">11. Suspension and ending</h2>
	<p>
		You may stop using the service at any time and ask us to delete your account. We may suspend or end your access if you break
		these terms, if the law requires it, or to protect the service or other people, and we will tell you why unless we can’t. We
		may also stop offering the service; if we do, we will give at least 30 days’ notice where we can, so you can download your
		data. Sections 3, 6, 9, 12–15 and 17 survive the end of this agreement.
	</p>

	<h2 id="warranties">12. Disclaimer of warranties</h2>
	<p>
		<strong
			>The service is provided “as is” and “as available”, without warranty of any kind, express or implied. To the fullest extent
			permitted by law, we disclaim all implied warranties, including of merchantability, fitness for a particular purpose, title and
			non-infringement. We do not warrant that the service or its results will be accurate, complete, uninterrupted or error-free, or
			that data will not be lost.</strong
		>
	</p>
	<p>Some jurisdictions do not allow these exclusions, so some of them may not apply to you.</p>

	<h2 id="liability">13. Limitation of liability</h2>
	<p>
		<strong
			>To the fullest extent permitted by law, our total liability arising out of or relating to these terms or the service will not
			exceed the greater of (a) the fees you paid us in the twelve months before the event giving rise to the claim, or (b) one
			hundred US dollars (US $100). We will not be liable for any indirect, incidental, special, consequential or punitive damages,
			or for loss of profits, crops, water, revenue, data or goodwill, including from decisions made in reliance on model results,
			whether or not we were told they were possible.</strong
		>
	</p>
	<p>
		These limits don’t apply to our gross negligence, wilful misconduct or fraud, to death or personal injury caused by our
		negligence, or to any liability that the law does not allow to be limited. Some jurisdictions do not allow these limits, so some
		of them may not apply to you.
	</p>

	<h2 id="indemnity">14. Indemnification</h2>
	<p>
		You agree to indemnify and defend Jared Howard and our contractors and agents against third-party claims, losses and reasonable
		legal costs arising from your content, your breach of these terms, your breach of any law or third-party right (including
		data-protection law, for information you invite or share), or your use of the service in a way these terms don’t allow. We may
		take part in the defence with our own counsel at our own cost.
	</p>

	<h2 id="law">15. Governing law and disputes</h2>
	<p>
		Which law applies depends on where you are. If you live in South Africa, or use the service for a farm, water user association,
		business or other organisation based there, these terms are governed by the law of the Republic of South Africa. Either of us
		may then bring proceedings in a South African court that has jurisdiction; those courts’ jurisdiction is not exclusive, and we
		each consent to the jurisdiction of the magistrates’ courts for claims within their limits.
	</p>
	<p>
		Otherwise, these terms are governed by the laws of the Commonwealth of Virginia, United States, without regard to its
		conflict-of-laws rules, and disputes are brought in the state or federal courts in Virginia. If you are a consumer under the law
		of the country you live in, you may also bring a claim in the courts where you live.
	</p>
	<p>
		Either way, before either of us starts legal proceedings, the one with a concern must write to the other describing it and
		proposing a solution (to us at the address in section 19, to you at your account’s email address), and we will both try in good
		faith to resolve it for at least 30 days. There is no arbitration and no class-action waiver.
	</p>
	<p>
		Nothing in these terms takes away rights you have under the mandatory law of the country you live in, such as consumer or
		data-protection rights (in South Africa, including under the Consumer Protection Act, the Electronic Communications and
		Transactions Act and the Protection of Personal Information Act), or your right to complain to a regulator.
	</p>

	<h2 id="changes">16. Changes to these terms</h2>
	<p>
		We may update these terms. The date at the top shows the current version. If a change is material, we will email account
		holders at least 15 days before it takes effect. Using the service after that means you accept the new terms; if you don’t, stop
		using it and ask us to delete your account.
	</p>

	<h2 id="general">17. General</h2>
	<p>
		These terms and the privacy notice are the whole agreement between us about the service. If a part is found unenforceable, the
		rest still applies. Not enforcing a right is not giving it up. You may not transfer this agreement without our consent; we may
		transfer it to whoever takes over the service, and will tell you. Neither of us is responsible for delays caused by events
		beyond reasonable control. We are independent of each other: these terms create no partnership, employment or agency. You may
		not use the service in breach of the export or sanctions laws that apply to you or to us. These terms are written in English,
		and the English version is the one that applies.
	</p>

	<h2 id="notices">18. Notices</h2>
	<p>
		We send notices to the email address on your account; you send them to the address in section 19. A notice counts as received
		the day after it is sent, unless the sender learns it wasn’t delivered.
	</p>

	<h2 id="contact">19. Contact</h2>
	<p>
		Jared Howard<br />
		<a href="mailto:jared@jaredhoward.com">jared@jaredhoward.com</a>
	</p>
</LegalPage>
