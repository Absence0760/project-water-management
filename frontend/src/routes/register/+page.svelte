<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import { safeNext } from '$lib/auth/redirect';
	import { session } from '$lib/auth/session.svelte';
	import AuthCard from '$lib/components/layout/AuthCard.svelte';

	let displayName = $state('');
	let email = $state('');
	let password = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		if (password.length < 8 || password.length > 200) {
			error = 'Password must be 8–200 characters.';
			return;
		}
		busy = true;
		try {
			session.user = await api.auth.register(email.trim(), password, displayName.trim());
			await goto(safeNext(page.url.searchParams.get('next'), `${base}/`), { replaceState: true });
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Create account · Water Management</title></svelte:head>

<AuthCard title="Create an account">
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
	<form onsubmit={submit}>
		<div class="field">
			<label for="name">Display name</label>
			<input id="name" autocomplete="name" required maxlength="100" bind:value={displayName} />
		</div>
		<div class="field">
			<label for="email">Email</label>
			<input id="email" type="email" autocomplete="email" required bind:value={email} />
		</div>
		<div class="field">
			<label for="password">Password</label>
			<input
				id="password"
				type="password"
				autocomplete="new-password"
				required
				minlength="8"
				maxlength="200"
				aria-describedby="pw-hint"
				bind:value={password}
			/>
			<span class="hint" id="pw-hint">At least 8 characters.</span>
		</div>
		<button class="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
	</form>
	{#snippet footer()}
		Already registered? <a href="{base}/login{page.url.search}">Sign in</a>
	{/snippet}
</AuthCard>
