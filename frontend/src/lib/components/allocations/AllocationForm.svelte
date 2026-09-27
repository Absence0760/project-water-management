<script lang="ts">
	// Add or change one registered volume (WP-3.10, docs/ui.md § Allocations),
	// in a side sheet the page opens from `volume=new` or `volume=<id>`. The
	// unit picker is how a row is matched by hand. Only editors reach it, and
	// only they send a holder name (decision D3).
	import { api, type Allocation, type AllocationInput } from '$lib/api';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import { parseNum } from '$lib/format/number';
	import { AUTHORISATION_LABEL, PURPOSE_LABEL, SOURCE_LABEL } from './allocations';

	let {
		projectId,
		nodes,
		canSeeHolders,
		allocation,
		open = $bindable(false),
		onsaved
	}: {
		projectId: string;
		nodes: { id: string; name: string }[];
		canSeeHolders: boolean;
		/** The volume to change; null adds one. */
		allocation: Allocation | null;
		open?: boolean;
		onsaved: () => void;
	} = $props();

	const draftOf = (a: Allocation | null) => ({
		nodeId: a?.nodeId ?? '',
		registrationNo: a?.registrationNo ?? '',
		propertyRef: a?.propertyRef ?? '',
		holder: a?.holder ?? '',
		authorisation: a?.authorisation ?? ('licence' as AllocationInput['authorisation']),
		purpose: a?.purpose ?? ('irrigation' as NonNullable<AllocationInput['purpose']>),
		waterSource: a?.waterSource ?? ('surface' as AllocationInput['waterSource']),
		volume: a ? String(a.volumeM3PerYear) : '',
		storage: a?.storageM3 == null ? '' : String(a.storageM3),
		validFrom: a?.validFrom ?? '',
		validTo: a?.validTo ?? '',
		reference: a?.reference ?? ''
	});
	// A fresh draft each time the sheet opens on a volume (or on a new one).
	let draft = $state(draftOf(null));
	let saving = $state(false);
	let formError = $state<string | null>(null);
	$effect(() => {
		if (!open) return;
		draft = draftOf(allocation);
		formError = null;
	});

	async function save(e: SubmitEvent) {
		e.preventDefault();
		const volume = parseNum(draft.volume);
		const storage = draft.storage.trim() === '' ? null : parseNum(draft.storage);
		if (volume === null || volume < 0) {
			formError = 'Enter the registered volume in m³ per year.';
			return;
		}
		if (draft.storage.trim() !== '' && (storage === null || storage < 0)) {
			formError = 'Storage is a number of m³, or empty.';
			return;
		}
		const body: AllocationInput = {
			nodeId: draft.nodeId || null,
			registrationNo: draft.registrationNo,
			propertyRef: draft.propertyRef,
			authorisation: draft.authorisation,
			purpose: draft.purpose,
			waterSource: draft.waterSource,
			volumeM3PerYear: volume,
			storageM3: storage,
			validFrom: draft.validFrom || null,
			validTo: draft.validTo || null,
			reference: draft.reference,
			// Only an editor sees names; a viewer can't reach this form.
			...(canSeeHolders ? { holder: draft.holder } : {})
		};
		saving = true;
		formError = null;
		try {
			if (allocation) await api.allocations.update(projectId, allocation.id, body);
			else await api.allocations.create(projectId, body);
			open = false;
			onsaved();
		} catch (err) {
			formError = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}
</script>

<Dialog bind:open side title={allocation ? 'Change the registered volume' : 'Add a registered volume'}>
	<form id="alloc-form" class="form" onsubmit={save}>
		<div class="field">
			<label for="af-node">Unit or water user</label>
			<select id="af-node" bind:value={draft.nodeId}>
				<option value="">Not matched yet</option>
				{#each nodes as n (n.id)}<option value={n.id}>{n.name}</option>{/each}
			</select>
		</div>
		<div class="pair">
			<div class="field">
				<label for="af-auth">Authorisation</label>
				<select id="af-auth" bind:value={draft.authorisation}>
					{#each Object.entries(AUTHORISATION_LABEL) as [v, l] (v)}<option value={v}>{l}</option>{/each}
				</select>
			</div>
			<div class="field">
				<label for="af-source">Water source</label>
				<select id="af-source" bind:value={draft.waterSource}>
					{#each Object.entries(SOURCE_LABEL) as [v, l] (v)}<option value={v}>{l}</option>{/each}
				</select>
			</div>
			<div class="field">
				<label for="af-purpose">Purpose</label>
				<select id="af-purpose" bind:value={draft.purpose}>
					{#each Object.entries(PURPOSE_LABEL) as [v, l] (v)}<option value={v}>{l}</option>{/each}
				</select>
			</div>
			<div class="field">
				<label for="af-volume">Volume (m³ per year)</label>
				<input id="af-volume" type="text" inputmode="decimal" required bind:value={draft.volume} />
			</div>
			<div class="field">
				<label for="af-storage">Storage (m³) <span class="muted">(optional)</span></label>
				<input id="af-storage" type="text" inputmode="decimal" bind:value={draft.storage} />
			</div>
			<div class="field">
				<label for="af-from">Valid from</label>
				<input id="af-from" type="date" bind:value={draft.validFrom} />
			</div>
			<div class="field">
				<label for="af-to">Valid to</label>
				<input id="af-to" type="date" bind:value={draft.validTo} />
			</div>
			<div class="field">
				<label for="af-reg">Registration or licence number</label>
				<input id="af-reg" type="text" maxlength="100" bind:value={draft.registrationNo} />
			</div>
		</div>
		<div class="field">
			<label for="af-prop">Property</label>
			<input id="af-prop" type="text" maxlength="200" bind:value={draft.propertyRef} />
		</div>
		{#if canSeeHolders}
			<div class="field">
				<label for="af-holder">Registered user</label>
				<input id="af-holder" type="text" maxlength="200" bind:value={draft.holder} />
			</div>
		{/if}
		<div class="field">
			<label for="af-ref">Reference</label>
			<input id="af-ref" type="text" maxlength="500" bind:value={draft.reference} />
		</div>
		{#if formError}<p class="alert alert-error" role="alert">{formError}</p>{/if}
	</form>
	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (open = false)} disabled={saving}>Cancel</button>
		<button type="submit" form="alloc-form" class="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
	{/snippet}
</Dialog>

<style>
	.form {
		display: grid;
		gap: 0.75rem;
	}
	.pair {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 12rem), 1fr));
		gap: 0.75rem;
	}
	.field {
		margin: 0;
	}
</style>
