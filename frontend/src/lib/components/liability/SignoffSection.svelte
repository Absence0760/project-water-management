<script lang="ts">
	// The report's professional sign-off section (WP-3.13): the run's
	// sign-offs, or a plain statement that it has none, and for an editor the
	// way to sign. The same for an evidence pack (WP-3.14, issue #71): its
	// target is the pack, its statement the pack statement. The dialog is its
	// own chunk, loaded when opened.
	import type { PackSignoffList, Signoff, SignoffList } from '$lib/api';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import { fmtDate } from '$lib/format/number';
	import { registrationBody, registrationLine } from '@water-management/engine';
	import { shortHash, type SignoffTarget } from './signoffForm';

	const loadDialog = () => import('./SignoffDialog.svelte');

	let {
		projectId,
		target,
		list,
		onchange
	}: { projectId: string; target: SignoffTarget; list: SignoffList | PackSignoffList; onchange: (signoffs: Signoff[] | null) => void } = $props();

	const what = $derived(target.kind === 'pack' ? 'evidence pack' : 'run');

	let open = $state(false);
	let justSigned = $state('');
</script>

<div class="signoff">
	{#if list.signoffs.length}
		{#each list.signoffs as s (s.id)}
			{@const line = registrationLine(s.registrationBody, s.registrationCategory, s.registrationField, s.registrationNo)}
			{@const register = line ? registrationBody(s.registrationBody) : undefined}
			<dl class="kv" aria-label="Sign-off by {s.fullName}">
				<div><dt>Signed by</dt><dd>{s.fullName}</dd></div>
				<div><dt>Signed</dt><dd>{fmtDate(s.signedAt, true)}</dd></div>
				<!-- The credential, then where to check it (a visible URL: reports are printed), then the scope it limits. -->
				<div class="wide">
					<dt>Registration (self-declared)</dt>
					<dd>{line ?? `${s.registrationBody} ${s.registrationNo} (category and field not recorded)`}</dd>
				</div>
				{#if register}
					<div class="wide">
						<dt>Check it</dt>
						<dd>{register.registerName}: <a href={register.registerUrl} rel="noopener noreferrer" target="_blank">{register.registerUrl}</a></dd>
					</div>
				{/if}
				<div class="wide"><dt>Scope</dt><dd>{s.scope}</dd></div>
				<div class="wide">
					<dt>Statement confirmed</dt>
					<dd>version {s.statementVersion}, SHA-256 <code title={s.statementSha256}>{shortHash(s.statementSha256)}…</code>, disclaimer {s.disclaimerVersion}</dd>
				</div>
			</dl>
		{/each}
		<p class="muted small">
			Each signer confirmed, {target.kind === 'pack' ? 'for this evidence pack as its manifest SHA-256 identifies it' : 'for this run as it was made'}, the statement of the version recorded with their sign-off, and read its known limitations.
			Registration details are the signer’s own declaration: this app does not check them against the professional body’s register. A
			sign-off can’t be changed or withdrawn.
		</p>
		{#if list.signoffs.some((s) => s.statementVersion !== list.statement.version)}
			<p class="muted small">
				A sign-off made under an earlier statement version confirmed that version’s wording, recorded by its SHA-256, not the statements
				below ({list.statement.version}).
			</p>
		{/if}
	{:else}
		<p><strong>Not signed off.</strong> No registered professional has signed this {what}.</p>
	{/if}

	<ol class="statements">
		{#each list.statement.confirmations as c (c.id)}<li>{c.text}</li>{/each}
	</ol>

	{#if justSigned}<p class="alert alert-info no-print" role="status">{justSigned}</p>{/if}
	{#if list.cannotSign === null}
		<p class="no-print">
			<button type="button" class="btn" onclick={() => (open = true)}>Sign off this {what}…</button>
		</p>
	{:else if list.cannotSign !== 'requires editor role'}
		<p class="muted small no-print">{list.cannotSign[0]!.toUpperCase() + list.cannotSign.slice(1)}.</p>
	{/if}
</div>

{#if open}
	<Lazy load={loadDialog}>
		{#snippet children(SignoffDialog)}
			<SignoffDialog
				bind:open
				{projectId}
				{target}
				{list}
				onsigned={(s: Signoff) => {
					justSigned = `Signed off by ${s.fullName}.`;
					onchange([...list.signoffs, s]);
				}}
				onstale={() => onchange(null)}
			/>
		{/snippet}
	</Lazy>
{/if}

<style>
	.kv {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr));
		gap: 0.5rem 1rem;
		margin: 0 0 1rem;
		padding-bottom: 0.75rem;
		border-bottom: 1px solid var(--border);
	}
	.kv .wide {
		grid-column: 1 / -1;
	}
	dt {
		font-size: 0.75rem;
		color: var(--text-muted);
	}
	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.statements {
		max-width: 72ch;
		line-height: 1.5;
	}
	@media print {
		.no-print {
			display: none;
		}
	}
</style>
