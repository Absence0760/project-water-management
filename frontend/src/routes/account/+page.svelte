<script lang="ts">
	// The account page (WP-1.9): display name, email and whether it's
	// confirmed, language and volume unit (WP-2.5), and changing the password
	// while signed in, and a link to the alert emails page (WP-2.13). The header's account menu links here. docs/ui.md § App
	// header and account menu, § Language. Its words come from $lib/i18n.
	import { base } from '$app/paths';
	import { api, ApiError } from '$lib/api';
	import { passwordProblem } from '$lib/api/emailAuth';
	import { session } from '$lib/auth/session.svelte';
	import EmailText from '$lib/components/common/EmailText.svelte';
	import PasswordInput from '$lib/components/common/PasswordInput.svelte';
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
			nameError = t('account.nameEmpty');
			return;
		}
		if (name.length > 100) {
			nameError = t('account.nameTooLong');
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
			passwordError = t('account.currentEmpty');
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
				passwordError = t('account.currentWrong');
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

<svelte:head><title>{t('common.pageTitle', { page: t('account.title') })}</title></svelte:head>

<main class="page account">
	<h1>{t('account.title')}</h1>

	{#if session.user}
		<section class="panel" aria-labelledby="profile-h">
			<h2 id="profile-h">{t('account.profile')}</h2>
			<dl class="facts">
				<div>
					<dt>{t('common.email')}</dt>
					<dd><EmailText email={session.user.email} /></dd>
				</div>
				<div>
					<dt>{t('account.status')}</dt>
					<dd>
						{#if session.user.emailVerified}
							<span class="badge badge-owner">{t('account.confirmed')}</span>
						{:else}
							<span class="badge badge-warn">{t('account.notConfirmed')}</span>
							<span class="muted note">{t('account.notConfirmedHelp')}</span>
						{/if}
					</dd>
				</div>
			</dl>
			<form onsubmit={saveName} novalidate>
				{#if nameError}<div class="alert alert-error" role="alert" id="name-error">{nameError}</div>{/if}
				<div class="field">
					<label for="display-name">{t('common.displayName')}</label>
					<input
						id="display-name"
						autocomplete="name"
						maxlength="100"
						aria-invalid={nameError ? 'true' : undefined}
						aria-describedby={nameError ? 'name-error name-hint' : 'name-hint'}
						bind:value={displayName}
						oninput={() => (nameSaved = false)}
					/>
					<span class="hint" id="name-hint">{t('account.nameHint')}</span>
				</div>
				<div class="actions">
					<button class="btn btn-primary" type="submit" disabled={savingName || !nameChanged}>
						{savingName ? t('common.saving') : t('account.saveName')}
					</button>
					<p class="status" role="status" aria-live="polite">{nameSaved ? t('account.nameSaved') : ''}</p>
				</div>
			</form>
		</section>

		<section class="panel" aria-labelledby="prefs-h">
			<h2 id="prefs-h">{t('account.preferences')}</h2>
			<div class="pref">
				<p class="pref-label">{t('common.language')}</p>
				<LanguageSwitch />
				<p class="hint">{t('account.languageHint')}</p>
			</div>
			<fieldset class="pref">
				<legend class="pref-label">{t('account.unit')}</legend>
				{#if unitError}<div class="alert alert-error" role="alert">{unitError}</div>{/if}
				<label class="radio">
					<input type="radio" name="volume-unit" value="m3" checked={(session.user.volumeUnit ?? 'm3') === 'm3'} onchange={() => chooseUnit('m3')} />
					{t('account.unitM3')}
				</label>
				<label class="radio">
					<input type="radio" name="volume-unit" value="ML" checked={session.user.volumeUnit === 'ML'} onchange={() => chooseUnit('ML')} />
					{t('account.unitML')}
				</label>
				<p class="status" role="status" aria-live="polite">{unitSaved ? t('account.unitSaved') : ''}</p>
			</fieldset>
		</section>

		<section class="panel" aria-labelledby="alerts-h">
			<h2 id="alerts-h">{t('account.alerts')}</h2>
			<p class="muted intro">{t('account.alertsHint')}</p>
			<p><a href="{base}/account/alerts">{t('account.alertsLink')}</a></p>
		</section>

		<section class="panel" aria-labelledby="password-h">
			<h2 id="password-h">{t('account.password')}</h2>
			<p class="muted intro">{t('account.passwordIntro')}</p>
			<form onsubmit={changePassword} novalidate>
				{#if passwordError}<div class="alert alert-error" role="alert" id="password-error">{passwordError}</div>{/if}
				<div class="field">
					<label for="current-password">{t('account.currentPassword')}</label>
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
					<label for="new-password">{t('common.newPassword')}</label>
					<PasswordInput
						id="new-password"
						autocomplete="new-password"
						maxlength={200}
						aria-invalid={passwordErrorField === 'next' ? 'true' : undefined}
						aria-describedby={passwordErrorField === 'next' ? 'password-error new-password-hint' : 'new-password-hint'}
						bind:value={next}
					/>
					<span class="hint" id="new-password-hint">{t('account.passwordHint')}</span>
				</div>
				<div class="field">
					<label for="repeat-password">{t('common.repeatNewPassword')}</label>
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
						{changing ? t('account.changing') : t('account.change')}
					</button>
					<p class="status" role="status" aria-live="polite">{passwordChanged ? t('account.changed') : ''}</p>
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
	@media (max-width: 480px) {
		.facts div {
			grid-template-columns: 1fr;
			gap: 0.1rem;
		}
	}
</style>
