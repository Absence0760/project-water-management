<script lang="ts">
	import { onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api, ApiError } from '$lib/api';
	import { emailAuthApi, linkToken, passwordProblem } from '$lib/api/emailAuth';
	import { session } from '$lib/auth/session.svelte';
	import PasswordInput from '$lib/components/common/PasswordInput.svelte';
	import AuthCard from '$lib/components/layout/AuthCard.svelte';

	const emailAuth = emailAuthApi(api);

	// Read once, then drop it from the address bar so it doesn't linger in
	// history or get copied along with the URL.
	const token = linkToken(page.url);
	onMount(() => {
		if (page.url.searchParams.has('token')) replaceState(`${base}/reset-password`, {});
	});

	let password = $state('');
	let confirm = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let linkDead = $state(!token);
	let done = $state(false);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = passwordProblem(password, confirm);
		if (error || !token) return;
		busy = true;
		try {
			await emailAuth.resetPassword(token, password);
			// The server revoked every session, this browser's included.
			session.user = null;
			done = true;
		} catch (err) {
			if (err instanceof ApiError && err.status === 400 && /link/i.test(err.message)) linkDead = true;
			else error = err instanceof Error ? err.message : String(err);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>Choose a new password · Water Management</title>
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<AuthCard title="Choose a new password" subtitle="Pick a password you don’t use anywhere else.">
	{#if done}
		<div class="alert alert-info" role="status">
			Your password has been changed and you’ve been signed out everywhere. Sign in with your new password.
		</div>
		<a class="btn btn-primary" href="{base}/login">Sign in</a>
	{:else if linkDead}
		<div class="alert alert-error" role="alert">
			This reset link is invalid, already used, or older than 1 hour.
		</div>
		<a class="btn btn-primary" href="{base}/forgot-password">Send a new link</a>
	{:else}
		{#if session.user}
			<p class="signed-in">
				You’re signed in as <strong>{session.user.email}</strong>. Setting a new password signs this browser out
				too.
			</p>
		{/if}
		{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
		<form onsubmit={submit}>
			<div class="field">
				<label for="password">New password</label>
				<PasswordInput
					id="password"
					autocomplete="new-password"
					required
					minlength={8}
					maxlength={200}
					aria-describedby="password-hint"
					bind:value={password}
				/>
				<span class="hint" id="password-hint">At least 8 characters. Changing it signs you out on every device.</span>
			</div>
			<div class="field">
				<label for="confirm">Repeat new password</label>
				<PasswordInput id="confirm" autocomplete="new-password" required maxlength={200} bind:value={confirm} />
			</div>
			<button class="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Set new password'}</button>
		</form>
	{/if}
	{#snippet footer()}
		{#if session.user}
			<a href="{base}/">Back to your projects</a>
		{:else}
			<a href="{base}/login">Back to sign in</a>
		{/if}
	{/snippet}
</AuthCard>

<style>
	.signed-in {
		padding: 0.55rem 0.7rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface-2);
		font-size: 0.85rem;
		color: var(--text-2);
		overflow-wrap: anywhere;
	}
</style>
