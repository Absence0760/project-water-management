<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import { safeNext } from '$lib/auth/redirect';
	import { session } from '$lib/auth/session.svelte';
	import AuthCard from '$lib/components/layout/AuthCard.svelte';

	let email = $state('');
	let password = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			session.user = await api.auth.login(email.trim(), password);
			await goto(safeNext(page.url.searchParams.get('next'), `${base}/`), { replaceState: true });
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Sign in · Water Balance</title></svelte:head>

<AuthCard title="Sign in">
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
	<form onsubmit={submit}>
		<div class="field">
			<label for="email">Email</label>
			<input id="email" type="email" autocomplete="email" required bind:value={email} />
		</div>
		<div class="field">
			<label for="password">Password</label>
			<input id="password" type="password" autocomplete="current-password" required bind:value={password} />
		</div>
		<button class="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
	</form>
	{#snippet footer()}
		No account? <a href="{base}/register{page.url.search}">Create one</a>
	{/snippet}
</AuthCard>
