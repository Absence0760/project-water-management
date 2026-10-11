<!--
	Settings → EWR → the daily EWR at the outlet (engine ≥ 1.77.0, issue #455,
	docs/model.md §2.9f, docs/ui.md § The daily EWR at the outlet): where the
	outlet's daily EWR comes from, the pragmatic EWR above, the Desktop Reserve
	Model's TAB file (12 monthly flows) or its percentile tables (natural and
	total Reserve flow, read at each day's natural flow), and how the tables are
	scaled to the modelled catchment (by MAR or by area), with the factor. The
	tables are typed, pasted, or loaded from the DRM's .tab / .rul files (the
	file load sits above the tables, with its Expected format); a .tab's
	converted flows are shown before they are used, and a file never changes
	the method on its own. Bind `value`
	(settings.ewrDailySource; null = the pragmatic EWR); `error` is set while it
	can't be saved, and shown under the fields as an alert unless `announce` is
	false (a scenario's change form, whose own alert says it on Add change, so a
	screen reader hears it once). Its own chunk: the Settings tab chunk sits at its size
	ceiling. Helpers in ./ewrDailySource.ts and ./drmFiles.ts.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { blankEwrDailySource, EWR_PERCENTILE_POINTS, type EwrDailySource } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import { latestFileText } from '$lib/files/latest';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import { fmtNum } from '$lib/format/number';
	import DrmFormatHelp from './DrmFormatHelp.svelte';
	import { parseDrmFile, percentileTablesFromRul, type TabFile } from './drmFiles';
	import { parseGrid } from './ewrRules';
	import { api } from '$lib/api';
	import { isScenarioRun } from '$lib/components/runs/scenarioRun';
	import ScaledEwrTablesView from './ScaledEwrTablesView.svelte';
	import { dailySourceError, knownScale, lastRunScale, parseMonthlyRow, rulLoad, scaledEwrTables, scaleFactor, type LastRunScale } from './ewrDailySource';

	let {
		value = $bindable(),
		error = $bindable(null),
		readonly = false,
		announce = true,
		modelAreaKm2,
		projectId = null
	}: {
		value: EwrDailySource | null | undefined;
		error?: string | null;
		readonly?: boolean;
		/** Show the problem as an alert (false: the parent's own alert announces it, so it isn't heard twice). */
		announce?: boolean;
		/** The area the run's natural flow is made on, km² (the area ratio's numerator; engine resolveCatchmentAreaKm2). */
		modelAreaKm2: number;
		/** The project, to read its last run's natural MAR for the MAR ratio's factor (none: the factor waits for a run). */
		projectId?: string | null;
	} = $props();

	const uid = $props.id();
	const src = $derived(value ?? blankEwrDailySource());
	const method = $derived(src.method);
	const POINT_LABELS = EWR_PERCENTILE_POINTS.map((p) => `${Math.round(p * 100)} %`);
	// The newest baseline run's natural MAR, read once per visit of the tab once the MAR ratio is in use (the run works
	// out its own s and reports it; this only shows it).
	let lastRun = $state<LastRunScale | null>(null);
	let lastAsked = false;
	$effect(() => {
		if (lastAsked || !projectId || src.method === 'pragmatic' || src.scaling !== 'mar') return;
		lastAsked = true;
		const id = projectId;
		void (async () => {
			try {
				const runs = await api.runs.list(id);
				// The newest baseline run: a scenario's or a forecast's natural flow isn't the project's.
				const baseline = runs.filter((r) => !isScenarioRun(r) && !r.forecastFrom);
				const latest = baseline.reduce<(typeof runs)[number] | null>((a, r) => (!a || Date.parse(r.createdAt) > Date.parse(a.createdAt) ? r : a), null);
				if (latest) lastRun = lastRunScale((await api.runs.get(id, latest.id)).run.summary);
			} catch {
				// The factor line then says to run the model; the run reports s either way.
				lastRun = null;
			}
		})();
	});
	const factor = $derived(scaleFactor(src, modelAreaKm2, lastRun));
	// The tables × s as the run reads them (issue #90 B1 gap a), once s is known.
	const scaled = $derived(scaledEwrTables(src, knownScale(src, modelAreaKm2, lastRun)));

	$effect(() => {
		error = dailySourceError(value);
	});

	/** Edit the source, starting one from the blank when the project has none. */
	function edit(patch: Partial<EwrDailySource>) {
		value = { ...$state.snapshot(src), ...patch } as EwrDailySource;
	}

	// What the last file did, said beside the picker; what the last paste did, under the paste box.
	let note = $state<{ ok: boolean; text: string } | null>(null);
	let pasteNote = $state<{ ok: boolean; text: string } | null>(null);
	// A .rul loaded under another method filled the percentile tables without switching to them: offer the switch.
	let offerPercentile = $state(false);
	let tabPreview = $state<{ file: string; tab: TabFile } | null>(null);
	let pasteTab = $state('');
	let pasteGrid = $state('');
	const read = latestFileText();

	async function loadFile(e: Event & { currentTarget: HTMLInputElement }) {
		const f = e.currentTarget.files?.[0];
		e.currentTarget.value = '';
		if (!f) return;
		const text = await read(f);
		if (text === null) return;
		offerPercentile = false;
		const drm = parseDrmFile(text);
		if (drm === null) {
			note = { ok: false, text: `${f.name} isn't a Desktop Reserve Model .tab or .rul file. Paste a CSV's rows into the paste box below the tables instead.` };
			return;
		}
		if ('error' in drm) {
			note = { ok: false, text: `${f.name}: ${drm.error}` };
			return;
		}
		if (drm.kind === 'tab') {
			// Shown first: the converted m³/s next to the file's Mm³, used only on the person's say.
			tabPreview = { file: f.name, tab: drm };
			note = {
				ok: true,
				text:
					method === 'tab'
						? `Read ${f.name} (DRM summary). Check the converted flows below, then use them.`
						: `Read ${f.name} (DRM summary). Its MAR scales the percentile tables; its flows are for the TAB file method.`
			};
			return;
		}
		const tables = percentileTablesFromRul(drm);
		if ('error' in tables) {
			note = { ok: false, text: `${f.name}: ${tables.error}` };
			return;
		}
		if ((src.naturalPctM3s || src.reservePctM3s) && !(await confirmDialog({ title: `Replace the percentile tables with ${f.name}?`, message: 'Both tables will be replaced by the file’s.', confirmLabel: 'Replace the tables' }))) return;
		// A .rul fills the percentile tables and nothing else: the method stays as picked, and the switch is offered.
		const out = rulLoad(method, tables, f.name, drm.unit);
		edit(out.patch);
		note = { ok: true, text: out.text };
		offerPercentile = out.offerPercentile;
	}

	function usePercentile() {
		edit({ method: 'percentile' });
		offerPercentile = false;
		note = { ok: true, text: 'The daily EWR now comes from the DRM percentile tables.' };
	}

	/** Under the TAB method its flows and MAR; under the percentile tables its MAR only (its flows are another method's). */
	function useTab() {
		if (!tabPreview) return;
		const { tab, file } = tabPreview;
		const mar = tab.marMm3 !== null ? { tableMarMm3: tab.marMm3 } : {};
		if (method === 'tab') {
			edit({ tabM3s: [...tab.totalMaintM3s], ...mar });
			note = { ok: true, text: `Used ${file}: the 12 TAB flows${tab.marMm3 !== null ? ` and the table MAR, ${tab.marMm3} Mm³/a` : ''}.` };
		} else {
			edit(mar);
			note = { ok: true, text: tab.marMm3 !== null ? `Used ${file}'s MAR, ${tab.marMm3} Mm³/a, as the table MAR.` : `${file} has no MAR line: nothing used.` };
		}
		tabPreview = null;
	}

	function fillTab() {
		const row = parseMonthlyRow(pasteTab);
		if ('error' in row) {
			pasteNote = { ok: false, text: row.error };
			return;
		}
		edit({ tabM3s: row.values });
		pasteNote = { ok: true, text: 'Filled the 12 TAB flows.' };
		pasteTab = '';
	}

	function fillGrid(which: 'naturalPctM3s' | 'reservePctM3s') {
		const g = parseGrid(pasteGrid);
		if ('error' in g) {
			pasteNote = { ok: false, text: g.error };
			return;
		}
		if (g.rows[0]!.length !== EWR_PERCENTILE_POINTS.length) {
			pasteNote = { ok: false, text: `The paste has ${g.rows[0]!.length} values a row; the table has ${EWR_PERCENTILE_POINTS.length}, one per point (10 % … 99 %).` };
			return;
		}
		edit({ [which]: g.rows.map((r) => [...r]) });
		pasteNote = { ok: true, text: [`Filled the ${which === 'naturalPctM3s' ? 'natural flow' : 'total Reserve flow'} table${g.monthLabels ? ' (rows matched by month name)' : ' (rows read as Oct … Sep)'}.`, ...g.notes].join(' ') };
		pasteGrid = '';
	}

	function setCell(which: 'naturalPctM3s' | 'reservePctM3s', r: number, c: number, v: number | null) {
		const grid = (untrack(() => $state.snapshot(src[which])) as number[][] | null) ?? WATER_YEAR_MONTHS.map(() => EWR_PERCENTILE_POINTS.map(() => null as unknown as number));
		grid[r]![c] = v as number;
		edit({ [which]: grid });
	}

	function setTab(i: number, v: number | null) {
		const row = (untrack(() => $state.snapshot(src.tabM3s)) as number[] | null) ?? WATER_YEAR_MONTHS.map(() => null as unknown as number);
		row[i] = v as number;
		edit({ tabM3s: row });
	}

	// The CSV layout the Expected format offers beside the DRM files (synthetic numbers).
