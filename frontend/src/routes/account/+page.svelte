<!-- i18n-section: account -->
<script lang="ts">
	// The account page (WP-1.9): display name, email and whether it's
	// confirmed, language and volume unit (WP-2.5), and changing the password
	// while signed in, two-step sign-in (issue #282, TwoStepSignIn), a link to the alert emails page (WP-2.13), with a
	// banner when SES stopped delivering to the address (alert emails paused
	// until the person turns them back on), "download my data" (POPIA,
	// GET /auth/me/export) and "delete my account" (issue #112, DELETE
	// /auth/me, components/account/DeleteAccount.svelte). The header's account menu links here. docs/ui.md § App
	// header and account menu, § Language. Its words come from $lib/i18n.
	import { tick } from 'svelte';
	import { base } from '$app/paths';
	import { PUBLIC_API_URL } from '$env/static/public';
	import { api, ApiError } from '$lib/api';
	import { passwordProblem } from '$lib/api/emailAuth';
	import { session } from '$lib/auth/session.svelte';
	import ChunkFailed from '$lib/components/common/ChunkFailed.svelte';
	import DeleteAccount from '$lib/components/account/DeleteAccount.svelte';
	import EmailText from '$lib/components/common/EmailText.svelte';
	import PasswordInput from '$lib/components/common/PasswordInput.svelte';
	import { resumeProblem, suppressedText } from '$lib/components/alerts/words';
	import LanguageSwitch from '$lib/i18n/LanguageSwitch.svelte';
	import TwoStepSignIn from '$lib/components/account/TwoStepSignIn.svelte';
	import { t } from '$lib/i18n/locale.svelte';
	import { errorText } from '$lib/i18n/apiError';

	const msg = errorText;

	// The header's avatar: the display name's initials, as the account menu shows them.
	const initials = $derived(
		(session.user?.displayName ?? '')
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((w) => w[0]!.toUpperCase())
			.join('') || '?'
	);

	// ---- Display name ----
	let displayName = $state(session.user?.displayName ?? '');
	let savingName = $state(false);
	let nameError = $state<string | null>(null);
	let nameSaved = $state(false);
	const nameChanged = $derived(displayName.trim() !== (session.user?.displayName ?? ''));

	async function saveName(e: SubmitEvent) {
		e.preventDefault();
		nameSaved = false;
		const name = displayName.trim();
		if (!name) {
			nameError = t('Enter a display name.');
			return;
		}
		if (name.length > 100) {
			nameError = t('Use at most 100 characters.');
			return;
		}
		nameError = null;
		savingName = true;
		try {
			session.user = await api.auth.updateMe({ displayName: name });
			displayName = session.user.displayName;
			nameSaved = true;
		} catch (err) {
			nameError = msg(err);
		} finally {
			savingName = false;
		}
	}

	// ---- Volume unit (the farm view's) ----
	// The radios show `unit`, not the session's value directly: a radio the
	// person picked stays picked in the DOM whatever the markup says, so a
	// failed save has to put the choice back itself. The radios stay live while
	// a choice saves (disabling one drops the keyboard's focus). Saves go to the
	// server one after another, in the order they were made, so the session
	// always holds the server's latest answer; only the last choice's answer
	// moves the radios or says Saved, so a quick m³ → ML → m³ can't end on ML.
	let unit = $state<'m3' | 'ML'>(session.user?.volumeUnit ?? 'm3');
	let unitSaved = $state(false);
	let unitError = $state<string | null>(null);
	let unitSeq = 0;
	let unitQueue: Promise<void> = Promise.resolve();
	function chooseUnit(volumeUnit: 'm3' | 'ML'): Promise<void> {
		const seq = ++unitSeq;
		unitSaved = false;
		unitError = null;
		unitQueue = unitQueue.then(async () => {
			try {
				session.user = await api.auth.updateMe({ volumeUnit });
				if (seq !== unitSeq) return;
				unitSaved = true;
			} catch (err) {
				if (seq !== unitSeq) return;
				unitError = msg(err);
			}
			unit = session.user?.volumeUnit ?? 'm3';
		});
		return unitQueue;
	}

	// ---- Alert emails paused (SES suppressed the address) ----
	let resuming = $state(false);
	let resumed = $state(false);
	let resumeError = $state<string | null>(null);
	let alertsHeading: HTMLHeadingElement | undefined = $state();
	async function resumeMail() {
		resuming = true;
		resumeError = null;
		try {
			await api.alerts.resume();
			if (session.user) session.user = { ...session.user, mailSuppressed: null };
			resumed = true;
			// The banner, and the button just pressed, are gone: focus the section's
			// title, just above the "back on" status, not the top of the page (WCAG 2.4.3).
			await tick();
			alertsHeading?.focus();
		} catch (err) {
			resumeError = resumeProblem(err);
		} finally {
			resuming = false;
		}
	}

	// ---- Download my data (GET /auth/me/export) ----
	// The download helpers load on click, so the page chunk stays lean.
	let exporting = $state(false);
	let exportError = $state<string | null>(null);
	/** The download code's chunk didn't arrive: only a reload can fetch it (common/lazy.ts). */
	let exportChunkFailed = $state(false);
	let exported = $state(false);
	async function downloadData() {
		exported = false;
		exportError = null;
		exportChunkFailed = false;
		exporting = true;
		try {
			let download: typeof import('$lib/export/download');
			try {
				download = await import('$lib/export/download');
			} catch {
				exportChunkFailed = true;
				return;
			}
			const { blob, filename } = await download.fetchDownload(`${PUBLIC_API_URL}/auth/me/export`);
			download.saveBlob(blob, filename);
			exported = true;
		} catch (err) {
			// 429 (one a minute) and anything else: the server's message says what to do.
			exportError = msg(err);
		} finally {
			exporting = false;
		}
	}

	// ---- Password ----
	let current = $state('');
	let next = $state('');
	let repeat = $state('');
	let changing = $state(false);
	let passwordError = $state<string | null>(null);
	// Which field the error is about, so it gets aria-invalid and points at the message.
	let passwordErrorField = $state<'current' | 'next' | null>(null);
	let passwordChanged = $state(false);

	async function changePassword(e: SubmitEvent) {
		e.preventDefault();
		passwordChanged = false;
		if (!current) {
			passwordError = t('Enter your current password.');
			passwordErrorField = 'current';
			return;
		}
		const problem = passwordProblem(next, repeat);
		if (problem) {
			passwordError = t(problem);
			passwordErrorField = 'next';
			return;
		}
		passwordError = null;
		passwordErrorField = null;
		changing = true;
		try {
			// The server signs out every other session and gives this browser a fresh cookie.
			session.user = await api.auth.changePassword(current, next);
			current = next = repeat = '';
			passwordChanged = true;
		} catch (err) {
			if (err instanceof ApiError && err.status === 403) {
				passwordError = t('Your current password is wrong.');
				passwordErrorField = 'current';
			} else {
				// 429 (the sign-in lockout) and anything else, worded from the error's code (docs/api.md § Errors).
				passwordError = msg(err);
				passwordErrorField = null;
			}
		} finally {
			changing = false;
		}
	}
