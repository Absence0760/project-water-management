<script lang="ts">
	// The app-wide two-step sign-in prompt (issue #282; docs/ui.md § Invitations,
	// the two-step sign-in banner; lib/auth/mfaPrompt.svelte.ts). On the workspace only
	// (English): the Account page, which is translated, says the same in its
	// own panel. Its own chunk, mounted by routes/+layout.svelte only while
	// there is something to say.
	//
	// - `setup`: no authenticator, and the person's role needs one (or an
	//   action was refused with 403 mfa_required): a link to the Account
	//   page's Two-step sign-in panel.
	// - `step-up`: an authenticator, but this session signed in with the
	//   password only (or an action was refused with 403 mfa_step_up): sign
	//   out and back to the sign-in page, which returns here afterwards.
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { focusPageStart } from '$lib/a11y/focusPage';
	import { dismissMfaPrompt, mfaPrompt, type MfaPromptKind } from '$lib/auth/mfaPrompt.svelte';
	import { loginReturningTo, signOutTo } from '$lib/auth/signOut';

	let { kind }: { kind: MfaPromptKind } = $props();

	/** Whether a request was refused: the action the person just tried needs it, not only their role. */
	const refused = $derived(mfaPrompt.refused === kind);
	let signingOut = $state(false);

	function dismiss() {
		dismissMfaPrompt();
		void focusPageStart();
	}

	/** Sign out, then the sign-in page (password, then the code), back to this page after. */
	async function signInAgain() {
		signingOut = true;
		await signOutTo(loginReturningTo(page.url.pathname + page.url.search));
		signingOut = false;
	}
</script>

<section class="mfa-banner" aria-label="Two-step sign-in" data-mfa-prompt={kind}>
	{#if kind === 'setup'}
		<p>
			<!-- Only a refused action brings it up (2026-10-03), never the role alone. -->
			That needs two-step sign-in, and you haven’t set it up yet. Set it up on your Account page, then try again.
		</p>
		<div class="actions">
			<a class="btn btn-sm" href="{base}/account#two-step">Set up two-step sign-in</a>
			<button type="button" class="btn btn-sm btn-ghost" onclick={dismiss}>Dismiss</button>
		</div>
	{:else}
		<p>
			{#if refused}
				That needs a sign-in with a code, and this session signed in with your password only. Sign in again
				to carry on.
			{:else}
				Your role needs two-step sign-in, and this session signed in with your password only. Sign in again with a code to
				manage members, publish to farmers or decide applications.
			{/if}
		</p>
		<div class="actions">
			<button type="button" class="btn btn-sm" onclick={signInAgain} disabled={signingOut}>
				{signingOut ? 'Signing out…' : 'Sign in again'}
			</button>
			<button type="button" class="btn btn-sm btn-ghost" onclick={dismiss}>Dismiss</button>
		</div>
	{/if}
</section>

<style>
	.mfa-banner {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 1rem;
		padding: 0.5rem var(--gutter);
		background: var(--warning-soft);
		border-bottom: 1px solid color-mix(in srgb, var(--warning) 40%, transparent);
		color: var(--text);
	}
	.mfa-banner p {
		margin: 0;
		flex: 1 1 24rem;
	}
	.actions {
		display: flex;
		gap: 0.5rem;
	}
</style>
