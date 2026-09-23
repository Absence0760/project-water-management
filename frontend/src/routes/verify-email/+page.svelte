<script lang="ts">
	// Reached from the confirmation email. Signed-in only (the root layout sends
	// a signed-out visitor to /login?next=… and back here afterwards), so the
	// banner and /auth/me reflect the result straight away.
	import { onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import { emailAuthApi, linkToken } from '$lib/api/emailAuth';
	import { session } from '$lib/auth/session.svelte';

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

<main class="page verify">
	<h1>Confirm your email</h1>
	{#if status === 'working'}
		<p role="status">Confirming your email address…</p>
	{:else if status === 'done'}
		<div class="alert alert-info" role="status">
			Thanks — <strong>{session.user?.email}</strong> is confirmed. Any projects or teams you were invited to are now in your list.
		</div>
		<a class="btn btn-primary" href="{base}/">Go to your projects</a>
	{:else}
		<div class="alert alert-error" role="alert">
			This confirmation link is invalid, already used, or older than 48 hours.
		</div>
		<button type="button" class="btn btn-primary" onclick={resend} disabled={resending}>
			{resending ? 'Sending…' : 'Send a new link'}
		</button>
		<p class="muted resend" role="status" aria-live="polite">{resendMsg ?? ''}</p>
	{/if}
</main>

<style>
	.verify {
		max-width: 560px;
		padding-top: 2rem;
	}
	.resend {
		margin-top: 0.75rem;
	}
</style>
