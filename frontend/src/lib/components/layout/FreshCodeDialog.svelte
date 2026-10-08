<script lang="ts">
	// Asks for a code from the authenticator again (licensing positions item 9;
	// docs/ui.md § Evidence packs → Signing; lib/auth/freshCode.svelte.ts). A
	// sign-off, issuing an evidence pack and withdrawing one need a code from
	// the last 10 minutes; the API answered 401 mfa_fresh_code, and once this
	// dialog's code is accepted (POST /auth/mfa/step-up) the action is sent
	// again. With codes by email on (206), "Email me a code instead" sends one
	// (POST /auth/mfa/email/send) and the same field takes it. The workspace's
	// (English). Its own chunk, mounted by routes/+layout.svelte only while it asks.
	import { onDestroy, onMount } from 'svelte';
	import { api, ApiError } from '$lib/api';
	import { answerCode } from '$lib/auth/freshCode.svelte';
	import { resendTimer } from '$lib/auth/resendTimer.svelte';
	import { freshCodeWords, freshSendLabel, sendState } from '$lib/auth/codeMethods';
	import type { MfaMethod } from '$lib/api';
	import Dialog from '$lib/components/common/Dialog.svelte';

	// Which ways the account has: the email button only with codes by email on. Until read (or if it can't be), the app's.
	let methods = $state<MfaMethod[]>(['totp']);
	const words = $derived(freshCodeWords(methods));
	onMount(async () => {
		try {
			methods = (await api.auth.mfa.status()).methods;
		} catch {
			// No status: the app's code (or a recovery code) still works.
		}
	});
	const resend = resendTimer();
	onDestroy(() => resend.stop());
	let sending = $state(false);
	let sent = $state(false);

	async function sendCode() {
		sending = true;
		error = null;
		try {
			const r = await api.auth.mfa.email.send();
			sent = true;
			resend.start(r.resendInSeconds);
		} catch (err) {
			if (err instanceof ApiError && err.code === 'mfa_email_wait') resend.start(Number(err.params?.seconds) || 60);
			error = err instanceof Error ? err.message : 'The email couldn’t be sent.';
		} finally {
			sending = false;
		}
	}

	let open = $state(true);
	let code = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let answered = false;

	function finish(ok: boolean) {
		if (answered) return;
		answered = true;
		open = false;
		answerCode(ok);
	}

	// Escape or the close button: the action stays undone.
	$effect(() => {
		if (!open) finish(false);
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		const value = code.trim();
		if (!value) return;
		busy = true;
		error = null;
		try {
			await api.auth.mfa.stepUp(value);
			finish(true);
		} catch (err) {
			error = err instanceof Error ? err.message : 'That code wasn’t accepted.';
			code = '';
		} finally {
			busy = false;
		}
	}
</script>

<Dialog bind:open title={words.title}>
	<form id="fresh-code-form" onsubmit={submit} data-testid="fresh-code">
		<p>{words.need}</p>
		{#if words.emailButton}
			<p class="send">
				<button type="button" class="btn btn-sm" onclick={sendCode} disabled={sending || resend.left > 0}>
					{freshSendLabel(sendState(sending, resend.left, sent), words.emailButton)}
				</button>
				{#if sent}<span class="fine" role="status">We emailed you a code. It works for 10 minutes.</span>{/if}
			</p>
		{/if}
		<label for="fresh-code-input">Code</label>
		<input
			id="fresh-code-input"
			bind:value={code}
			inputmode="numeric"
			autocomplete="one-time-code"
			maxlength="40"
			aria-describedby="fresh-code-help"
			aria-invalid={error ? 'true' : undefined}
		/>
		<p id="fresh-code-help" class="fine">{words.help}</p>
		{#if error}<p class="alert alert-error" role="alert">{error}</p>{/if}
	</form>
	{#snippet actions()}
		<button type="button" class="btn" onclick={() => finish(false)} disabled={busy}>Cancel</button>
		<button type="submit" form="fresh-code-form" class="btn btn-primary" disabled={busy || !code.trim()}>{busy ? 'Checking…' : 'Continue'}</button>
	{/snippet}
</Dialog>

<style>
	form {
		display: grid;
		gap: 6px;
	}
	label {
		font-weight: 500;
	}
	input {
		font: inherit;
		max-width: 16ch;
		letter-spacing: 0.1em;
	}
	.send {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 10px;
		margin: 0;
	}
	.fine {
		color: var(--text-2);
		font-size: 13px;
		margin: 0;
	}
</style>