</script>

<svelte:head><title>{t('{page} · Water Management', { page: t('Account') })}</title></svelte:head>

<main class="page account">
	<section class="page-head" aria-labelledby="account-h">
		<h1 id="account-h">{t('Account')}</h1>
		{#if session.user}
			<div class="identity">
				<span class="avatar" aria-hidden="true">{initials}</span>
				<div class="who">
					<p class="name">{session.user.displayName}</p>
					<dl class="facts">
						<div>
							<dt class="visually-hidden">{t('Email')}</dt>
							<dd class="email"><EmailText email={session.user.email} /></dd>
						</div>
						<div>
							<dt class="visually-hidden">{t('Status')}</dt>
							<dd>
								{#if session.user.emailVerified}
									<span class="badge badge-owner">{t('Confirmed')}</span>
								{:else}
									<span class="badge badge-warn">{t('Not confirmed')}</span>
								{/if}
							</dd>
						</div>
					</dl>
					{#if !session.user.emailVerified}
						<p class="muted note">{t('Use the link we emailed you. The banner above can send it again.')}</p>
					{/if}
				</div>
			</div>
		{/if}
	</section>

	{#if session.user}
		<div class="cols">
			<div class="col">
				<section class="panel" aria-labelledby="profile-h">
					<h2 id="profile-h">{t('Profile')}</h2>
					<form onsubmit={saveName} novalidate>
						{#if nameError}<div class="alert alert-error" role="alert" id="name-error">{nameError}</div>{/if}
						<div class="field">
							<label for="display-name">{t('Display name')}</label>
							<div class="inline">
								<input
									id="display-name"
									autocomplete="name"
									maxlength="100"
									aria-invalid={nameError ? 'true' : undefined}
									aria-describedby={nameError ? 'name-error name-hint' : 'name-hint'}
									bind:value={displayName}
									oninput={() => (nameSaved = false)}
								/>
								<button class="btn btn-primary" type="submit" disabled={savingName || !nameChanged}>
									{savingName ? t('Saving…') : t('Save name')}
								</button>
							</div>
							<span class="hint" id="name-hint">{t('Shown to people you share projects and teams with.')}</span>
						</div>
						<p class="status" role="status" aria-live="polite">{nameSaved ? t('Name saved.') : ''}</p>
					</form>
				</section>

				<section class="panel" aria-labelledby="password-h">
					<h2 id="password-h">{t('Password')}</h2>
					<p class="muted intro">{t('Changing your password signs you out on every other device. This browser stays signed in.')}</p>
					<form onsubmit={changePassword} novalidate>
						{#if passwordError}<div class="alert alert-error" role="alert" id="password-error">{passwordError}</div>{/if}
						<div class="field">
							<label for="current-password">{t('Current password')}</label>
							<PasswordInput
								id="current-password"
								autocomplete="current-password"
								maxlength={200}
								aria-invalid={passwordErrorField === 'current' ? 'true' : undefined}
								aria-describedby={passwordErrorField === 'current' ? 'password-error' : undefined}
								bind:value={current}
							/>
						</div>
						<div class="pair">
							<div class="field">
								<label for="new-password">{t('New password')}</label>
								<PasswordInput
									id="new-password"
									autocomplete="new-password"
									maxlength={200}
									aria-invalid={passwordErrorField === 'next' ? 'true' : undefined}
									aria-describedby={passwordErrorField === 'next' ? 'password-error new-password-hint' : 'new-password-hint'}
									bind:value={next}
								/>
								<span class="hint" id="new-password-hint">{t('At least 8 characters.')}</span>
							</div>
							<div class="field">
								<label for="repeat-password">{t('Repeat new password')}</label>
								<PasswordInput
									id="repeat-password"
									autocomplete="new-password"
									maxlength={200}
									aria-invalid={passwordErrorField === 'next' ? 'true' : undefined}
									aria-describedby={passwordErrorField === 'next' ? 'password-error' : undefined}
									bind:value={repeat}
								/>
							</div>
						</div>
						<div class="actions">
							<button class="btn btn-primary" type="submit" disabled={changing}>
								{changing ? t('Changing…') : t('Change password')}
							</button>
							<p class="status" role="status" aria-live="polite">{passwordChanged ? t('Password changed. Every other device has been signed out.') : ''}</p>
						</div>
					</form>
				</section>

				<TwoStepSignIn />
				<!-- Self-service deletion (issue #112): a small card; its dialog says what goes and what stays, then asks for the password again. -->
				<DeleteAccount />
			</div>

			<div class="col">
				<section class="panel" aria-labelledby="prefs-h">
					<h2 id="prefs-h">{t('Language and units')}</h2>
					<div class="pref">
						<p class="pref-label">{t('Language')}</p>
						<LanguageSwitch segmented />
						<p class="hint">{t('Your hydrological unit pages, the sign-in pages and the emails we send you use this language.')}</p>
					</div>
					<fieldset class="pref">
						<legend class="pref-label">{t('Volumes on your hydrological unit pages')}</legend>
						{#if unitError}<div class="alert alert-error" role="alert">{unitError}</div>{/if}
						<div class="radios">
							<label class="radio">
								<input type="radio" name="volume-unit" value="m3" bind:group={unit} onchange={() => chooseUnit('m3')} />
								{t('Cubic metres (m³)')}
							</label>
							<label class="radio">
								<input type="radio" name="volume-unit" value="ML" bind:group={unit} onchange={() => chooseUnit('ML')} />
								{t('Megalitres (ML)')}
							</label>
						</div>
						<p class="status" role="status" aria-live="polite">{unitSaved ? t('Saved.') : ''}</p>
					</fieldset>
				</section>

				<section class="panel" aria-labelledby="alerts-h">
					<h2 id="alerts-h" tabindex="-1" bind:this={alertsHeading}>{t('Alert emails')}</h2>
					{#if session.user.mailSuppressed}
						<div class="alert alert-warning suppressed" data-mail-suppressed={session.user.mailSuppressed.reason}>
							<p>{suppressedText(session.user.mailSuppressed, session.user.email)}</p>
							<p>{t('Once {email} can receive email again, turn alert emails back on. Your choices are kept.', { email: session.user.email })}</p>
							{#if resumeError}<p class="resume-error" role="alert">{resumeError}</p>{/if}
							<button type="button" class="btn" onclick={resumeMail} disabled={resuming}>
								{resuming ? t('Turning them back on…') : t('Turn alert emails back on')}
							</button>
						</div>
					{/if}
					<p class="status" role="status" aria-live="polite">{resumed ? t('Alert emails are back on.') : ''}</p>
					<p class="muted intro">{t('Choose which alerts you get by email, and how often.')}</p>
					<p class="link-row"><a class="btn" href="{base}/account/alerts">{t('Choose your alert emails')}</a></p>
					<!-- Invitations to accept or decline (issue #136): an account joins nothing it hasn't accepted. -->
					<p class="link-row"><a class="btn" href="{base}/account/invitations">{t('Your invitations')}</a></p>
				</section>

				<section class="panel" aria-labelledby="data-h">
					<h2 id="data-h">{t('Your data')}</h2>
					<p class="muted intro">{t('Download a copy of what we keep about you: your account, the projects and hydrological units you’re linked to, your hydrological units’ figures and registered volumes, notes you wrote, and the history of what you did and what was done about you. It’s a JSON file.')}</p>
					{#if exportError}<div class="alert alert-error" role="alert">{exportError}</div>{/if}
					{#if exportChunkFailed}
						<ChunkFailed text={t('The download could not be loaded. Check your connection, then reload the page.')} reload={t('Reload page')} />
					{/if}
					<div class="actions">
						<button class="btn" type="button" onclick={downloadData} disabled={exporting}>
							{exporting ? t('Preparing…') : t('Download my data')}
						</button>
						<p class="status" role="status" aria-live="polite">{exported ? t('Your data has been downloaded.') : ''}</p>
					</div>
				</section>

			</div>
		</div>
	{/if}
</main>

<style>
	/* The page answers to its own width (the app sidebar takes 240 px), not
	   the window's: two columns of cards from 52rem, one below. */
	.account {
		max-width: 92rem;
		container: account / inline-size;
	}
	/* The title, then who you are as its summary line. */
	.page-head {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.6rem;
		margin-bottom: 1.25rem;
	}
	h1 {
		margin: 0;
	}
	.identity {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-width: 0;
	}
	.avatar {
		flex: none;
		display: inline-grid;
		place-items: center;
		width: 44px;
		height: 44px;
		border-radius: 50%;
		background: var(--accent-soft);
		color: var(--accent);
		font-size: 0.95rem;
		font-weight: 700;
	}
	.who {
		min-width: 0;
	}
	.name {
		margin: 0;
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.facts {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.6rem;
		margin: 0.1rem 0 0;
		font-size: 0.9rem;
	}
	.facts dd {
		margin: 0;
	}
	.email {
		color: var(--text-2);
		overflow-wrap: anywhere;
	}
	.note {
		margin: 0.25rem 0 0;
		font-size: 0.85rem;
		max-width: 50ch;
	}
	.cols {
		display: grid;
		gap: 0 1rem;
		align-items: start;
	}
	@container account (min-width: 52rem) {
		.cols {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	/* Each card answers to its own width too (the password pair below). */
	.panel {
		padding: 1rem 1.1rem 0.75rem;
		container: card / inline-size;
	}
	h2 {
		margin: 0 0 0.75rem;
		font-size: 1.05rem;
	}
	.intro {
		margin: 0 0 0.75rem;
		max-width: 60ch;
	}
	/* Every field in a card lines up on one right edge, capped at 36rem. */
	.field {
		max-width: 36rem;
	}
	/* Display name and its Save button on one row; the button wraps under a
	   narrow input rather than squeezing it. */
	.inline {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.inline input {
		flex: 1 1 14rem;
	}
	/* New and repeat side by side once the card is wide enough for both. */
	.pair {
		display: grid;
		gap: 0 1rem;
		max-width: 36rem;
	}
	.pair .field {
		max-width: none;
	}
	@container card (min-width: 30rem) {
		.pair {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	.pref {
		margin: 0 0 0.75rem;
		padding: 0;
		border: 0;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.35rem;
		min-width: 0;
	}
	.pref-label {
		margin: 0;
		padding: 0;
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.pref .hint {
		margin: 0;
		font-size: 0.8rem;
		color: var(--text-muted);
		max-width: 60ch;
	}
	.radios {
		display: flex;
		flex-wrap: wrap;
		gap: 0 1.5rem;
	}
	/* 32 px rows with a mouse (WCAG 2.5.8 asks 24); 44 px on touch and phones. */
	.radio {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 32px;
	}
	@media (pointer: coarse), (max-width: 640px) {
		.radio {
			min-height: var(--tap);
		}
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
		margin-bottom: 0.25rem;
	}
	.link-row {
		margin: 0 0 0.25rem;
	}
	.link-row .btn {
		text-decoration: none;
	}
	.status {
		margin: 0;
		font-size: 0.9rem;
		color: var(--text-2);
	}
	.status:empty {
		display: none;
	}
	.suppressed {
		margin-bottom: 0.75rem;
	}
	.suppressed p {
		margin: 0 0 0.5rem;
		overflow-wrap: anywhere;
	}
	.resume-error {
		font-weight: 600;
	}
</style>
