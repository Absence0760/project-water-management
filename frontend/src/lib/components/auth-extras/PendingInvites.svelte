<script lang="ts">
	// Pending invitations for addresses without an account (docs/api.md
	// § Invites), under a project's or a team's member list. Owners/admins only:
	// the list endpoint is theirs alone. The parent's add form puts new invites
	// in via `bind:invites`; this lists, re-sends and revokes them.
	import { onMount } from 'svelte';
	import type { Invite } from '$lib/api/types';
	import { fmtDate } from '$lib/format/number';
	import { expiryText, resendWasMailed, upsertInvite } from './invites';
	import EmailText from '$lib/components/common/EmailText.svelte';

	let {
		invites = $bindable([]),
		load,
		resend,
		revoke,
		idPrefix
	}: {
		invites?: Invite[];
		load: () => Promise<Invite[]>;
		/**
		 * Add the same address again with the same role: a fresh link, unless one
		 * went out a minute ago. Null = they have an account now and were added
		 * as a member directly (the parent updates its member list).
		 */
		resend: (inv: Invite) => Promise<Invite | null>;
		revoke: (inv: Invite) => Promise<void>;
		idPrefix: string;
	} = $props();

	let loadError = $state<string | null>(null);
	let busy = $state<string | null>(null);
	let message = $state<string | null>(null);
	let error = $state<string | null>(null);

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	async function reload() {
		loadError = null;
		try {
			invites = await load();
		} catch (e) {
			loadError = msg(e);
		}
	}
	onMount(reload);

	async function doResend(inv: Invite) {
		busy = inv.id;
		message = error = null;
		try {
			const fresh = await resend(inv);
			if (!fresh) {
				invites = invites.filter((x) => x.id !== inv.id);
				message = `${inv.email} has signed up meanwhile and is now a member.`;
				return;
			}
			invites = upsertInvite(invites, fresh);
			message = resendWasMailed(inv, fresh)
				? `Invitation re-sent to ${inv.email}. The earlier link no longer works.`
				: `An invitation went to ${inv.email} less than a minute ago — wait a moment before re-sending.`;
		} catch (e) {
			error = msg(e);
		} finally {
			busy = null;
		}
	}

	async function doRevoke(inv: Invite) {
		if (!confirm(`Revoke the invitation to ${inv.email}? The link in their email stops working.`)) return;
		busy = inv.id;
		message = error = null;
		try {
			await revoke(inv);
			invites = invites.filter((x) => x.id !== inv.id);
			message = `Invitation to ${inv.email} revoked.`;
		} catch (e) {
			error = msg(e);
		} finally {
			busy = null;
		}
	}
</script>

{#if loadError}
	<div class="alert alert-error" role="alert">
		Couldn’t load pending invitations: {loadError}
		<button type="button" class="btn btn-sm" onclick={reload}>Try again</button>
	</div>
{/if}
{#if invites.length}
	<section class="invites" aria-labelledby="{idPrefix}-inv-h">
		<h3 id="{idPrefix}-inv-h">Pending invitations <span class="count">({invites.length})</span></h3>
		<ul>
			{#each invites as inv (inv.id)}
				<li class:expired={inv.expired}>
					<div class="who">
						<span class="email"><EmailText email={inv.email} /></span>
						<span class="meta">
							<span class="badge">{inv.role}</span>
							invited by {inv.invitedBy} ·
							{#if inv.expired}
								<span class="badge badge-warn">Expired</span>
							{:else}
								<span title="Expires {fmtDate(inv.expiresAt, true)}">{expiryText(inv)}</span>
							{/if}
						</span>
					</div>
					<div class="act">
						<button
							type="button"
							class="btn btn-sm"
							disabled={busy === inv.id}
							aria-label="Resend invitation to {inv.email}"
							onclick={() => doResend(inv)}>Resend</button
						>
						<button
							type="button"
							class="btn btn-sm btn-danger"
							disabled={busy === inv.id}
							aria-label="Revoke invitation to {inv.email}"
							onclick={() => doRevoke(inv)}>Revoke</button
						>
					</div>
				</li>
			{/each}
		</ul>
	</section>
{/if}
{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
<p class="status" role="status" aria-live="polite">{message ?? ''}</p>

<style>
	.invites {
		margin-top: 1rem;
	}
	h3 {
		margin: 0 0 0.4rem;
		font-size: 0.9rem;
		font-weight: 600;
	}
	.count {
		color: var(--text-muted);
		font-weight: 400;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem 1rem;
		flex-wrap: wrap;
		padding: 0.5rem 0.75rem;
	}
	li + li {
		border-top: 1px solid var(--border);
	}
	li.expired .email {
		color: var(--text-2);
	}
	.who {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
	}
	.email {
		font-weight: 500;
	}
	.meta {
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.act {
		display: flex;
		gap: 0.4rem;
		margin-left: auto;
	}
	/* Always rendered (even empty) so screen readers announce updates. */
	.status:empty {
		margin: 0;
	}
	.status {
		margin: 0.5rem 0 0;
		font-size: 0.85rem;
		color: var(--text-2);
	}
</style>
