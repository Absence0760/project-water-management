<script lang="ts">
	// The workspace's Allocations tab (?tab=allocations, WP-3.10, docs/ui.md
	// § Allocations): a run's modelled use against the registered volumes,
	// the registered volumes themselves (with their source file), and for
	// editors the import wizard and a form to add or change one by hand.
	// Viewers see volumes but no holder names (decision D3; the API leaves them
	// out, RLS enforces it). Farmers never reach the workspace.
	import { untrack } from 'svelte';
	import { api, type Allocation, type AllocationInput, type AllocationList, type RunMeta } from '$lib/api';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { fmtDate, fmtNum, parseNum } from '$lib/format/number';
	import AllocationCompare from './AllocationCompare.svelte';
	import AllocationImport from './AllocationImport.svelte';
	import { AUTHORISATION_LABEL, PURPOSE_LABEL, shortHash, SOURCE_LABEL } from './allocations';

	let { projectId, runs, canEdit }: { projectId: string; runs: RunMeta[] | null; canEdit: boolean } = $props();

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	let data = $state<AllocationList | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let notice = $state<string | null>(null);
	async function load() {
		loading = true;
		error = null;
		try {
			data = await api.allocations.list(projectId);
		} catch (e) {
			error = msg(e);
		} finally {
			loading = false;
		}
	}
	$effect(() => {
		void projectId;
		untrack(load);
	});

	const sourceById = $derived(new Map((data?.sources ?? []).map((s) => [s.id, s])));
	/** Bumped on every change so the comparison reloads. */
	let version = $state(0);

	// --- add / edit ------------------------------------------------------------------
	interface Draft {
		nodeId: string;
		registrationNo: string;
		propertyRef: string;
		holder: string;
		authorisation: AllocationInput['authorisation'];
		purpose: NonNullable<AllocationInput['purpose']>;
		waterSource: AllocationInput['waterSource'];
		volume: string;
		storage: string;
		validFrom: string;
		validTo: string;
		reference: string;
	}
	const blank = (): Draft => ({
		nodeId: '',
		registrationNo: '',
		propertyRef: '',
		holder: '',
		authorisation: 'licence',
		purpose: 'irrigation',
		waterSource: 'surface',
		volume: '',
		storage: '',
		validFrom: '',
		validTo: '',
		reference: ''
	});
	let draft = $state<Draft | null>(null);
	let editingId = $state<string | null>(null);
	let saving = $state(false);
	let formError = $state<string | null>(null);

	function startAdd() {
		editingId = null;
		draft = blank();
		formError = null;
	}
	function startEdit(a: Allocation) {
		editingId = a.id;
		draft = {
			nodeId: a.nodeId ?? '',
			registrationNo: a.registrationNo,
			propertyRef: a.propertyRef,
			holder: a.holder ?? '',
			authorisation: a.authorisation,
			purpose: a.purpose,
			waterSource: a.waterSource,
			volume: String(a.volumeM3PerYear),
			storage: a.storageM3 === null ? '' : String(a.storageM3),
			validFrom: a.validFrom ?? '',
			validTo: a.validTo ?? '',
			reference: a.reference
		};
		formError = null;
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (!draft) return;
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
			...(data?.canSeeHolders ? { holder: draft.holder } : {})
		};
		saving = true;
		formError = null;
		try {
			if (editingId) await api.allocations.update(projectId, editingId, body);
			else await api.allocations.create(projectId, body);
			draft = null;
			editingId = null;
			await load();
			version++;
		} catch (err) {
			formError = msg(err);
		} finally {
			saving = false;
		}
	}

	async function remove(a: Allocation) {
		if (!confirm(`Delete the registered volume ${a.registrationNo || ''} (${fmtNum(a.volumeM3PerYear)} m³/a)?`)) return;
		try {
			await api.allocations.remove(projectId, a.id);
			await load();
			version++;
		} catch (err) {
			notice = msg(err);
		}
	}

	async function undoImport(id: string, fileName: string, rows: number) {
		if (!confirm(`Remove the import of ${fileName} and its ${rows} registered volume${rows === 1 ? '' : 's'}?`)) return;
		try {
			await api.allocations.removeSource(projectId, id);
			notice = `Removed the import of ${fileName}.`;
			await load();
			version++;
		} catch (err) {
			notice = msg(err);
		}
	}

	async function imported(message: string) {
		notice = message;
		await load();
		version++;
	}

	const validity = (a: Allocation) =>
		a.validFrom || a.validTo ? `${a.validFrom ? fmtDate(a.validFrom) : '…'} – ${a.validTo ? fmtDate(a.validTo) : '…'}` : 'open';
</script>

