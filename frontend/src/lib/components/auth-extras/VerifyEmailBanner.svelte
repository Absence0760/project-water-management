<script lang="ts">
	// "Confirm your email" nudge for signed-in users whose address isn't
	// verified yet (GET /auth/me → emailVerified: false). Pending project/team
	// invitations for the address only take effect once it is confirmed.
	// Mount once, just under the app header, in routes/+layout.svelte.
	import { api, ApiError } from '$lib/api';
	import { emailAuthApi } from '$lib/api/emailAuth';
	import { session } from '$lib/auth/session.svelte';

	const emailAuth = emailAuthApi(api);

	let busy = $state(false);
	let message = $state<string | null>(null);
	let dismissed = $state(false);

	const show = $derived(!!session.user && session.user.emailVerified === false && !dismissed);

	async function resend() {
		busy = true;
		message = null;
		try {
			await emailAuth.resendVerification();
			message = 'Sent — check your inbox (and spam folder).';
		} catch (err) {
			if (err instanceof ApiError && err.status === 409 && session.user) {
				// Verified in another tab meanwhile.
				session.user = { ...session.user, emailVerified: true };
				return;
			}
			message = err instanceof Error ? err.message : String(err);
		} finally {
			busy = false;
		}
	}
</script>

{#if show && session.user}
	<section class="verify-banner" aria-label="Email confirmation">
		<p>
			Please confirm your email address. We sent a link to <strong>{session.user.email}</strong>.
		</p>
		<div class="actions">
			<button type="button" class="btn btn-sm" onclick={resend} disabled={busy}>
				{busy ? 'Sending…' : 'Resend email'}
			</button>
			<button type="button" class="btn btn-sm btn-ghost" onclick={() => (dismissed = true)}>Dismiss</button>
		</div>
		<p class="status" role="status" aria-live="polite">{message ?? ''}</p>
	</section>
{/if}

<style>
	.verify-banner {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 1rem;
		padding: 0.5rem var(--gutter);
		background: var(--warning-soft);
		border-bottom: 1px solid color-mix(in srgb, var(--warning) 40%, transparent);
		color: var(--text);
	}
	.verify-banner p {
		margin: 0;
	}
	.actions {
		display: flex;
		gap: 0.5rem;
	}
	/* Always rendered (even empty) so screen readers announce updates. */
	.status {
		flex-basis: 100%;
		font-size: 0.85rem;
		color: var(--text-2);
	}
</style>
