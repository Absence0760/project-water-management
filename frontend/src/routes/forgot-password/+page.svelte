<script lang="ts">
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import { emailAuthApi } from '$lib/api/emailAuth';
	import AuthCard from '$lib/components/layout/AuthCard.svelte';

	const emailAuth = emailAuthApi(api);

	// Prefill from ?email= (e.g. a "Forgot password?" link that carries what was typed).
	let email = $state(page.url.searchParams.get('email') ?? '');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let sentTo = $state<string | null>(null);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			await emailAuth.forgotPassword(email.trim());
			sentTo = email.trim();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Reset your password · Water Management</title></svelte:head>

<AuthCard title="Reset your password">
	{#if sentTo}
		<!-- Same message whether or not the address has an account (no enumeration). -->
		<div class="alert alert-info" role="status">
			<p>If there is an account for <strong>{sentTo}</strong>, we’ve emailed it a link to choose a new password.</p>
			<p>The link works once and expires in 1 hour. Check your spam folder if it doesn’t arrive in a few minutes.</p>
		</div>
		<button type="button" class="btn" onclick={() => (sentTo = null)}>Use a different address</button>
	{:else}
		<p>Enter the email address you signed up with and we’ll send you a link to choose a new password.</p>
		{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
		<form onsubmit={submit}>
			<div class="field">
				<label for="email">Email</label>
				<input id="email" type="email" autocomplete="email" required bind:value={email} />
			</div>
			<button class="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button>
		</form>
	{/if}
	{#snippet footer()}
		Remembered it? <a href="{base}/login">Sign in</a>
	{/snippet}
</AuthCard>

<style>
	.alert p:last-child {
		margin-bottom: 0;
	}
</style>