<div class="allocations">
	{#if notice}<p class="alert alert-info" role="status">{notice}</p>{/if}

	<AllocationCompare {projectId} runs={runs ?? []} {version} />

	<section class="panel" aria-labelledby="alloc-list-h">
		<div class="panel-head">
			<h2 id="alloc-list-h">Registered volumes</h2>
			<div class="head-actions">
				{#if data?.allocations.length}<a class="btn btn-sm btn-ghost" href={api.allocations.exportUrl(projectId)} download>Download CSV</a>{/if}
				{#if canEdit && !draft}<button type="button" class="btn btn-sm" onclick={startAdd}>Add a volume</button>{/if}
			</div>
		</div>
		<LoadState {loading} {error} retry={load}>
			{#if data}
				{#if !data.canSeeHolders && data.allocations.length}
					<p class="muted small">Names of registered users are shown to editors only.</p>
				{/if}
				{#if draft}
					<form class="form" onsubmit={save} aria-labelledby="alloc-form-h">
						<h3 id="alloc-form-h">{editingId ? 'Change the registered volume' : 'Add a registered volume'}</h3>
						<div class="form-row">
							<div class="field">
								<label for="af-node">Farm or water user</label>
								<select id="af-node" bind:value={draft.nodeId}>
									<option value="">Not matched yet</option>
									{#each data.nodes as n (n.id)}<option value={n.id}>{n.name}</option>{/each}
								</select>
							</div>
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
						</div>
						<div class="form-row">
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
						</div>
						<div class="form-row">
							<div class="field">
								<label for="af-reg">Registration or licence number</label>
								<input id="af-reg" type="text" maxlength="100" bind:value={draft.registrationNo} />
							</div>
							<div class="field">
								<label for="af-prop">Property</label>
								<input id="af-prop" type="text" maxlength="200" bind:value={draft.propertyRef} />
							</div>
							{#if data.canSeeHolders}
								<div class="field">
									<label for="af-holder">Registered user</label>
									<input id="af-holder" type="text" maxlength="200" bind:value={draft.holder} />
								</div>
							{/if}
							<div class="field grow">
								<label for="af-ref">Reference</label>
								<input id="af-ref" type="text" maxlength="500" bind:value={draft.reference} />
							</div>
						</div>
						<div class="actions">
							<button type="submit" class="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
							<button type="button" class="btn" onclick={() => (draft = null)} disabled={saving}>Cancel</button>
						</div>
						{#if formError}<p class="alert alert-error" role="alert">{formError}</p>{/if}
					</form>
				{/if}

				{#if data.allocations.length}
					<div class="table-wrap">
						<table class="data" data-testid="allocation-list">
							<caption class="visually-hidden">Registered and licensed volumes</caption>
							<thead>
								<tr>
									<th scope="col">Farm or user</th>
									<th scope="col">Registration</th>
									{#if data.canSeeHolders}<th scope="col">Registered user</th>{/if}
									<th scope="col">Authorisation</th>
									<th scope="col">Purpose</th>
									<th scope="col">Source</th>
									<th scope="col" class="num">Volume (m³/a)</th>
									<th scope="col" class="num">Storage (m³)</th>
									<th scope="col">Valid</th>
									<th scope="col">From</th>
									{#if canEdit}<th scope="col"><span class="visually-hidden">Actions</span></th>{/if}
								</tr>
							</thead>
							<tbody>
								{#each data.allocations as a (a.id)}
									{@const src = a.sourceId ? sourceById.get(a.sourceId) : undefined}
									<tr class:flag={a.nodeId === null}>
										<th scope="row">{a.nodeName ?? 'Not matched'}</th>
										<td>{a.registrationNo || '–'}</td>
										{#if data.canSeeHolders}<td>{a.holder ?? '–'}</td>{/if}
										<td>{AUTHORISATION_LABEL[a.authorisation]}</td>
										<td>{PURPOSE_LABEL[a.purpose]}</td>
										<td>{SOURCE_LABEL[a.waterSource]}</td>
										<td class="num">{fmtNum(a.volumeM3PerYear)}</td>
										<td class="num">{fmtNum(a.storageM3)}</td>
										<td>{validity(a)}</td>
										<td>
											{#if src}<span title="SHA-256 {src.sha256}">{src.fileName} · {shortHash(src.sha256)}</span>{:else}Entered by hand{/if}
										</td>
										{#if canEdit}
											<td class="row-actions">
												<button type="button" class="btn btn-sm btn-ghost" onclick={() => startEdit(a)} aria-label="Change {a.registrationNo || 'this volume'}">Change</button>
												<button type="button" class="btn btn-sm btn-ghost" onclick={() => remove(a)} aria-label="Delete {a.registrationNo || 'this volume'}">Delete</button>
											</td>
										{/if}
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{:else}
					<p class="muted" data-testid="allocations-empty">
						No registered volumes yet.{canEdit ? ' Import a WARMS extract or the CSV template below, or add one by hand.' : ''}
					</p>
				{/if}

				{#if data.sources.length}
					<h3 class="sub-h">Imported files</h3>
					<ul class="sources">
						{#each data.sources as s (s.id)}
							<li>
								<span><strong>{s.fileName}</strong> · {s.rows} row{s.rows === 1 ? '' : 's'} · {fmtDate(s.importedAt, true)}{s.importedBy ? ` by ${s.importedBy}` : ''}</span>
								<span class="mono small" title="SHA-256 of the file">{s.sha256}</span>
								{#if s.reference}<span class="small muted">{s.reference}</span>{/if}
								{#if canEdit}<button type="button" class="btn btn-sm btn-ghost" onclick={() => undoImport(s.id, s.fileName, s.rows)}>Remove this import</button>{/if}
							</li>
						{/each}
					</ul>
				{/if}
			{/if}
		</LoadState>
	</section>

	{#if canEdit}<AllocationImport {projectId} onimported={imported} />{/if}
</div>

<style>
	.head-actions {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.small {
		font-size: 0.8rem;
	}
	.form {
		margin-bottom: 1rem;
		padding-bottom: 0.75rem;
		border-bottom: 1px solid var(--border);
	}
	.form h3,
	.sub-h {
		margin: 0.5rem 0;
		font-size: 1rem;
	}
	.grow {
		flex: 1 1 16rem;
	}
	.actions {
		display: flex;
		gap: 0.5rem;
	}
	.row-actions {
		white-space: nowrap;
	}
	.sources {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.5rem;
	}
	.sources li {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.1rem;
		overflow-wrap: anywhere;
	}
</style>
