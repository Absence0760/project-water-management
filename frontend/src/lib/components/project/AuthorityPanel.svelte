<script lang="ts">
	// The project's responsible authority (163_licensing_authority; provisional
	// position, pre-counsel research, 2026-10-01; docs/ui.md § Project): who
	// decides its licence applications under the National Water Act, DWS (a
	// regional office) or a CMA with the power. Stored in
	// settings.responsibleAuthority (no model input, so saving it leaves the
	// runs current) and saved at once, as the members are. The decision form
	// fills it in, and the evidence report prints "For: …" from it.
	import type { ProjectSettings } from '@water-management/engine';
	import { api, type Project, type ResponsibleAuthority } from '$lib/api';

	let {
		project,
		canEdit,
		onProjectChange
	}: {
		project: Project;
		canEdit: boolean;
		onProjectChange: (p: Project) => void;
	} = $props();

	const current = $derived(project.settings.responsibleAuthority ?? null);
	let name = $state('');
	let kind = $state<ResponsibleAuthority['kind']>('cma');
	let office = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let saved = $state('');

	// Follow the project as saved (a save here, or Settings).
	$effect(() => {
		name = current?.name ?? '';
		kind = current?.kind ?? 'cma';
		office = current?.office ?? '';
	});

	const dirty = $derived(name.trim() !== (current?.name ?? '') || (name.trim() !== '' && (kind !== (current?.kind ?? 'cma') || office.trim() !== (current?.office ?? ''))));

	async function save(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		saved = '';
		try {
			const value: ResponsibleAuthority | null = name.trim() ? { name: name.trim(), kind, office: office.trim() } : null;
			onProjectChange(await api.projects.update(project.id, { settings: { responsibleAuthority: value } as unknown as Partial<ProjectSettings> }));
			saved = value ? 'Saved.' : 'Cleared.';
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			busy = false;
		}
	}
</script>

<section class="panel" aria-labelledby="authority-h" data-testid="authority-panel">
	<div class="panel-head">
		<h2 id="authority-h">Responsible authority</h2>
	</div>
	<p class="muted small">
		Who decides this project’s licence applications: the Department of Water and Sanitation, or the catchment management agency the power is
		assigned or delegated to. Only members marked as acting for it (Members) record its decisions and endorse a published baseline.
	</p>
	{#if canEdit}
		<form onsubmit={save}>
			<div class="field">
				<label for="auth-name">Authority name</label>
				<input id="auth-name" maxlength="200" autocomplete="off" bind:value={name} placeholder="Breede-Olifants CMA" aria-describedby="auth-name-h" />
				<span class="hint" id="auth-name-h">Left empty, the project names no authority, and each recorded decision names its own.</span>
			</div>
			<div class="form-row">
				<div class="field">
					<label for="auth-kind">Kind</label>
					<select id="auth-kind" bind:value={kind} disabled={!name.trim()}>
						<option value="cma">Catchment management agency</option>
						<option value="dws">Department of Water and Sanitation</option>
					</select>
				</div>
				<div class="field grow">
					<label for="auth-office">Office <span class="muted">(optional)</span></label>
					<input id="auth-office" maxlength="200" autocomplete="off" bind:value={office} disabled={!name.trim()} placeholder="Bellville regional office" />
				</div>
			</div>
			<button type="submit" class="btn btn-sm" disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save'}</button>
		</form>
	{:else if current}
		<p data-testid="authority-current">
			{current.name}<span class="muted">{current.kind === 'dws' ? ', Department of Water and Sanitation' : ', a catchment management agency'}{current.office ? `, ${current.office}` : ''}</span>
		</p>
	{:else}
		<p class="muted" data-testid="authority-current">None named.</p>
	{/if}
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
	<p class="visually-hidden" role="status">{saved}</p>
</section>
