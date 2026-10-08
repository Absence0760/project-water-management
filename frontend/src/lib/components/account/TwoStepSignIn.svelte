<!-- i18n-section: account.two-step -->
<script lang="ts">
	// Two-step sign-in on the Account page (issue #282; docs/ui.md § Account,
	// docs/security.md § Two-step sign-in). Off: set it up (the password, then
	// a QR code drawn here, or the key typed in, then the first code), and the
	// ten recovery codes, shown once, to download or copy. On: how many
	// recovery codes are left (a warning at two or fewer), a new set, and
	// turning it off, each with a code; and a reset of a lost factor that is
	// waiting (205_mfa_recovery), which a code cancels. Someone whose roles
	// need it (an owner or admin where a project or team requires it, or
	// someone who takes part in licence decisions; GET /auth/mfa `required`)
	// is told so.
	import { onMount, tick } from 'svelte';
	import { api, ApiError, type MfaStatus } from '$lib/api';
	import { mfaStatusSeen } from '$lib/auth/mfaPrompt.svelte';
	import { session } from '$lib/auth/session.svelte';
	import PasswordInput from '$lib/components/common/PasswordInput.svelte';
	import { errorText } from '$lib/i18n/apiError';
	import { t, tn, plural } from '$lib/i18n/locale.svelte';
	import { fewRecoveryCodes, RECOVERY_CODES_FILE, recoveryCodesText } from '$lib/auth/mfaReset';
	import { fmtStampTime } from '$lib/components/farm/format';
	import type { QrDrawing } from './qr';

	// i18n-section: account.two-step.counts
	const CODES_LEFT = plural({ one: '{n} recovery code left.', other: '{n} recovery codes left.' });
	// i18n-section: account.two-step

	let status = $state<MfaStatus | null>(null);
	let loadError = $state<string | null>(null);

	async function load() {
		try {
			status = await api.auth.mfa.status();
			loadError = null;
			// The workspace's prompt (layout/MfaBanner) goes once this read says it's done.
			if (session.user) mfaStatusSeen(session.user.id, status);
		} catch (err) {
			loadError = errorText(err);
		}
	}
	onMount(load);

	// ---- Setting it up ----
	type Setup = { stage: 'password' } | { stage: 'scan'; secret: string; uri: string; qr: QrDrawing | null };
	let setup = $state<Setup | null>(null);
	let password = $state('');
	let code = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	/** Shown once, after turning it on or making a new set. */
	let codes = $state<string[] | null>(null);
	let codesHeading: HTMLHeadingElement | undefined = $state();
	let codeInput: HTMLInputElement | undefined = $state();

	function start() {
		setup = { stage: 'password' };
		password = code = '';
		error = null;
	}

	function cancel() {
		setup = null;
		password = code = '';
		error = null;
	}

	async function sendPassword(e: SubmitEvent) {
		e.preventDefault();
		if (!password) {
			error = t('Enter your current password.');
			return;
		}
		busy = true;
		error = null;
		try {
			const { secret, uri } = await api.auth.mfa.enrol(password);
			password = '';
			setup = { stage: 'scan', secret, uri, qr: null };
			// The QR encoder loads only now (qr.ts): the page chunk doesn't carry it.
			try {
				const { qrDrawing } = await import('./qr');
				if (setup?.stage === 'scan' && setup.uri === uri) setup = { ...setup, qr: qrDrawing(uri) };
			} catch {
				// No picture: the key below can still be typed in.
			}
			await tick();
			codeInput?.focus();
		} catch (err) {
			error = err instanceof ApiError && err.status === 403 ? t('Your current password is wrong.') : errorText(err);
		} finally {
			busy = false;
		}
	}

	async function confirmCode(e: SubmitEvent) {
		e.preventDefault();
		if (!code.trim()) {
			error = t('Enter the 6-digit code from your authenticator app.');
			return;
		}
		busy = true;
		error = null;
		try {
			codes = await api.auth.mfa.confirm(code.trim());
			setup = null;
			code = '';
			await load();
			await tick();
			codesHeading?.focus();
		} catch (err) {
			error = errorText(err);
		} finally {
			busy = false;
		}
	}

	// ---- On: new codes, turning it off ----
	// 'keep': a reset of the factor is waiting (someone said the phone was lost); a code proves it isn't, and cancels it.
	let action = $state<'regenerate' | 'disable' | 'keep' | null>(null);
	let actionCode = $state('');
	let actionError = $state<string | null>(null);
	let done = $state<string | null>(null);

	function choose(a: 'regenerate' | 'disable' | 'keep') {
		action = a;
		actionCode = '';
		actionError = null;
		done = null;
	}

	async function runAction(e: SubmitEvent) {
		e.preventDefault();
		if (!actionCode.trim()) {
			actionError = t('Enter the 6-digit code from your authenticator app.');
			return;
		}
		busy = true;
		actionError = null;
		try {
			if (action === 'regenerate') {
				codes = await api.auth.mfa.regenerate(actionCode.trim());
				action = null;
				await load();
				await tick();
				codesHeading?.focus();
			} else if (action === 'keep') {
				// A code given in the session cancels a waiting reset (POST /auth/mfa/step-up, auth/mfaReset.ts).
				await api.auth.mfa.stepUp(actionCode.trim());
				action = null;
				done = t('The removal is cancelled. Two-step sign-in stays on.');
				await load();
			} else {
				await api.auth.mfa.disable(actionCode.trim());
				action = null;
				codes = null;
				done = t('Two-step sign-in is off.');
				await load();
			}
			actionCode = '';
		} catch (err) {
			actionError = errorText(err);
		} finally {
			busy = false;
		}
	}

	/** The key, in groups of four, as most apps ask for it typed. */
	const grouped = (secret: string) => secret.replace(/(.{4})/g, '$1 ').trim();

	/**
	 * The codes as a text file, through the app's one blob-download helper,
	 * loaded on click: imported statically it would join the page chunk and
	 * take the "Download my data" helper's lazy chunk with it. If it can't
	 * load, say so; no reload (that would lose the codes, shown once), copy them.
	 */
	let downloadFailed = $state(false);
	const codesText = (list: string[]) =>
		recoveryCodesText(
			list,
			t('Water Management recovery codes for {email}', { email: session.user?.email ?? '' }),
			t('Each code works once, in place of a code from your authenticator app.')
		);
	async function downloadCodes() {
		if (!codes) return;
		const text = codesText(codes);
		let download: typeof import('$lib/export/download');
		try {
			download = await import('$lib/export/download');
		} catch {
			downloadFailed = true;
			return;
		}
		downloadFailed = false;
		download.saveBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), RECOVERY_CODES_FILE);
	}

	/** "Copy the codes": the same text as the file, on the clipboard. Says whether it worked; the list stays on screen either way. */
	let copied = $state<'ok' | 'failed' | null>(null);
	async function copyCodes() {
		if (!codes) return;
		try {
			await navigator.clipboard.writeText(codesText(codes));
			copied = 'ok';
		} catch {
			copied = 'failed';
		}
	}
