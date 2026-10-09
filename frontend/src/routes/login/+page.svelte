<!-- i18n-section: login -->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api, ApiError } from '$lib/api';
	import { CAPTCHA_REQUIRED } from '$lib/api/client';
	import { PUBLIC_WAF_CAPTCHA_API_KEY, PUBLIC_WAF_CAPTCHA_SCRIPT_URL } from '$env/static/public';
	import { captchaConfig } from '$lib/auth/wafCaptcha';
	import SignInCaptcha from '$lib/components/auth-extras/SignInCaptcha.svelte';
	import { onDestroy, onMount, tick } from 'svelte';
	import type { MfaMethod } from '$lib/api';
	import { resendTimer } from '$lib/auth/resendTimer.svelte';
	import { firstMode, otherModes, sendState } from '$lib/auth/codeMethods';
	import { emailAuthApi } from '$lib/api/emailAuth';
	import { CONFIRM_EMAIL_KEY, safeNext } from '$lib/auth/redirect';
	import Rich from '$lib/i18n/Rich.svelte';
	import { session } from '$lib/auth/session.svelte';
	import PasswordInput from '$lib/components/common/PasswordInput.svelte';
	import AuthCard from '$lib/components/layout/AuthCard.svelte';
	import { t, tRich } from '$lib/i18n/locale.svelte';
	import { errorText } from '$lib/i18n/apiError';
	import { afterResetAskFailed, resetAsked, type ResetAsked } from '$lib/auth/mfaReset';
	import { fmtStampTime } from '$lib/components/farm/format';

	// Dev-only shortcut to the seeded demo account; never in a production build.
	const DEMO = import.meta.env.DEV ? { email: 'demo@example.com', password: 'demo-password' } : null;

	let email = $state('');
	let password = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	// After a sign-up (issue #57): the account waits for its confirmation
	// link, so this page says where the link went and has the address ready.
	const emailAuth = emailAuthApi(api);
	const justSignedUp = page.url.searchParams.get('confirm') === 'sent';
	// After "Delete my account" (issue #112, components/account/DeleteAccount.svelte).
	const justDeleted = page.url.searchParams.get('deleted') === '1';
	let sentTo = $state<string | null>(null);
	onMount(() => {
		if (!justSignedUp) return;
		try {
			sentTo = sessionStorage.getItem(CONFIRM_EMAIL_KEY);
		} catch {
			sentTo = null;
		}
		if (sentTo && !email) email = sentTo;
	});

	// A correct password for an address that was never confirmed: say so, and
	// offer the link again (the same answer whether or not a mail goes out).
	let unconfirmed = $state<string | null>(null);
	let resending = $state(false);
	let resent = $state<string | null>(null);
	async function resend(address: string) {
		resending = true;
		resent = null;
		try {
			await emailAuth.resendConfirmation(address);
			resent = t('If {email} still needs confirming, a new link is on its way. Check your inbox and spam folder.', { email: address });
		} catch (err) {
			resent = errorText(err);
		} finally {
			resending = false;
		}
	}

	// Carries what was typed, so the reset form starts filled in.
	const forgotHref = $derived(
		`${base}/forgot-password${email.trim() ? `?email=${encodeURIComponent(email.trim())}` : ''}`
	);

	// The WAF's sign-in CAPTCHA (issue #126, $lib/auth/wafCaptcha): null
	// locally and until the deploy sets it, and then the page says to wait.
	const captcha = captchaConfig(PUBLIC_WAF_CAPTCHA_SCRIPT_URL, PUBLIC_WAF_CAPTCHA_API_KEY);
	let puzzle = $state(false);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		await signIn();
	}

	// Two-step sign-in (issue #282): with a second factor on the account, a
	// right password asks for a code next (POST /auth/mfa/verify): from the
	// authenticator app, from an email (206: "Email me a code", POST
	// /auth/mfa/challenge/email), or, if neither can be had, one of the
	// recovery codes. `methods` is what the account has, the app first.
	let step = $state<'password' | 'code'>('password');
	let code = $state('');
	let methods = $state<MfaMethod[]>(['totp']);
	let mode = $state<MfaMethod | 'recovery'>('totp');
	let codeInput: HTMLInputElement | undefined = $state();
	// The emailed code: whether one went out on this step, and the wait before another may.
	let emailSent = $state(false);
	let sending = $state(false);
	const codeTimer = resendTimer();
	onDestroy(() => codeTimer.stop());
	const send = $derived(sendState(sending, codeTimer.left, emailSent));
	const others = $derived(otherModes(methods, mode));

	async function sendEmailCode() {
		sending = true;
		error = null;
		try {
			const sent = await api.auth.mfa.emailSignInCode();
			emailSent = true;
			codeTimer.start(sent.resendInSeconds);
			await tick();
			codeInput?.focus();
		} catch (err) {
			// A code went out moments ago (this step or an earlier sign-in): show its field, and count down to the next.
			if (err instanceof ApiError && err.code === 'mfa_email_wait') {
				emailSent = true;
				codeTimer.start(Number(err.params?.seconds) || 60);
			}
			if (err instanceof ApiError && err.code === 'mfa_challenge_expired') backToPassword();
			error = errorText(err);
		} finally {
			sending = false;
		}
	}

	function backToPassword() {
		step = 'password';
		lost = false;
		asked = null;
		password = '';
		code = '';
		emailSent = false;
		codeTimer.stop();
	}

	async function finish() {
		try {
			sessionStorage.removeItem(CONFIRM_EMAIL_KEY);
		} catch {
			// Nothing kept.
		}
		await goto(safeNext(page.url.searchParams.get('next'), `${base}/`), { replaceState: true });
	}

	async function submitCode(e: SubmitEvent) {
		e.preventDefault();
		if (!code.trim()) {
			error =
				mode === 'recovery'
					? t('Enter one of your recovery codes.')
					: mode === 'email'
						? t('Enter the 6-digit code from the email.')
						: t('Enter the 6-digit code from your authenticator app.');
			return;
		}
		busy = true;
		error = null;
		try {
			const r = await api.auth.mfa.verify(code.trim());
			session.user = r.user;
			await finish();
		} catch (err) {
			// The 5 minutes ran out, or the password was reset meanwhile: back to the first step.
			if (err instanceof ApiError && err.code === 'mfa_challenge_expired') backToPassword();
			error = errorText(err);
		} finally {
			busy = false;
		}
	}

	// Lost the phone and the recovery codes too (205_mfa_recovery): ask for a
	// reset. A confirmation link is emailed; following it starts a 3-day wait
	// (docs/security.md § Two-step sign-in → Recovery). Needs the live
	// challenge, so it is offered only here, after the password.
	let lost = $state(false);
	let asked = $state<ResetAsked | null>(null);
	let lostHeading: HTMLHeadingElement | undefined = $state();
	// Worded for the factor the account has: the phone (the app, or both), or the email alone.
	const lostLabel = $derived(
		methods.includes('totp') ? t('Lost your phone and your recovery codes?') : t('Can’t get the email and lost your recovery codes?')
	);

	async function showLost() {
		lost = true;
		asked = null;
		error = null;
		await tick();
		lostHeading?.focus();
	}

	async function backToCode() {
		lost = false;
		error = null;
		await tick();
		codeInput?.focus();
	}

	async function askReset() {
		busy = true;
		error = null;
		try {
			asked = resetAsked(await api.auth.mfa.reset.request());
		} catch (err) {
			// The 5 minutes ran out: back to the first step, as for a code.
			if (afterResetAskFailed(err) === 'password') {
				step = 'password';
				lost = false;
				password = '';
			}
			error = errorText(err);
		} finally {
			busy = false;
		}
	}

	async function useMode(next: MfaMethod | 'recovery') {
		mode = next;
		code = '';
		error = null;
		await tick();
		codeInput?.focus();
	}

	/** `wafToken`: the retry after a solved puzzle. */
	async function signIn(wafToken?: string) {
		busy = true;
		error = null;
		unconfirmed = null;
		resent = null;
		try {
			const result = await api.auth.login(email.trim(), password, wafToken);
			if ('mfaRequired' in result) {
				step = 'code';
				code = '';
				methods = result.methods;
				mode = firstMode(result.methods);
				emailSent = false;
				lost = false;
				asked = null;
				password = '';
				await tick();
				codeInput?.focus();
				return;
			}
			session.user = result;
			await finish();
		} catch (err) {
			// Too many sign-ins from this network: show the puzzle, once. A
			// retry that gets the answer again (the token was refused) says to wait.
			if (err instanceof ApiError && err.code === CAPTCHA_REQUIRED && captcha && !wafToken) {
				puzzle = true;
				return;
			}
			if (err instanceof ApiError && err.code === 'email_unconfirmed') {
				unconfirmed = email.trim();
				password = '';
				return;
			}
			// A wrong password, a lockout (429) or anything else, worded from the error's code (docs/api.md § Errors).
			error = err instanceof ApiError && err.status === 401 ? t('Wrong email or password.') : errorText(err);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>{t('{page} · Water Management', { page: t('Sign in') })}</title></svelte:head>

<AuthCard title={t('Sign in')} subtitle={t('Welcome back. Sign in to your catchment projects.')}>
	{#if DEMO}
		<div class="demo">
			<span>Demo: <span class="mono">{DEMO.email}</span> / <span class="mono">{DEMO.password}</span></span>
			<button
				type="button"
				class="btn btn-sm"
				onclick={() => {
					email = DEMO.email;
					password = DEMO.password;
				}}>Use demo account</button
			>
		</div>
	{/if}
	{#if justDeleted}
		<div class="notice" role="status" data-account-deleted>
			<p class="notice-title">{t('Your account has been deleted')}</p>
			<p>{t('We emailed you what was deleted and what was kept.')}</p>
		</div>
	{/if}
	{#if justSignedUp && !unconfirmed}
		<div class="notice" role="status">
			<p class="notice-title">{t('Check your email to finish signing up')}</p>
			<p>
				{#if sentTo}
					<Rich text={tRich('We sent a confirmation link to **{email}**. Open it to confirm your address, then sign in here.', { email: sentTo })} />
				{:else}
					{t('We sent you a confirmation link. Open it to confirm your address, then sign in here.')}
				{/if}
			</p>
			<p class="muted">{t('You can’t sign in until your address is confirmed. The link lasts 48 hours.')}</p>
			{#if sentTo}
				<button type="button" class="btn btn-sm" onclick={() => resend(sentTo!)} disabled={resending}>{resending ? t('Sending…') : t('Send the link again')}</button>
			{/if}
			{#if resent}<p class="muted resent">{resent}</p>{/if}
		</div>
	{/if}
	{#if unconfirmed}
		<div class="alert alert-warning" role="alert">
			<p><Rich text={tRich('**Your email address isn’t confirmed yet.** Open the link we emailed to {email}, then sign in again.', { email: unconfirmed })} /></p>
			<button type="button" class="btn btn-sm" onclick={() => resend(unconfirmed!)} disabled={resending}>{resending ? t('Sending…') : t('Send the link again')}</button>
			{#if resent}<p class="resent">{resent}</p>{/if}
		</div>
	{/if}
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
	{#if puzzle && captcha}
		<SignInCaptcha
			config={captcha}
			onsolved={(token) => {
				puzzle = false;
				void signIn(token);
			}}
			onfailed={() => {
				puzzle = false;
				error = errorText(new ApiError(405, 'captcha failed', undefined, CAPTCHA_REQUIRED));
			}}
		/>
	{/if}
	{#if step === 'code' && lost}
		<section class="lost" aria-labelledby="lost-h" data-mfa-lost>
			<h2 id="lost-h" class="step-title" tabindex="-1" bind:this={lostHeading}>{lostLabel}</h2>
			{#if asked?.kind === 'sent'}
				<div class="notice" role="status" data-reset-sent>
					<p class="notice-title">{t('Check your email')}</p>
					<p>{t('We sent a link to the address on your account. Open it within 1 hour to start the 3-day wait. Nothing changes until you do.')}</p>
				</div>
			{:else if asked?.kind === 'pending'}
				<div class="notice" role="status" data-reset-pending>
					<p class="notice-title">{t('Two-step sign-in is already being removed')}</p>
					<p>{t('It will be removed at {when}. Then sign in with your password alone, and set it up again on your Account page.', { when: fmtStampTime(asked.effectiveAt) })}</p>
				</div>
			{:else}
				<p>{t('We can remove two-step sign-in from your account, so you can sign in with your password and set it up again.')}</p>
				<p>{t('To keep your account safe, this takes 3 days. We email you a link to confirm. Once you open it, two-step sign-in is removed 3 days later, and we email you every day until then, so you can cancel it if it wasn’t you.')}</p>
				<p class="muted">{t('If you’re in a team, a team admin can remove it for you straight away.')}</p>
				<button type="button" class="btn btn-primary" onclick={askReset} disabled={busy}>{busy ? t('Sending…') : t('Email me a link')}</button>
			{/if}
			<button type="button" class="linkish" onclick={backToCode}>{t('Back to the code')}</button>
		</section>
	{:else if step === 'code'}
		<form onsubmit={submitCode} novalidate aria-labelledby="code-h" data-mfa-mode={mode}>
			<h2 id="code-h" class="step-title">{t('Two-step sign-in')}</h2>
			{#if mode === 'email'}
				<p class="hint" id="mfa-email-intro">
					{emailSent
						? t('We emailed you a 6-digit code. It works for 10 minutes. Check your spam folder if it isn’t there.')
						: t('We’ll email a 6-digit code to the address you signed in with.')}
				</p>
				<div class="send-row">
					<button type="button" class="btn {emailSent ? '' : 'btn-primary'}" onclick={sendEmailCode} disabled={send.kind !== 'ready'}>
						{#if send.kind === 'sending'}{t('Sending…')}{:else if send.kind === 'wait'}{t('Send again (in {n} s)', { n: send.seconds })}{:else if send.again}{t('Send again')}{:else}{t('Send code')}{/if}
					</button>
				</div>
			{/if}
			{#if mode !== 'email' || emailSent}
				<div class="field">
					{#if mode === 'recovery'}
						<label for="mfa-code">{t('Recovery code')}</label>
						<input id="mfa-code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="40" required bind:this={codeInput} bind:value={code} aria-describedby="mfa-code-hint" />
						<span class="hint" id="mfa-code-hint">{t('One of the codes you saved when you set up two-step sign-in. Each works once.')}</span>
					{:else if mode === 'email'}
						<label for="mfa-code">{t('Code from the email')}</label>
						<input id="mfa-code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" required bind:this={codeInput} bind:value={code} aria-describedby="mfa-email-intro" />
					{:else}
						<label for="mfa-code">{t('Code from your authenticator app')}</label>
						<input id="mfa-code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" required bind:this={codeInput} bind:value={code} aria-describedby="mfa-code-hint" />
						<span class="hint" id="mfa-code-hint">{t('Open the app on your phone and enter the 6-digit code it shows for Water Management.')}</span>
					{/if}
				</div>
				<button class="btn btn-primary" type="submit" disabled={busy}>{busy ? t('Checking…') : t('Sign in')}</button>
			{/if}
			<div class="other-ways">
				{#each others.modes as other (other)}
					<button type="button" class="linkish" onclick={() => useMode(other)}>
						{#if other === 'email'}{t('Email me a code instead')}{:else if other === 'totp'}{t('Use a code from the app instead')}{:else if others.recoveryFor === 'phone'}{t('Lost your phone? Use a recovery code')}{:else}{t('Can’t get the email? Use a recovery code')}{/if}
					</button>
				{/each}
				{#if mode === 'recovery'}
					<button type="button" class="linkish" onclick={showLost} data-mfa-lost-link>{lostLabel}</button>
				{/if}
			</div>
		</form>
	{:else}
	<form onsubmit={submit}>
		<div class="field">
			<label for="email">{t('Email')}</label>
			<input id="email" type="email" autocomplete="email" inputmode="email" required bind:value={email} />
		</div>
		<div class="field">
			<label for="password">{t('Password')}</label>
			<PasswordInput id="password" autocomplete="current-password" required bind:value={password} />
			<a class="forgot" href={forgotHref}>{t('Forgot password?')}</a>
		</div>
		<button class="btn btn-primary" type="submit" disabled={busy}>{busy ? t('Signing in…') : t('Sign in')}</button>
	</form>
	{/if}
	{#snippet footer()}
		{t('No account?')} <a href="{base}/register{page.url.search}">{t('Create one')}</a>
	{/snippet}
</AuthCard>

<style>
	.notice {
		display: grid;
		gap: 0.4rem;
		justify-items: start;
		padding: 0.75rem 0.9rem;
		border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
		border-left: 3px solid var(--accent);
		border-radius: var(--radius);
		background: var(--accent-soft);
		overflow-wrap: anywhere;
	}
	.notice p,
	.alert p {
		margin: 0;
	}
	.notice-title {
		font-weight: 600;
	}
	.alert {
		display: grid;
		gap: 0.5rem;
		justify-items: start;
	}
	.resent {
		font-size: 1rem;
	}
	.forgot {
		align-self: flex-end;
		font-size: 1rem;
		text-decoration: underline;
		/* Comfortable tap target without growing the visible text. */
		padding: 0.35rem 0;
	}
	.step-title {
		margin: 0 0 0.25rem;
		font-size: 1.1rem;
	}
	.hint {
		font-size: 1rem;
		color: var(--text-2);
	}
	.lost {
		display: grid;
		gap: 0.6rem;
		justify-items: start;
	}
	.lost p {
		margin: 0;
	}
	.send-row {
		margin: 0.25rem 0 0.75rem;
	}
	.other-ways {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		margin-top: 0.5rem;
	}
	.linkish {
		align-self: flex-start;
		padding: 0.35rem 0;
		border: 0;
		background: none;
		color: var(--accent);
		font: inherit;
		font-size: 1rem;
		text-decoration: underline;
		cursor: pointer;
	}
	.demo {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		flex-wrap: wrap;
		padding: 0.55rem 0.7rem;
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
		background: var(--surface-2);
		font-size: 1rem;
		color: var(--text-2);
	}
</style>
