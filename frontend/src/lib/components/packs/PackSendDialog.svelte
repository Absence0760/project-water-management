<script lang="ts">
	// Send an issued evidence pack to the responsible authority (licensing
	// build item 13; provisional position, pre-counsel research, 2026-10-01;
	// docs/ui.md § Evidence pack). The pack's PDF and bundle name every water
	// user, so they go to the authority that decides (NWA s41(2)), never
	// through the applicant: an editor picks among the members the project's
	// owner marked as acting for it (Members, 163), adds a note, and each gets
	// an email linking the pack's page (sign-in needed to download) and the
	// verify page. Never a file, never a link that works on its own.
	import { untrack } from 'svelte';
	import { api, type Member } from '$lib/api';
	import { session } from '$lib/auth/session.svelte';
	import Dialog from '$lib/components/common/Dialog.svelte';

	let { open = $bindable(false), projectId, packId, version, authority }: { open: boolean; projectId: string; packId: string; version: number; authority: string | null } = $props();

	let members = $state.raw<Member[] | null>(null);
	let picked = $state<Record<string, boolean>>({});
	let note = $state('');
	let error = $state<string | null>(null);
	let busy = $state(false);
	let done = $state<string | null>(null);
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	/** The members acting for the authority, editors and up, never the sender: whom the API sends to. */
	const acting = $derived((members ?? []).filter((m) => m.actsForAuthority && (m.role === 'editor' || m.role === 'owner') && m.userId !== session.user?.id));
	const chosen = $derived(acting.filter((m) => picked[m.userId]));

	async function load() {
		error = null;
		done = null;
		try {
			members = await api.members.list(projectId);
			picked = Object.fromEntries(members.map((m) => [m.userId, true]));
		} catch (e) {
			error = msg(e);
		}
	}
	$effect(() => {
		if (open) untrack(load);
	});

	async function send() {
		busy = true;
		error = null;
		try {
			const r = await api.packs.send(projectId, packId, { userIds: chosen.map((m) => m.userId), ...(note.trim() ? { note: note.trim() } : {}) });
			done = r.failed
				? `Sent to ${r.sent} of ${r.recipients.length}; ${r.failed} email${r.failed === 1 ? '' : 's'} couldn’t be sent. Try again later.`
				: `Sent to ${r.recipients.map((x) => x.displayName).join(', ')}.`;
		} catch (e) {
			error = msg(e);
		} finally {
			busy = false;
		}
	}
</script>

<Dialog bind:open title="Send evidence pack v{version} to the responsible authority" side>
	<div class="send" data-testid="pack-send">
		<p>
			The pack’s PDF and reproduction bundle name every water user, so they go to {authority ?? 'the responsible authority'}, the authority that decides, and
			not through the applicant (their copy withholds the others’ figures). Each member you pick gets an email with a link to this page, where they sign in to
			download them, and to the verify page. The email holds no file and no link that works without signing in.
		</p>
		{#if members === null && !error}
			<p class="muted" role="status">Loading the members…</p>
		{:else if members !== null && !acting.length}
			<p class="alert alert-info" data-testid="pack-send-none">
				No other member acts for the responsible authority. The project’s owner marks the authority’s assessors in Members (“Acts for the responsible authority”).
			</p>
		{:else if acting.length}
			<fieldset>
				<legend>Send it to</legend>
				{#each acting as m (m.userId)}
					<label><input type="checkbox" bind:checked={picked[m.userId]} disabled={busy} /> {m.displayName}</label>
				{/each}
			</fieldset>
			<label class="field">
				<span>Note (optional)</span>
				<textarea rows="3" maxlength="1000" bind:value={note} disabled={busy}></textarea>
			</label>
		{/if}
		{#if error}<p class="alert alert-warning" role="alert">{error}</p>{/if}
		<p role="status" data-testid="pack-send-done">{done ?? ''}</p>
	</div>
	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (open = false)}>Close</button>
		{#if acting.length}
			<button type="button" class="btn btn-primary" disabled={busy || !chosen.length || done !== null} onclick={send}>Send</button>
		{/if}
	{/snippet}
</Dialog>

<style>
	.send {
		display: grid;
		gap: 0.75rem;
	}
	fieldset {
		display: grid;
		gap: 0.25rem;
		border: 1px solid var(--border);
		padding: 0.5rem 0.75rem;
	}
	textarea {
		width: 100%;
	}
</style>
