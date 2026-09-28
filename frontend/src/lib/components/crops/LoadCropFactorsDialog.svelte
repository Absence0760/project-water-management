<script lang="ts">
	// Load crop factors (issue #54 item 1; docs/ui.md § Load crop factors): from the
	// reference library (./library.ts) or a b023 workbook's [Crop demand] (the
	// browser importer, in its worker), with an optional pan coefficient,
	// mapped onto the project's crops by name, a diff per crop and the demand
	// difference. Nothing changes until Apply, which edits the model like any
	// other edit: the save bar saves it, with a reason, and History records it.
	// Its own chunk, loaded when the button is first pressed (CropsTab).
	import { onDestroy } from 'svelte';
	import type { ProjectSettings } from '@water-management/engine';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { describeFailure, WORKBOOK_ACCEPT } from '$lib/components/import/workbookFile';
	import type { WorkbookImportSession } from '$lib/spreadsheet/import/runner';
	import { fmtNum, fmtPct } from '$lib/format/number';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import { ARC4_URL, citation, CROP_LIBRARY, LIBRARY_SYSTEMS, libraryCropFactor, type LibraryCrop } from './library';
	import { applyChanges, cropChanges, demandDifference, matchByName, pctChange, withKp, type CropChoice } from './loadFactors';

	let {
		open = $bindable(false),
		editor,
		settings,
		farmIds,
		onapplied
	}: {
		open?: boolean;
		editor: ModelEditor;
		settings: ProjectSettings;
		farmIds: string[];
		onapplied?: (names: string[]) => void;
	} = $props();

	const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	type Source = { id: string; name: string; lib?: LibraryCrop; factors?: number[] };

	let kind = $state<'library' | 'b023'>('library');
	let kp = $state<number | null>(1);
	let wb = $state<{ file: string; crops: Source[] } | null>(null);
	let reading = $state(false);
	let wbError = $state<string | null>(null);
	let session: WorkbookImportSession | null = null;
	let attempt = 0;
	// Per project crop: the source crop ('' keeps the current factors), a planting for a staged crop, the system ('' keeps the efficiency), rejected.
	let pick = $state<Record<string, string>>({});
	let plant = $state<Record<string, { month: number; day: number | null; days: number | null }>>({});
	let system = $state<Record<string, string>>({});
	let reject = $state<Record<string, boolean>>({});

	const crops = $derived(editor.model.crops);
	const sources = $derived<Source[]>(
		kind === 'library' ? CROP_LIBRARY.map((c) => ({ id: c.id, name: c.name, lib: c })) : (wb?.crops ?? [])
	);
	const byId = $derived(new Map(sources.map((s) => [s.id, s])));

	function suggest() {
		const m = matchByName(crops, sources);
		pick = Object.fromEntries(crops.map((c) => [c.id, m.get(c.id) ?? '']));
		system = {};
		reject = {};
	}
	// Each opening, and each change of source, starts from the name matches.
	$effect(() => {
		if (open) suggest();
	});

	const staged = (id: string) => {
		const s = byId.get(pick[id] ?? '');
		return s?.lib?.kind === 'staged' ? s.lib : null;
	};
	function choose(cropId: string, sourceId: string) {
		pick[cropId] = sourceId;
		const s = byId.get(sourceId)?.lib;
		if (s?.kind === 'staged' && !plant[cropId]) plant[cropId] = { month: 0, day: 1, days: s.seasons[0]?.days ?? 0 };
	}

	const choices = $derived.by(() => {
		const out = new Map<string, CropChoice>();
		for (const c of crops) {
			const s = byId.get(pick[c.id] ?? '');
			const p = plant[c.id];
			const planting = p && p.month && p.day && p.days ? { month: p.month, day: p.day, days: p.days } : null;
			const raw = s ? (s.lib ? libraryCropFactor(s.lib, planting) : (s.factors ?? null)) : null;
			const sys = LIBRARY_SYSTEMS.find((x) => x.id === system[c.id]);
			out.set(c.id, { factors: raw && kp !== null && kp > 0 ? withKp(raw, kp) : null, ...(sys ? { efficiency: sys.efficiency } : {}) });
		}
		return out;
	});
	const changes = $derived(cropChanges(crops, choices));
	const accepted = $derived(changes.filter((c) => c.differs && !reject[c.cropId]));
	const demand = $derived(
		accepted.length ? demandDifference(editor.model, applyChanges(crops, accepted), settings.apanMm, settings.februaryDays, farmIds) : null
	);

	async function readWorkbook(e: Event & { currentTarget: HTMLInputElement }) {
		const f = e.currentTarget.files?.[0];
		if (!f) return;
		// A second file while the first is read: cancel it, and only the latest read writes state.
		const mine = ++attempt;
		session?.cancel();
		session = null;
		wb = null;
		wbError = null;
		reading = true;
		let s: WorkbookImportSession | null = null;
		try {
			const { createWorkbookImport, WorkbookImportFailed, WorkbookImportCancelled } = await import('$lib/spreadsheet/import/runner');
			if (mine !== attempt) return;
			s = session = createWorkbookImport();
			try {
				const r = await s.parse(f, {});
				if (mine === attempt) wb = { file: f.name, crops: r.project.model.crops.map((c) => ({ id: `wb:${c.id}`, name: c.name, factors: c.cropFactor })) };
			} catch (err) {
				if (mine !== attempt || err instanceof WorkbookImportCancelled) return;
				const v = err instanceof WorkbookImportFailed ? describeFailure(err.failure) : null;
				wbError = v ? `${v.title} ${v.detail}` : err instanceof Error ? err.message : String(err);
			}
		} catch {
			if (mine === attempt) wbError = 'The workbook reader couldn’t be loaded. Reload the page and try again.';
		} finally {
			s?.close();
			if (mine === attempt) {
				session = null;
				reading = false;
			}
		}
	}
	onDestroy(() => session?.cancel());

	function apply() {
		const names = accepted.map((c) => c.name || 'unnamed crop');
		editor.model.crops = applyChanges(editor.model.crops, accepted);
		open = false;
		onapplied?.(names);
	}

	const f2 = (v: number) => fmtNum(v, 2);
	const eff = (e: number | null) => (e === null ? 'unit’s' : fmtPct(e, 0));
	const sysLabel = (id: string) => LIBRARY_SYSTEMS.find((s) => s.id === id)?.label.toLowerCase() ?? id;