</script>

<section class="panel two-step" id="two-step" aria-labelledby="two-step-h" data-two-step={status ? (status.enrolled ? 'on' : 'off') : 'loading'}>
	<h2 id="two-step-h">{t('Two-step sign-in')}</h2>
	{#if loadError}
		<div class="alert alert-error" role="alert">{loadError}</div>
	{:else if status}
		{#if status.required && !status.enrolled}
			<div class="alert alert-warning required" role="note">
				{t('A project or team you manage requires two-step sign-in, or you take part in licence decisions, which always need it. Set it up here.')}
			</div>
		{/if}

		{#if codes}
			<div class="codes" aria-labelledby="codes-h">
				<h3 id="codes-h" tabindex="-1" bind:this={codesHeading}>{t('Your recovery codes')}</h3>
				<p>{t('Keep these somewhere safe, away from your phone. If you lose your phone, each code signs you in once. They won’t be shown again.')}</p>
				{#if downloadFailed}
					<div class="alert alert-error" role="alert">{t('The download could not be loaded. Copy the codes from the list below instead.')}</div>
				{/if}
				<ul class="code-list mono">
					{#each codes as c (c)}<li>{c}</li>{/each}
				</ul>
				<div class="actions">
					<button type="button" class="btn" onclick={downloadCodes}>{t('Download the codes')}</button>
					<button type="button" class="btn" onclick={copyCodes}>{t('Copy the codes')}</button>
					<button type="button" class="btn btn-primary" onclick={() => ((codes = null), (copied = null))}>{t('I’ve saved them')}</button>
				</div>
				<p class="copied" role="status" aria-live="polite">
					{copied === 'ok' ? t('Copied. Paste them somewhere safe, such as a password manager.') : copied === 'failed' ? t('Copying didn’t work here. Download them, or write them down.') : ''}
				</p>
			</div>
		{/if}

		{#if status.enrolled}
			<p class="state">
				<span class="badge badge-owner">{t('On')}</span>
				{t('Signing in asks for a code from your authenticator app after your password.')}
			</p>
			<p class="muted" data-codes-left={status.recoveryCodesLeft}>{tn(CODES_LEFT, status.recoveryCodesLeft)}</p>
			{#if fewRecoveryCodes(status) && !codes}
				<div class="alert alert-warning few" role="note" data-few-codes>
					<p>{t('You’re running out of recovery codes. Make a new set while you still have your phone, so a lost phone can’t lock you out.')}</p>
					{#if action !== 'regenerate'}
						<button type="button" class="btn btn-sm" onclick={() => choose('regenerate')}>{t('Make a new set')}</button>
					{/if}
				</div>
			{/if}
			{#if status.pendingReset}
				<div class="alert alert-warning" role="alert" data-pending-reset>
					<p>
						{t('Someone asked to remove two-step sign-in from your account because the phone was lost. It will be removed at {when}, unless it’s cancelled.', {
							when: fmtStampTime(status.pendingReset.effectiveAt)
						})}
					</p>
					<p>{t('If that wasn’t you, cancel it now with a code from your authenticator app, then change your password.')}</p>
					{#if action !== 'keep'}
						<button type="button" class="btn btn-sm" onclick={() => choose('keep')}>{t('Cancel the removal')}</button>
					{/if}
				</div>
			{/if}
			{#if !status.sessionVerified}
				<p class="muted">{t('This browser signed in before two-step sign-in was set up. Sign out and in again before an action that needs it.')}</p>
			{/if}
			{#if action}
				<form onsubmit={runAction} novalidate>
					{#if actionError}<div class="alert alert-error" role="alert" id="action-error">{actionError}</div>{/if}
					<div class="field">
						<label for="action-code">
							{action === 'regenerate' || action === 'keep' ? t('Code from your authenticator app') : t('Code from your authenticator app, or a recovery code')}
						</label>
						<input
							id="action-code"
							autocomplete="one-time-code"
							maxlength="40"
							aria-invalid={actionError ? 'true' : undefined}
							aria-describedby={actionError ? 'action-error' : undefined}
							bind:value={actionCode}
						/>
					</div>
					<div class="actions">
						<button class="btn {action === 'disable' ? 'btn-danger' : 'btn-primary'}" type="submit" disabled={busy}>
							{action === 'regenerate' ? t('Make new recovery codes') : action === 'keep' ? t('Cancel the removal') : t('Turn off two-step sign-in')}
						</button>
						<button type="button" class="btn" onclick={() => (action = null)}>{t('Cancel')}</button>
					</div>
				</form>
			{:else}
				<div class="actions">
					<button type="button" class="btn" onclick={() => choose('regenerate')}>{t('New recovery codes')}</button>
					<button type="button" class="btn" onclick={() => choose('disable')}>{t('Turn off')}</button>
				</div>
			{/if}
		{:else if !setup}
			<p class="muted intro">
				{t('Add a second step to signing in: after your password, a 6-digit code from an authenticator app on your phone (such as Google Authenticator, Microsoft Authenticator or Aegis). Someone who learns your password still can’t get in.')}
			</p>
			<div class="actions">
				<button type="button" class="btn btn-primary" onclick={start}>{t('Set up two-step sign-in')}</button>
			</div>
		{:else if setup.stage === 'password'}
			<form onsubmit={sendPassword} novalidate>
				{#if error}<div class="alert alert-error" role="alert" id="setup-error">{error}</div>{/if}
				<div class="field">
					<label for="setup-password">{t('Current password')}</label>
					<PasswordInput id="setup-password" autocomplete="current-password" maxlength={200} bind:value={password} />
				</div>
				<div class="actions">
					<button class="btn btn-primary" type="submit" disabled={busy}>{busy ? t('Checking…') : t('Continue')}</button>
					<button type="button" class="btn" onclick={cancel}>{t('Cancel')}</button>
				</div>
			</form>
		{:else}
			<ol class="steps">
				<li>
					<p>{t('Scan this code with your authenticator app.')}</p>
					{#if setup.qr}
						<!-- Black on white whatever the theme: a scanner needs the contrast, and the quiet zone is part of the code. -->
						<svg class="qr" viewBox="0 0 {setup.qr.size} {setup.qr.size}" role="img" aria-label={t('QR code for your authenticator app')} shape-rendering="crispEdges">
							<rect width={setup.qr.size} height={setup.qr.size} fill="#ffffff" />
							<path d={setup.qr.path} fill="#000000" />
						</svg>
					{/if}
					<p class="muted">{t('Can’t scan it? Type this key into the app instead:')}</p>
					<p class="key mono" data-totp-secret={setup.secret}>{grouped(setup.secret)}</p>
				</li>
				<li>
					<form onsubmit={confirmCode} novalidate>
						{#if error}<div class="alert alert-error" role="alert" id="confirm-error">{error}</div>{/if}
						<div class="field">
							<label for="setup-code">{t('Enter the code the app shows')}</label>
							<input
								id="setup-code"
								inputmode="numeric"
								autocomplete="one-time-code"
								maxlength="10"
								aria-invalid={error ? 'true' : undefined}
								aria-describedby={error ? 'confirm-error' : undefined}
								bind:this={codeInput}
								bind:value={code}
							/>
						</div>
						<div class="actions">
							<button class="btn btn-primary" type="submit" disabled={busy}>{busy ? t('Checking…') : t('Turn on two-step sign-in')}</button>
							<button type="button" class="btn" onclick={cancel}>{t('Cancel')}</button>
						</div>
					</form>
				</li>
			</ol>
		{/if}
		<p class="status" role="status" aria-live="polite">{done ?? ''}</p>
	{/if}
</section>

<style>
	.panel {
		padding: 1rem 1.1rem 0.75rem;
	}
	h2 {
		margin: 0 0 0.75rem;
		font-size: 1.05rem;
	}
	h3 {
		margin: 0 0 0.5rem;
		font-size: 1rem;
	}
	.intro,
	.state,
	.muted {
		margin: 0 0 0.75rem;
		max-width: 60ch;
	}
	.state {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
	.required {
		margin-bottom: 0.75rem;
	}
	.field {
		max-width: 36rem;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
		margin-bottom: 0.75rem;
	}
	.steps {
		margin: 0;
		padding-left: 1.25rem;
	}
	.steps p {
		margin: 0 0 0.5rem;
	}
	.qr {
		display: block;
		width: min(220px, 100%);
		height: auto;
		margin: 0 0 0.75rem;
		border-radius: var(--radius);
	}
	.key {
		margin: 0 0 1rem;
		font-size: 1rem;
		letter-spacing: 0.05em;
		overflow-wrap: anywhere;
	}
	.codes {
		margin: 0 0 1rem;
		padding: 0.75rem 0.9rem;
		border: 1px solid var(--border);
		border-left: 3px solid var(--accent);
		border-radius: var(--radius);
		background: var(--accent-soft);
	}
	.codes p {
		margin: 0 0 0.5rem;
		max-width: 60ch;
	}
	.code-list {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr));
		gap: 0.25rem 1rem;
		margin: 0 0 0.75rem;
		padding: 0;
		list-style: none;
		font-size: 1rem;
	}
	.status {
		margin: 0;
		font-size: 0.9rem;
		color: var(--text-2);
	}
	.status:empty,
	.copied:empty {
		display: none;
	}
	.copied {
		margin: 0;
		font-size: 0.9rem;
	}
	.alert p {
		margin: 0 0 0.5rem;
		max-width: 60ch;
	}
	.few {
		margin-bottom: 0.75rem;
	}
</style>
