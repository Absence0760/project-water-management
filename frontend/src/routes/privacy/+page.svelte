<script lang="ts">
	// The privacy notice (POPIA s18; issue #57's footer). A record of what the
	// app actually does with personal information, written from docs/security.md
	// § Personal information (POPIA): change the two together. Draft before
	// counsel review: docs/legal-status.md tracks what is open.
	import { base } from '$app/paths';
	import { legalEffective } from '@water-management/engine/legal';
	import LegalPage from '$lib/components/legal/LegalPage.svelte';

	const sections = [
		{ id: 'who', label: '1. Who we are' },
		{ id: 'roles', label: '2. Who decides about your information' },
		{ id: 'what', label: '3. What we collect' },
		{ id: 'why', label: '4. Why we use it, and whether you must give it' },
		{ id: 'sharing', label: '5. Who can see it' },
		{ id: 'where', label: '6. Where it is kept' },
		{ id: 'retention', label: '7. How long we keep it' },
		{ id: 'cookies', label: '8. Cookies and your browser' },
		{ id: 'security', label: '9. How we protect it' },
		{ id: 'rights', label: '10. Your rights' },
		{ id: 'children', label: '11. Children' },
		{ id: 'changes', label: '12. Changes to this notice' },
		{ id: 'contact', label: '13. Contact and complaints' }
	];
</script>

<LegalPage
	title="Privacy notice"
	description="How Water Management collects, uses and protects personal information, and your rights under POPIA."
	effective={legalEffective()}
	{sections}