</script>

<fieldset class="plain daily" data-testid="ewr-daily-source">
	<legend>The daily EWR at the outlet <HelpTip key="settings.ewrDailySource" /></legend>
	<div class="fields">
		<div class="field">
			<label for="{uid}-method">Daily EWR from</label>
			<select id="{uid}-method" disabled={readonly} value={method} onchange={(e) => edit({ method: e.currentTarget.value as EwrDailySource['method'] })} aria-describedby="{uid}-method-h">
				<option value="pragmatic">The pragmatic EWR (above)</option>
				<option value="tab">The DRM TAB file (monthly total flows)</option>
				<option value="percentile">The DRM percentile tables (read at each day’s natural flow)</option>
			</select>
			<span class="hint" id="{uid}-method-h">
				The outlet’s daily EWR, which is split between the units and judged every day: shortfalls, the charge, curtailment and the compliance grid all follow it.
				{#if method === 'tab'}Each month’s TAB flow × the scale factor, every day of the month.{:else if method === 'percentile'}Each day, the Reserve flow at the point the day’s natural flow at the outlet sits at in that month’s natural flows, interpolated between points, × the scale factor.{/if}
			</span>
		</div>
		{#if method !== 'pragmatic'}
			<div class="field">
				<label for="{uid}-scaling">Scale the tables by</label>
				<select id="{uid}-scaling" disabled={readonly} value={src.scaling} onchange={(e) => edit({ scaling: e.currentTarget.value as EwrDailySource['scaling'] })} aria-describedby="{uid}-s-h">
					<option value="area">Area ratio: the modelled area ÷ the table’s (the default)</option>
					<option value="mar">MAR ratio: the model’s natural MAR ÷ the table’s</option>
				</select>
			</div>
			<div class="field">
				<label for="{uid}-mar">Table MAR <span class="u">(Mm³/a)</span></label>
				<NumberInput id="{uid}-mar" min={0} nullable disabled={readonly} value={src.tableMarMm3} onchange={(v) => edit({ tableMarMm3: v })} aria-describedby="{uid}-mar-h" />
				<span class="hint" id="{uid}-mar-h">The natural MAR the tables were determined for, the TAB header’s “MAR =”.</span>
			</div>
			<div class="field">
				<label for="{uid}-area">Table catchment area <span class="u">(km²)</span></label>
				<NumberInput id="{uid}-area" min={0} nullable disabled={readonly} value={src.tableAreaKm2} onchange={(v) => edit({ tableAreaKm2: v })} aria-describedby="{uid}-area-h" />
				<span class="hint" id="{uid}-area-h">Needed for the area ratio (the default). The modelled area is {fmtNum(modelAreaKm2, 1)} km², the area the natural flow is made on (the calibration catchment area when set, else the units’ areas).</span>
			</div>
			<p class="factor" id="{uid}-s-h" data-testid="ewr-scale-factor" aria-live="polite">{factor}</p>
		{/if}
	</div>

	{#if method !== 'pragmatic'}
		{#if !readonly}
			<div class="load" data-testid="ewr-daily-load">
				<div class="load-row">
					<label class="btn btn-sm file">
						Load a DRM file (.rul / .tab)
						<input type="file" accept=".tab,.rul,.txt,text/plain" onchange={loadFile} data-testid="ewr-daily-file" aria-describedby="{uid}-load-h" />
					</label>
					<span class="hint" id="{uid}-load-h">A .tab gives the TAB flows and the table MAR, a .rul the two percentile tables. A file never changes the choice in Daily EWR from.</span>
				</div>
				<p class="small" class:err={note && !note.ok} role="status" aria-label="File result">{note?.text ?? ''}</p>
				{#if offerPercentile && method !== 'percentile'}
					<div class="actions"><button type="button" class="btn btn-sm" onclick={usePercentile}>Use the percentile tables</button></div>
				{/if}
				{#if tabPreview}
					<div class="preview" data-testid="ewr-tab-preview">
						<div class="table-wrap">
							<table class="data compact monthly">
								<caption>{tabPreview.file}: total flows, maintenance, converted (÷ the month’s days × 86 400 s, February 28 days)</caption>
								<thead>
									<tr>
										<th scope="col" class="sticky">Unit</th>
										{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}
									</tr>
								</thead>
								<tbody>
									<tr>
										<th scope="row" class="sticky">Mm³</th>
										{#each tabPreview.tab.totalMaintMcm as v, i (i)}<td class="num">{fmtNum(v, 3)}</td>{/each}
									</tr>
									<tr>
										<th scope="row" class="sticky">m³/s</th>
										{#each tabPreview.tab.totalMaintM3s as v, i (i)}<td class="num">{fmtNum(v, 4)}</td>{/each}
									</tr>
								</tbody>
							</table>
						</div>
						<p class="small">
							{tabPreview.tab.marMm3 !== null ? `MAR ${tabPreview.tab.marMm3} Mm³/a (the table MAR). ` : 'No MAR line. '}{tabPreview.tab.category ? `Ecological category ${tabPreview.tab.category}. ` : ''}
							A .tab and a .rul from the same determination go together: the .tab’s MAR scales the .rul’s percentile tables too.
						</p>
						<div class="actions">
							<button type="button" class="btn btn-sm btn-primary" onclick={useTab}>{method === 'tab' ? 'Use these values' : 'Use its MAR only'}</button>
							<button type="button" class="btn btn-sm btn-ghost" onclick={() => (tabPreview = null)}>Cancel</button>
						</div>
					</div>
				{/if}
				<DrmFormatHelp target="dailyEwr" context="of a file for the daily EWR at the outlet" />
			</div>
		{/if}

		{#if method === 'tab'}
			<div class="table-wrap">
				<table class="data compact monthly">
					<caption>TAB flows: total flows, maintenance <span class="u">(m³/s, before scaling)</span></caption>
					<thead>
						<tr>
							<th scope="col" class="sticky">Month</th>
							{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}
						</tr>
					</thead>
					<tbody>
						<tr>
							<th scope="row" class="sticky">m³/s</th>
							{#each WATER_YEAR_MONTHS as m, i (m)}
								<td><NumberInput label="TAB flow, {m}, m³/s" min={0} nullable disabled={readonly} value={src.tabM3s?.[i] ?? null} onchange={(v) => setTab(i, v)} /></td>
							{/each}
						</tr>
					</tbody>
				</table>
			</div>
		{:else}
			{#snippet grid(which: 'naturalPctM3s' | 'reservePctM3s', label: string)}
				<div class="table-wrap">
					<table class="data compact rulegrid">
						<caption>{label} <span class="u">(m³/s, before scaling)</span></caption>
						<thead>
							<tr>
								<th scope="col" class="sticky">Month</th>
								{#each POINT_LABELS as p (p)}<th scope="col" class="num">{p}</th>{/each}
							</tr>
						</thead>
						<tbody>
							{#each WATER_YEAR_MONTHS as m, r (m)}
								<tr>
									<th scope="row" class="sticky">{m}</th>
									{#each POINT_LABELS as p, c (p)}
										<td><NumberInput label="{label}, {m}, {p}, m³/s" min={0} nullable disabled={readonly} value={src[which]?.[r]?.[c] ?? null} onchange={(v) => setCell(which, r, c, v)} /></td>
									{/each}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/snippet}
			{@render grid('naturalPctM3s', 'Natural flow percentile table')}
			{@render grid('reservePctM3s', 'Total Reserve flow percentile table')}
		{/if}

		<details class="scaled-wrap" open data-testid="ewr-scaled">
			<summary>The tables scaled to the model (each value × s)</summary>
			{#if scaled}
				<ScaledEwrTablesView tables={scaled} />
			{:else}
				<p class="small" data-testid="ewr-scaled-pending">The scaled tables show here once the tables and the scale factor are known (see the scale factor above).</p>
			{/if}
		</details>

		{#if !readonly}
			<div class="paste">
				{#if method === 'tab'}
					<label for="{uid}-paste">Or paste the 12 flows (m³/s, Oct … Sep, in a row or a column)</label>
					<textarea id="{uid}-paste" rows="2" value={pasteTab} oninput={(e) => (pasteTab = e.currentTarget.value)} aria-describedby="{uid}-paste-s"></textarea>
					<div class="actions"><button type="button" class="btn btn-sm" onclick={fillTab}>Fill the TAB flows</button></div>
				{:else}
					<label for="{uid}-paste">Or paste a table (12 month rows × 10 points, m³/s)</label>
					<textarea id="{uid}-paste" rows="3" value={pasteGrid} oninput={(e) => (pasteGrid = e.currentTarget.value)} aria-describedby="{uid}-paste-s"></textarea>
					<div class="actions">
						<button type="button" class="btn btn-sm" onclick={() => fillGrid('naturalPctM3s')}>Fill the natural flow table</button>
						<button type="button" class="btn btn-sm" onclick={() => fillGrid('reservePctM3s')}>Fill the total Reserve table</button>
					</div>
				{/if}
				<p class="small" id="{uid}-paste-s" class:err={pasteNote && !pasteNote.ok} role="status" aria-label="Paste result">{pasteNote?.text ?? ''}</p>
			</div>
		{/if}
	{/if}
	{#if error}<p class="err" role={announce ? 'alert' : undefined} data-testid="ewr-daily-error">{error}</p>{/if}
</fieldset>

<style>
	.daily {
		border: 0;
		padding: 0;
		margin: 1rem 0 0.75rem;
		min-width: 0;
	}
	legend {
		font-weight: 600;
		font-size: 0.95rem;
		color: var(--text-2);
		margin-bottom: 0.35rem;
		padding: 0;
	}
	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 0 1.25rem;
	}
	.field :global(input),
	.field select {
		width: 100%;
	}
	.hint {
		font-size: 0.8rem;
		max-width: 75ch;
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
		font-size: 0.8rem;
	}
	.factor {
		grid-column: 1 / -1;
		font-size: 0.85rem;
		margin: 0.25rem 0 0.5rem;
	}
	caption {
		text-align: left;
		font-size: 0.85rem;
		font-weight: 500;
		padding: 0.5rem 0 0.25rem;
	}
	th.sticky {
		position: sticky;
		left: 0;
		z-index: 2;
		background: var(--surface);
		white-space: nowrap;
	}
	thead th.sticky {
		background: var(--surface-2);
		z-index: 3;
	}
	.rulegrid td,
	.monthly td {
		min-width: 78px;
		padding-left: 0.3rem;
		padding-right: 0.3rem;
	}
	.load,
	.paste,
	.preview {
		display: grid;
		gap: 0.35rem;
		margin-top: 0.75rem;
		max-width: 75ch;
	}
	.load-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.35rem 0.75rem;
	}
	.load p,
	.paste p {
		margin: 0;
	}
	.paste label {
		font-weight: 500;
		font-size: 0.85rem;
	}
	.paste textarea {
		width: 100%;
		font-family: var(--font-mono, monospace);
		font-size: 0.8rem;
	}
	.file {
		justify-self: start;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.err {
		color: var(--danger);
		font-size: 0.8rem;
	}
	.scaled-wrap {
		margin-top: 0.75rem;
	}
	.scaled-wrap summary {
		font-weight: 500;
		font-size: 0.85rem;
		cursor: pointer;
	}
	.scaled-wrap p {
		margin: 0.35rem 0 0;
	}
</style>
