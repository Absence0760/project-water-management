<script lang="ts">
	// Asks for a code from the authenticator again (licensing positions item 9;
	// docs/ui.md § Evidence packs → Signing; lib/auth/freshCode.svelte.ts). A
	// sign-off, issuing an evidence pack and withdrawing one need a code from
	// the last 10 minutes; the API answered 401 mfa_fresh_code, and once this
	// dialog's code is accepted (POST /auth/mfa/step-up) the action is sent
	// again. The workspace's (English). Its own chunk, mounted by
	// routes/+layout.svelte only while it asks.
	import { api } from '$lib/api';
	import { answerCode } from '$lib/auth/freshCode.svelte';
	import Dialog from '$lib/components/common/Dialog.svelte';

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

<Dialog bind:open title="Enter a code from your authenticator">
	<form id="fresh-code-form" onsubmit={submit} data-testid="fresh-code">
		<p>Signing off, issuing and withdrawing an evidence pack, and removing a team member’s two-step sign-in, need a code from your authenticator app from the last 10 minutes.</p>
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
		<p id="fresh-code-help" class="fine">Six digits from the app, or one of your recovery codes.</p>
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
	.fine {
		color: var(--text-2);
		font-size: 13px;
		margin: 0;
	}
</style>
