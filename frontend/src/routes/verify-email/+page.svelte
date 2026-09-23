<script lang="ts">
	// Reached from the confirmation email. Works signed in or out (the token is
	// the proof); signed in, the banner and session update straight away.
	import { onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import { emailAuthApi, linkToken } from '$lib/api/emailAuth';
	import { session } from '$lib/auth/session.svelte';
	import AuthCard from '$lib/components/layout/AuthCard.svelte';

	const emailAuth = emailAuthApi(api);
	const token = linkToken(page.url);

	let status = $state<'working' | 'done' | 'failed'>(token ? 'working' : 'failed');
	let resendMsg = $state<string | null>(null);
	let resending = $state(false);

	onMount(async () => {
		if (page.url.searchParams.has('token')) replaceState(`${base}/verify-email`, {});
		if (!token) return;
		try {
			await emailAuth.verifyEmail(token);
			if (session.user) session.user = { ...session.user, emailVerified: true };
			status = 'done';
		} catch {
			// A second click on a spent link is fine if the address is verified.
			try {
				session.user = await api.auth.me();
			} catch {
				/* the failure message below still applies */
			}
			status = session.user?.emailVerified ? 'done' : 'failed';
		}
	});

	async function resend() {
		resending = true;
		resendMsg = null;
		try {
			await emailAuth.resendVerification();
			resendMsg = `We’ve sent a new link to ${session.user?.email ?? 'your address'}.`;
		} catch (err) {
			resendMsg = err instanceof Error ? err.message : String(err);
		} finally {
			resending = false;
		}
	}
</script>

<svelte:head>
	<title>Confirm your email · Water Management</title>
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<AuthCard title="Confirm your email">
	{#if status === 'working'}
		<p role="status">Confirming your email address…</p>
	{:else if status === 'done'}
		<div class="alert alert-info" role="status">
			{#if session.user}
				Thanks — <strong>{session.user.email}</strong> is confirmed. Any projects or teams you were invited to are now
				in your list.
			{:else}
				Thanks — your email address is confirmed. Sign in to see any projects or teams you were invited to.
			{/if}
		</div>
		{#if session.user}
			<a class="btn btn-primary" href="{base}/">Go to your projects</a>
		{:else}
			<a class="btn btn-primary" href="{base}/login">Sign in</a>
		{/if}
	{:else}
		<div class="alert alert-error" role="alert">
			This confirmation link is invalid, already used, or older than 48 hours.
		</div>
		{#if session.user}
			<button type="button" class="btn btn-primary" onclick={resend} disabled={resending}>
				{resending ? 'Sending…' : 'Send a new link'}
			</button>
			<p class="muted resend" role="status" aria-live="polite">{resendMsg ?? ''}</p>
		{:else}
			<p>Sign in and use <strong>Resend email</strong> in the banner at the top of the page to get a new link.</p>
			<a class="btn btn-primary" href="{base}/login">Sign in</a>
		{/if}
	{/if}
	{#snippet footer()}
		{#if session.user}
			<a href="{base}/">Back to your projects</a>
		{:else}
			No account yet? <a href="{base}/register">Create one</a>
		{/if}
	{/snippet}
</AuthCard>

<style>
	.resend {
		margin-top: 0.75rem;
	}
</style>
