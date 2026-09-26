<!-- i18n-section: account -->
<script lang="ts">
	// The account page (WP-1.9): display name, email and whether it's
	// confirmed, language and volume unit (WP-2.5), and changing the password
	// while signed in, a link to the alert emails page (WP-2.13), with a
	// banner when SES stopped delivering to the address (alert emails paused
	// until the person turns them back on), and "download my data" (POPIA,
	// GET /auth/me/export). The header's account menu links here. docs/ui.md § App
	// header and account menu, § Language. Its words come from $lib/i18n.
	import { base } from '$app/paths';
	import { PUBLIC_API_URL } from '$env/static/public';
	import { api, ApiError } from '$lib/api';
	import { passwordProblem } from '$lib/api/emailAuth';
	import { session } from '$lib/auth/session.svelte';
	import ChunkFailed from '$lib/components/common/ChunkFailed.svelte';
	import EmailText from '$lib/components/common/EmailText.svelte';
	import PasswordInput from '$lib/components/common/PasswordInput.svelte';
	import { resumeProblem, suppressedText } from '$lib/components/alerts/words';
	import LanguageSwitch from '$lib/i18n/LanguageSwitch.svelte';
	import { t } from '$lib/i18n/locale.svelte';
	import { errorText } from '$lib/i18n/apiError';

	const msg = errorText;

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
	let unitSaved = $state(false);
	let unitError = $state<string | null>(null);
	async function chooseUnit(volumeUnit: 'm3' | 'ML') {
		unitSaved = false;
		unitError = null;
		try {
			session.user = await api.auth.updateMe({ volumeUnit });
			unitSaved = true;
		} catch (err) {
			unitError = msg(err);
		}
	}

	// ---- Alert emails paused (SES suppressed the address) ----
	let resuming = $state(false);
	let resumed = $state(false);
	let resumeError = $state<string | null>(null);
	async function resumeMail() {
		resuming = true;
		resumeError = null;
		try {
			await api.alerts.resume();
			if (session.user) session.user = { ...session.user, mailSuppressed: null };
			resumed = true;
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
	<h1>{t('Account')}</h1>

	{#if session.user}
		<section class="panel" aria-labelledby="profile-h">
			<h2 id="profile-h">{t('Profile')}</h2>
			<dl class="facts">
				<div>
					<dt>{t('Email')}</dt>
					<dd><EmailText email={session.user.email} /></dd>
				</div>
				<div>
					<dt>{t('Status')}</dt>
					<dd>
						{#if session.user.emailVerified}
							<span class="badge badge-owner">{t('Confirmed')}</span>
						{:else}
							<span class="badge badge-warn">{t('Not confirmed')}</span>
							<span class="muted note">{t('Use the link we emailed you. The banner above can send it again.')}</span>
						{/if}
					</dd>
				</div>
			</dl>
			<form onsubmit={saveName} novalidate>
				{#if nameError}<div class="alert alert-error" role="alert" id="name-error">{nameError}</div>{/if}
				<div class="field">
					<label for="display-name">{t('Display name')}</label>
					<input
						id="display-name"
						autocomplete="name"
						maxlength="100"
						aria-invalid={nameError ? 'true' : undefined}
						aria-describedby={nameError ? 'name-error name-hint' : 'name-hint'}
						bind:value={displayName}
						oninput={() => (nameSaved = false)}
					/>
					<span class="hint" id="name-hint">{t('Shown to people you share projects and teams with.')}</span>
				</div>
				<div class="actions">
					<button class="btn btn-primary" type="submit" disabled={savingName || !nameChanged}>
						{savingName ? t('Saving…') : t('Save name')}
					</button>
					<p class="status" role="status" aria-live="polite">{nameSaved ? t('Name saved.') : ''}</p>
				</div>
			</form>
		</section>

		<section class="panel" aria-labelledby="prefs-h">
			<h2 id="prefs-h">{t('Language and units')}</h2>
			<div class="pref">
				<p class="pref-label">{t('Language')}</p>
				<LanguageSwitch />
				<p class="hint">{t('Your farm pages, the sign-in pages and the emails we send you use this language.')}</p>
			</div>
			<fieldset class="pref">
				<legend class="pref-label">{t('Volumes on your farm pages')}</legend>
				{#if unitError}<div class="alert alert-error" role="alert">{unitError}</div>{/if}
				<label class="radio">
					<input type="radio" name="volume-unit" value="m3" checked={(session.user.volumeUnit ?? 'm3') === 'm3'} onchange={() => chooseUnit('m3')} />
					{t('Cubic metres (m³)')}
				</label>
				<label class="radio">
					<input type="radio" name="volume-unit" value="ML" checked={session.user.volumeUnit === 'ML'} onchange={() => chooseUnit('ML')} />
					{t('Megalitres (ML)')}
				</label>
				<p class="status" role="status" aria-live="polite">{unitSaved ? t('Saved.') : ''}</p>
			</fieldset>
		</section>

		<section class="panel" aria-labelledby="alerts-h">
			<h2 id="alerts-h">{t('Alert emails')}</h2>
			{#if session.user.mailSuppressed}
				<div class="alert alert-warning suppressed" data-mail-suppressed={session.user.mailSuppressed.reason}>
					<p>{suppressedText(session.user.mailSuppressed, session.user.email)}</p>
					<p>{t('Once {email} can receive email again, turn alert emails back on. Your choices are kept.', { email: session.user.email })}</p>
					{#if resumeError}<p class="resume-error" role="alert">{resumeError}</p>{/if}
					<button type="button" class="btn btn-sm" onclick={resumeMail} disabled={resuming}>
						{resuming ? t('Turning them back on…') : t('Turn alert emails back on')}
					</button>
				</div>
			{/if}
			<p class="status" role="status" aria-live="polite">{resumed ? t('Alert emails are back on.') : ''}</p>
			<p class="muted intro">{t('Choose which alerts you get by email, and how often.')}</p>
			<p><a href="{base}/account/alerts">{t('Choose your alert emails')}</a></p>
		</section>

		<section class="panel" aria-labelledby="data-h">
			<h2 id="data-h">{t('Your data')}</h2>
			<p class="muted intro">{t('Download a copy of what we keep about you: your account, the projects and farms you’re linked to, your farms’ figures and registered volumes, notes you wrote, and the history of what you did and what was done about you. It’s a JSON file.')}</p>
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
				<div class="actions">
					<button class="btn btn-primary" type="submit" disabled={changing}>
						{changing ? t('Changing…') : t('Change password')}
					</button>
					<p class="status" role="status" aria-live="polite">{passwordChanged ? t('Password changed. Every other device has been signed out.') : ''}</p>
				</div>
			</form>
		</section>
	{/if}
</main>

<style>
	.account {
		max-width: 40rem;
	}
	h1 {
		margin: 0 0 1rem;
	}
	.panel {
		padding: 1rem 1.1rem 0.5rem;
		margin-bottom: 1rem;
	}
	h2 {
		margin: 0 0 0.75rem;
		font-size: 1.1rem;
	}
	.facts {
		display: grid;
		gap: 0.5rem;
		margin: 0 0 1rem;
	}
	.facts div {
		display: grid;
		grid-template-columns: 6rem 1fr;
		gap: 0.75rem;
		align-items: baseline;
	}
	.facts dt {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.facts dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.note {
		display: block;
		margin-top: 0.25rem;
		font-size: 0.85rem;
	}
	.intro {
		margin: 0 0 0.75rem;
		max-width: 60ch;
	}
	.field {
		max-width: 24rem;
	}
	.pref {
		margin: 0 0 1rem;
		padding: 0;
		border: 0;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.35rem;
	}
	.pref-label {
		margin: 0;
		padding: 0;
		font-weight: 500;
		font-size: 0.9rem;
	}
	.radio {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 2.75rem;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
		margin-bottom: 0.75rem;
	}
	.status {
		margin: 0;
		font-size: 0.9rem;
		color: var(--text-2);
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
	@media (max-width: 480px) {
		.facts div {
			grid-template-columns: 1fr;
			gap: 0.1rem;
		}
	}
</style>