</script>

<Dialog bind:open title="Load crop factors" wide keepInputs>
	<p class="muted small">
		Load monthly crop factors into this project’s crops, see what changes and the demand it makes, then apply. Nothing changes until you
		apply, and applying only edits the table: save it with a reason as any other change.
	</p>
	<fieldset class="row">
		<legend>Source</legend>
		<label><input type="radio" name="lcf-src" checked={kind === 'library'} onchange={() => (kind = 'library')} /> Reference library (ARC/SABI A-pan, winter rainfall)</label>
		<label><input type="radio" name="lcf-src" checked={kind === 'b023'} onchange={() => (kind = 'b023')} /> A b023 workbook</label>
	</fieldset>
	{#if kind === 'library'}
		<p class="muted small">
			Design crop factors × A-pan from the <a href={ARC4_URL} target="_blank" rel="noopener noreferrer">ARC/SABI Irrigation Design Manual, ch. 4</a>
			(Tables 4.13–4.15, 1990; pecan from Table 4.10). Site-specific design values: an orchard cover crop raises them. The choice is the hydrologist’s.
		</p>
	{:else}
		<label class="file">
			Workbook (.xlsx, .xlsm) <input type="file" accept={WORKBOOK_ACCEPT} onchange={readWorkbook} disabled={reading} />
		</label>
		{#if reading}<p class="small" role="status">Reading the workbook…</p>{/if}
		{#if wbError}<p class="alert alert-error small" role="alert">{wbError}</p>{/if}
		{#if wb}<p class="muted small" role="status">{wb.crops.length} crops from [Crop demand] in {wb.file}.</p>{/if}
	{/if}
	<div class="kp">
		<label for="lcf-kp">Pan coefficient Kp</label>
		<NumberInput id="lcf-kp" min={0.1} max={1.5} step={0.05} bind:value={kp} />
		<span class="muted small">Multiplies the source factors. 1 for A-pan factors (the library, b023); about 0.75 for FAO-56 Kc values (against ET₀).</span>
	</div>
	{#if kp === null || !(kp > 0)}<p class="alert alert-warning small">Enter a pan coefficient above 0.</p>{/if}

	{#if sources.length && crops.length}
		<h3>Match crops</h3>
		<div class="table-wrap">
			<table class="data compact">
				<thead>
					<tr>
						<th scope="col">Crop in this project</th>
						<th scope="col">Load factors from</th>
						<th scope="col">Efficiency <HelpTip key="crop.irrigationEfficiency" /></th>
					</tr>
				</thead>
				<tbody>
					{#each crops as c (c.id)}
						{@const st = staged(c.id)}
						{@const lib = byId.get(pick[c.id] ?? '')?.lib}
						<tr>
							<th scope="row">{c.name || '(unnamed)'}</th>
							<td>
								<select aria-label="Load factors for {c.name || 'unnamed crop'} from" value={pick[c.id] ?? ''} onchange={(e) => choose(c.id, e.currentTarget.value)}>
									<option value="">Keep current</option>
									{#each sources as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
								</select>
								{#if st && plant[c.id]}
									{@const p = plant[c.id]!}
									<div class="plant">
										<select aria-label="{c.name} planting month" bind:value={p.month}>
											<option value={0}>Planting month…</option>
											{#each MONTHS as m, i (m)}<option value={i + 1}>{m}</option>{/each}
										</select>
										<NumberInput label="{c.name} planting day" min={1} max={31} step={1} bind:value={p.day} />
										<NumberInput label="{c.name} season, days" min={1} max={365} step={1} bind:value={p.days} />
										<span class="muted small">days; Table 4.7: {st.seasons.map((s) => `${s.label} ${s.days}`).join(', ')}</span>
									</div>
								{/if}
							</td>
							<td>
								<select aria-label="{c.name || 'unnamed crop'} irrigation system" value={system[c.id] ?? ''} onchange={(e) => (system[c.id] = e.currentTarget.value)}>
									<option value="">Keep ({eff(c.irrigationEfficiency ?? null)})</option>
									{#each LIBRARY_SYSTEMS as s (s.id)}<option value={s.id}>{s.label}, {fmtPct(s.efficiency, 0)}</option>{/each}
								</select>
								{#if lib}<span class="muted small">Typical: {sysLabel(lib.system)}</span>{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="muted small">Efficiencies: SABI Agricultural Design Norms 2021, Table 4 (mid-range values). Which systems the units use is yours to confirm.</p>

		{#each changes as ch (ch.cropId)}
			{@const s = byId.get(pick[ch.cropId] ?? '')}
			<section class="diff" aria-label="{ch.name}: changes">
				<div class="table-wrap">
					<table class="data compact">
						<caption>
							<strong>{ch.name || '(unnamed)'}</strong>
							{#if s}← {s.name}{#if kp !== 1} × Kp {kp}{/if}{/if}
						</caption>
						<thead>
							<tr>
								<th scope="col"><span class="visually-hidden">Factors</span></th>
								{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}
								<th scope="col" class="num">Eff.</th>
							</tr>
						</thead>
						<tbody>
							<tr>
								<th scope="row">Current</th>
								{#each ch.current as v, m (m)}<td class="num">{f2(v)}</td>{/each}
								<td class="num">{eff(ch.currentEfficiency)}</td>
							</tr>
							<tr>
								<th scope="row">New</th>
								{#each ch.next as v, m (m)}<td class="num" class:changed={ch.changed[m]}>{f2(v)}</td>{/each}
								<td class="num" class:changed={ch.nextEfficiency !== ch.currentEfficiency}>{eff(ch.nextEfficiency)}</td>
							</tr>
						</tbody>
					</table>
				</div>
				{#if s?.lib}<p class="muted small">{citation(s.lib)}. {s.lib.notes}</p>{:else if s}<p class="muted small">From [Crop demand] in {wb?.file}.</p>{/if}
				{#if ch.differs}
					<label class="small"><input type="checkbox" checked={!reject[ch.cropId]} onchange={(e) => (reject[ch.cropId] = !e.currentTarget.checked)} /> Apply to {ch.name || 'this crop'}</label>
				{:else}
					<p class="muted small">No change.</p>
				{/if}
			</section>
		{/each}

		{#if demand}
			<h3>Demand difference</h3>
			<p class="muted small">Mean gross irrigation demand before rain, m³/day, now and with the changes you apply (A-pan as saved). ÷ efficiency is what the unit abstracts for it.</p>
			<div class="table-wrap">
				<table class="data compact" data-testid="demand-difference">
					<thead>
						<tr>
							<th scope="col">Unit</th>
							<th scope="col" class="num">Gross now</th>
							<th scope="col" class="num">New</th>
							<th scope="col" class="num">Change</th>
							<th scope="col" class="num">÷ eff. now</th>
							<th scope="col" class="num">New</th>
							<th scope="col" class="num">Change</th>
						</tr>
					</thead>
					<tbody>
						{#each demand.rows as r (r.nodeId)}
							<tr>
								<th scope="row">{r.name}</th>
								<td class="num">{fmtNum(r.gross[0])}</td>
								<td class="num">{fmtNum(r.gross[1])}</td>
								<td class="num">{pctChange(r.gross)}</td>
								<td class="num">{fmtNum(r.abstraction[0])}</td>
								<td class="num">{fmtNum(r.abstraction[1])}</td>
								<td class="num">{pctChange(r.abstraction)}</td>
							</tr>
						{/each}
					</tbody>
					<tfoot>
						<tr>
							<th scope="row">Catchment</th>
							<td class="num">{fmtNum(demand.total.gross[0])}</td>
							<td class="num">{fmtNum(demand.total.gross[1])}</td>
							<td class="num" data-testid="demand-change">{pctChange(demand.total.gross)}</td>
							<td class="num">{fmtNum(demand.total.abstraction[0])}</td>
							<td class="num">{fmtNum(demand.total.abstraction[1])}</td>
							<td class="num">{pctChange(demand.total.abstraction)}</td>
						</tr>
					</tfoot>
				</table>
			</div>
			<div class="table-wrap">
				<table class="data compact">
					<caption class="small">Catchment gross demand by month, m³/day</caption>
					<thead>
						<tr><th scope="col"><span class="visually-hidden">Factors</span></th>{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}</tr>
					</thead>
					<tbody>
						<tr><th scope="row">Now</th>{#each demand.monthly[0] as v, m (m)}<td class="num">{fmtNum(v)}</td>{/each}</tr>
						<tr><th scope="row">New</th>{#each demand.monthly[1] as v, m (m)}<td class="num">{fmtNum(v)}</td>{/each}</tr>
					</tbody>
				</table>
			</div>
		{/if}
	{:else if !crops.length}
		<p class="muted">Add the project’s crops first, then load factors into them.</p>
	{/if}

	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (open = false)}>Cancel</button>
		<button type="button" class="btn btn-primary" disabled={!accepted.length} onclick={apply}>
			Apply {accepted.length} {accepted.length === 1 ? 'crop' : 'crops'}
		</button>
	{/snippet}
</Dialog>

<style>
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
		border: 0;
		padding: 0;
		margin: 0.5rem 0;
	}
	legend {
		font-weight: 600;
		margin-bottom: 0.25rem;
	}
	.kp,
	.plant {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.5rem;
		margin: 0.5rem 0;
	}
	.kp :global(input),
	.plant :global(input) {
		width: 5rem;
	}
	h3 {
		margin: 1rem 0 0.5rem;
		font-size: 1rem;
	}
	.diff {
		margin: 0.75rem 0;
	}
	caption {
		text-align: left;
		padding-bottom: 0.25rem;
	}
	td.changed {
		font-weight: 600;
		background: color-mix(in srgb, var(--accent) 15%, transparent);
	}
	.file {
		display: block;
		margin: 0.5rem 0;
	}
</style>