>
	<p>
		This notice explains what personal information Water Management (“the service”) collects, why, who can see it, how long it is
		kept, and the rights you have. It is written to meet South Africa’s Protection of Personal Information Act, 2013 (POPIA), and
		applies wherever you use the service from.
	</p>

	<h2 id="who">1. Who we are</h2>
	<p>
		The service is run by <strong>Jared Howard</strong>, a sole proprietor based in Virginia, United States (“we”, “us”). Jared
		Howard is also the information officer for the service. You can reach us at
		<a href="mailto:jared@jaredhoward.com">jared@jaredhoward.com</a>.
	</p>

	<h2 id="roles">2. Who decides about your information</h2>
	<p>
		Water Management is used by organisations: water user associations, consultancies and others that model a catchment and invite
		people to it.
	</p>
	<ul>
		<li>
			<strong>Your account</strong> (your email address, name, password and settings): we decide how it is used, as the
			<em>responsible party</em> under POPIA.
		</li>
		<li>
			<strong>What an organisation puts into its projects</strong> (who it invites, which farm a farmer is linked to, its model,
			data and notes): the organisation decides, and it is the responsible party for that information. We process it on its
			behalf, as its <em>operator</em>. If you have questions about why you were invited or what a project holds about your farm,
			ask the organisation first: its contact details are on your farm page (menu, <em>Who decides about your farm’s
			information</em>) and in your invitation email, once it has added them. We will help it answer you.
		</li>
	</ul>
	<p>
		We process an organisation’s project information under a written agreement with it (POPIA section 21). If an organisation
		hasn’t added its contact details yet, ask us for them.
	</p>

	<h2 id="what">3. What we collect</h2>
	<h3>Information you give us</h3>
	<ul>
		<li><strong>Account:</strong> your email address, display name and password (stored only as a one-way hash, never readable).</li>
		<li>
			<strong>Two-step sign-in, if you turn it on:</strong> the key your authenticator app shares with us (stored encrypted) and
			your recovery codes (stored only as one-way hashes).
		</li>
		<li><strong>Settings:</strong> your language, the unit volumes are shown in, the sections you hid from your sidebar, and which alert emails you get.</li>
		<li>
			<strong>What you write in a project:</strong> notes, the reason you give for a change, a sign-off (the name and professional
			registration you type), and any data or model you upload or edit. If the project’s host checks your registration against the
			professional body’s public register, its record of that check (the name and number it found, who checked and when). On a public
			comment, whether you asked to be on the applicant’s register of interested and affected parties.
		</li>
		<li>
			<strong>Feedback on alert emails:</strong> if you use the “Was this useful?” link in an alert email and press Send, your yes or
			no and any comment you add, with which kind of alert it was about. Opening the email or the link records nothing.
		</li>
	</ul>
	<h3>Information others give us about you</h3>
	<ul>
		<li><strong>Invitations:</strong> the email address someone invites, the language they chose for it and, for a farmer, the farms it gives access to.</li>
		<li><strong>Your role and your farm:</strong> the projects and teams you belong to, your role in each, and the farm(s) a water user association has linked to you.</li>
		<li>
			<strong>Registered water use:</strong> an organisation may import public registration records (such as WARMS), which can
			include a registered user’s name. These are kept apart from accounts and are shown only to people with the right role.
		</li>
	</ul>
	<h3>Information collected as you use the service</h3>
	<ul>
		<li><strong>Activity record:</strong> who changed what in a project, and when (the project’s history, kept as an audit trail).</li>
		<li><strong>Security records:</strong> sign-in attempts per email address, wrong two-step sign-in codes, the number of account emails sent, and your network address as seen by our servers, used to stop password guessing and abuse; and when you turned two-step sign-in on or off or used a recovery code, so you can see it.</li>
		<li>
			<strong>Emails we send you:</strong> which alert emails went out, and whether an address bounced. We don’t track whether you open
			an email or follow its links: our emails carry no tracking pixels or tracked links.
		</li>
		<li><strong>Server logs:</strong> requests and errors, kept briefly to run and fix the service.</li>
	</ul>
	<p>
		We do not use analytics, advertising or tracking tools, and the pages load no scripts, fonts or images from anyone else. We do
		not collect special personal information (such as health, religion or biometrics) and ask you not to put it in notes.
	</p>

	<h2 id="why">4. Why we use it</h2>
	<!-- Focusable in the markup: this page runs no script, so the app's scroll-region helper doesn't reach it (a phone scrolls the table sideways). -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div class="table-wrap" role="region" aria-label="Uses and lawful bases" tabindex="0">
		<table>
			<thead><tr><th>Use</th><th>Lawful basis (POPIA s11)</th></tr></thead>
			<tbody>
				<tr><td>Creating your account, signing you in, confirming your email address, resetting your password</td><td>Needed to perform our agreement with you, the Terms of use (POPIA s11(1)(b))</td></tr>
				<tr>
					<td>Showing you the projects, farms and results you have access to</td>
					<td>
						For your account: our agreement with you. For what an organisation puts in a project (who it invites, which farm a farmer
						is linked to): the organisation’s legitimate interest in managing its water scheme and telling its members about their own
						water (s11(1)(f)). A farmer who objects can leave the project, which removes the link.
					</td>
				</tr>
				<tr>
					<td>Alert emails (a dam running low, a restriction notice)</td>
					<td>
						The organisation’s legitimate interest in warning its staff and members about their water supply (s11(1)(f)). The
						organisation decides which alerts its catchment sends; you choose right away, daily or off, and every email has a one-click
						unsubscribe, which is your objection. Alerts are service messages: they never advertise anything.
					</td>
				</tr>
				<tr><td>Your answer to “Was this useful?” on an alert email, so the organisation can make its alerts better</td><td>The organisation’s legitimate interest in useful alerts; answering is up to you</td></tr>
				<tr><td>The project’s history, notes, sign-offs and published results</td><td>The organisation’s legitimate interest in a reproducible record of its decisions and the evidence behind them (s11(1)(f))</td></tr>
				<tr><td>Stopping password guessing, spam and abuse; keeping the service running</td><td>Our legitimate interest in a secure service</td></tr>
			</tbody>
		</table>
	</div>
	<p>We do not sell personal information, use it for advertising, or make decisions about you by automated means alone.</p>
	<h3>Do you have to give it?</h3>
	<p>
		No law requires you to give us personal information, and using the service is voluntary. An email address, a name and a
		password are needed to create an account: without them we can’t give you one. Everything else is up to you or the organisation
		that invited you; leaving it out only means the service can show you less (for example, no alert emails without an address to
		send them to).
	</p>

	<h2 id="sharing">5. Who can see it</h2>
	<ul>
		<li>
			<strong>Other people in your projects,</strong> according to their role: owners and editors see the members, their roles and
			the project’s history; a farmer sees only their own farm, and never a neighbour’s name. Editors see the answers to “Was this
			useful?” on the project’s alert emails, counted, and the comments, without the name of who gave them.
		</li>
		<li>
			<strong>Anyone with a share link</strong> sees only what that link opens: a catchment’s published results, a submitted
			licence application, or an issued evidence pack, never a farm’s figures, a name or a private note. Two things on those pages
			do name people: a comment you post for public participation shows with your display name, and an evidence pack shows the
			names and registrations of the professionals who signed it, as its public verify page does.
		</li>
		<li>
			<strong>The applicant, when you comment publicly on their licence application</strong> (in the app or through a share link of
			the application or its evidence pack): your comment, your display name and when you posted it go into the record of public
			comments the applicant downloads for their public participation report to the responsible authority (GN R267 reg 19), as do
			any comment you withdraw or a moderator removes (its words go to the assessors only). Your email goes with them only if you tick
			“Give my name and email to the applicant for the register of interested and affected parties” (GN R267 reg 18), which the
			applicant must keep while the application is considered and for two years after a licence is granted. Once the applicant has
			downloaded it, that copy is theirs to keep and protect. Commenting through a link needs an account but no role in the project:
			the account reads only what the link shows.
		</li>
		<li>
			<strong>Registered water use</strong> (such as WARMS records): a registered user’s name is shown only to the organisation’s
			editors and owners and to the farmer linked to that farm. Registered volumes for each farm are shown to the organisation’s
			editors and owners (and its viewers only if it allows that). Share links and evidence packs never show a name, and show other
			farms’ volumes only as totals.
		</li>
		<li>
			<strong>Our service providers</strong>, who process information only on our instructions: Amazon Web Services (hosting, the
			database, file storage, sending email, and logs).
		</li>
		<li><strong>Authorities,</strong> if the law requires it. We will tell you unless the law forbids it.</li>
	</ul>
	<p>
		The rainfall and river-flow services the model reads (such as CHIRPS and the Department of Water and Sanitation) receive no
		personal information.
	</p>

	<h2 id="where">6. Where it is kept</h2>
	<p>
		The service runs on Amazon Web Services in its Cape Town region (af-south-1), so your information is stored in South Africa.
		Two AWS services that carry traffic to it (the content-delivery network and its firewall) work worldwide, but they only pass
		requests through; they don’t store your information.
	</p>
	<p>
		We run the service from the United States, so when we operate or support it, information may be accessed from there. POPIA
		allows this (s72): it is needed to provide the service you asked for (s72(1)(c) and (d)), and Amazon Web Services is bound by
		a written agreement to protect it to a standard at least as high as POPIA’s (s72(1)(a)). We access it only as needed, under the
		safeguards in section 9.
	</p>

	<h2 id="retention">7. How long we keep it</h2>
	<ul>
		<li><strong>Your account and settings:</strong> until the account is deleted.</li>
		<li><strong>Links in emails:</strong> a password-reset link lasts 1 hour, a confirmation link 48 hours, an invitation 7 days (then it is kept, marked expired, for 90 days and deleted).</li>
		<li><strong>Sign-in attempts and wrong two-step sign-in codes:</strong> forgotten after a day without attempts. <strong>Account-email counts:</strong> 24 hours.</li>
		<li><strong>Two-step sign-in:</strong> the key and recovery codes until you turn it off (a used recovery code is deleted at once); the record of when you turned it on or off until the account is deleted.</li>
		<li><strong>Alert emails sent:</strong> 180 days. <strong>Report files:</strong> 7 days. <strong>Server logs:</strong> 30 days.</li>
		<li>
			<strong>Feedback on alert emails:</strong> an answer and its comment, 1 year after you gave it. A “Was this useful?” link works
			for 30 days, and the record that it was sent to you is deleted then if you didn’t answer.
		</li>
		<li>
			<strong>A project’s content and history</strong> (notes, sign-offs, published results, the record of changes): for as long
			as the project exists, as its audit trail. Deleting a project deletes them, except that a project that has put a run forward
			as evidence or issued a licensing evidence pack can’t be deleted: it is kept as that licence record until three years after
			the licence expires, or three years after the application is refused or withdrawn. Until the outcome is recorded, the
			organisation must confirm every five years that the record is still needed. Then the record is deleted, once the
			organisation responsible for the project confirms it. Model runs are pruned as a project goes on: its newest 12 published
			results and 20 unpublished runs are kept.
		</li>
		<li>
			<strong>A deleted note:</strong> hidden at once; its text is kept for 90 days, so a mistake or a complaint can be looked into,
			then erased. The project’s history still shows that a note was deleted, by whom and when. A note on a submitted licence
			application or an issued evidence pack is part of that licence record: it stays hidden and is kept with the record (below).
		</li>
		<li><strong>Background jobs and report requests:</strong> 30 days after they finish. <strong>Earlier versions of uploaded data:</strong> 180 days, or the last 5 versions.</li>
		<li>
			<strong>Backups:</strong> an encrypted copy of the database, kept for up to 35 days and then deleted automatically, so
			deleted information remains in them until they expire. Backups are used only to recover from a fault. Before a restored copy
			is used, we delete again everything that was deleted after the backup was made: we keep a list of deleted accounts and
			projects (their internal number only) for 40 days for this. If the service is shut down for good, one final encrypted copy
			is kept for 90 days, so organisations can ask for their projects back, and then deleted.
		</li>
	</ul>
	<p>
		When your account is deleted, your name is removed from the project history (it reads “Deleted user”), as is the partly
		hidden email address in invitation entries. The entries themselves stay, because they are the project’s record of who
		changed what, and are deleted with the project. What you made for a
		project (the project itself, a team, model runs, a run put forward as evidence, uncertainty results, scenarios, a licence
		application you submitted, an import) stays as the project’s record, with your name removed. It is never put in someone
		else’s name. An uncertainty result you started and never finished, and a licence application still in draft, are deleted
		with the account, unless the project already relies on the draft (for example, it has public comments).
	</p>
	<p>
		Two things keep your name, because they are a signature or a record handed to others: a sign-off’s typed name and
		registration, and the names printed in an evidence pack (who made its runs and, for an application, who applied), which
		can’t be changed without breaking the pack’s seal. Both are kept only as long as the project they belong to, and in a
		licence record only until three years after the licence expires, or three years after the application is refused or
		withdrawn. Until the outcome is recorded, the organisation must confirm every five years that the record is still needed.
		Then the record is deleted.
	</p>
	<p>
		If you are the only owner of a project or the only admin of a team, someone else needs to take that role before the account
		is deleted; the account page (or we) will tell you if that applies, and you or the project’s other members can hand it over.
	</p>

	<h2 id="cookies">8. Cookies and your browser</h2>
	<p>We use three cookies, all strictly necessary, so there is nothing to opt into:</p>
	<ul>
		<li><code>wm_session</code>: keeps you signed in (up to 7 days).</li>
		<li><code>wm_mfa</code>: with two-step sign-in on, holds your sign-in for up to 5 minutes between your password and your code.</li>
		<li><code>wm_device</code>: remembers, for up to 180 days, that this browser proved it can reach your inbox, so someone guessing your password can’t lock you out.</li>
	</ul>
	<p>Your browser also keeps some things on your device, in its own storage:</p>
	<ul>
		<li>your language choice and a few display settings (such as a collapsed panel);</li>
		<li>
			on a farmer’s phone, a copy of the farm’s latest figures, so the farm page opens without a signal; it is removed after 30
			days unused, and the farm page’s “Don’t keep a copy on this phone” turns it off;
		</li>
		<li>after you sign up, the address the confirmation link went to, so the sign-in page can show it, until you sign in or close the tab.</li>
	</ul>
	<p>None of this is sent to anyone else or used to track you.</p>

	<h2 id="security">9. How we protect it</h2>
	<p>
		Connections are encrypted. Passwords are stored only as a strong one-way hash, and the links we email are stored only as hashes
		too. You can add two-step sign-in (a code from an authenticator app after your password); its key is stored encrypted and its
		recovery codes only as hashes, and project owners, team admins and assessors must use it. The database itself enforces who can see each project’s rows, so one organisation’s information can’t reach another’s.
		Access to the systems is limited to what running the service needs. If a breach affects your personal information, we will
		tell you and the Information Regulator as POPIA s22 requires.
	</p>

	<h2 id="rights">10. Your rights</h2>
	<p>Under POPIA (and similar laws elsewhere) you may:</p>
	<ul>
		<li>
			<strong>Get a copy</strong> of your information. Signed in, go to Account → Your data → <strong>Download my data</strong> for
			everything we hold about you, as a file, straight away.
		</li>
		<li><strong>Correct it.</strong> You can change your name and settings on your account page; ask the project’s owner, or us, for anything else.</li>
		<li>
			<strong>Have it deleted.</strong> Signed in, go to Account → <strong>Delete my account</strong> to delete it yourself, straight
			away. Or email us from your account’s address (or ask in any other way that suits you) and we will delete the account as soon
			as we reasonably can. Either way it is deleted as described in section 7, and we email you what we did.
		</li>
		<li>
			<strong>Object</strong> to our or an organisation’s using your information for a legitimate interest: turn off an alert from any
			alert email or your alert settings, leave a project to remove yourself (and a farmer’s farm link) from it, or tell us or the
			organisation why you object.
		</li>
	</ul>
	<p>
		We answer requests within 30 days, and may ask you to confirm the request from your account’s email address first. Requests
		about a project’s content may be passed to the organisation responsible for it (section 2).
	</p>

	<h2 id="children">11. Children</h2>
	<p>The service is for adults working with water. It is not meant for anyone under 18, and we do not knowingly hold a child’s information.</p>

	<h2 id="changes">12. Changes to this notice</h2>
	<p>
		If we change this notice, we will update the date at the top. If a change affects how your information is used in a
		significant way, we will email account holders before it takes effect.
	</p>

	<h2 id="contact">13. Contact and complaints</h2>
	<p>
		Jared Howard, information officer<br />
		<a href="mailto:jared@jaredhoward.com">jared@jaredhoward.com</a>
	</p>
	<p>
		If you are not satisfied with our answer, you may complain to the Information Regulator (South Africa):
		<a href="https://inforegulator.org.za" rel="noopener noreferrer">inforegulator.org.za</a>,
		<a href="mailto:POPIAComplaints@inforegulator.org.za">POPIAComplaints@inforegulator.org.za</a>.
	</p>
	<p>See also our <a href="{base}/terms">Terms of use</a>.</p>
</LegalPage>
