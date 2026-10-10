<!--
	The per-table editor of Settings → Reserve rule tables (EwrRulesSection.svelte,
	which loads it only once the project has a table, so a project without one
	downloads none of it): first the file load (a DRM .rul / .tab or a CSV,
	with its Expected format), since a .rul fills nearly every field below; then
	site, source and its kind, the REC, what it covers, unit, natural source,
	scale, the determination's natural MAR, % points, the EWR and natural grids, paste from a spreadsheet, the
	plausibility notes and Remove. Remove, and a Fill over a grid that already
	holds values, ask first. Helpers in ./ewrRules.ts.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { EWR_ASSURANCE_MIN_YEARS, EWR_NATURAL_MAR_TOLERANCE, type EwrRuleTable } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import { latestFileText } from '$lib/files/latest';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import EwrHighFlowsEditor from './EwrHighFlowsEditor.svelte';
	import DrmFormatHelp from './DrmFormatHelp.svelte';
	import { parseDrmFile, ruleTableFromRul, ruleTableFromTab } from './drmFiles';
	import {
		applyPaste,
		categoryFromText,
		filledCells,
		naturalComplete,
		parseGrid,
		parsePoints,
		setLowFlowSplit,
		setPoints,
		tableErrors,
		tableNotes,
		type GridKey,
		type SiteOption
	} from './ewrRules';

	let {
		value = $bindable(),
		readonly = false,
		options
	}: {
		value: EwrRuleTable[];
		readonly?: boolean;
		/** The EWR sites a table can be at (siteOptions). */
		options: readonly SiteOption[];
	} = $props();

	const uid = $props.id();
	const UNIT = { mcm: 'Mm³', m3s: 'm³/s' } as const;

	// Text the user is typing into each table's points field and paste box, by position.
	let pointsText = $state<string[]>(untrack(() => value.map((t) => t.points.join(', '))));
	let pointsBad = $state<boolean[]>([]);
	let pasteText = $state<string[]>([]);
	let pasteNote = $state<{ ok: boolean; text: string }[]>([]);
	// What the last file load did, said beside the file picker at the top (the paste box's result stays under it).
	let fileNote = $state<{ ok: boolean; text: string }[]>([]);

	// A new table, Discard or a save can change the tables under the typed points: follow them, unless the text is mid-edit and not yet valid.
	$effect(() => {
		value.forEach((t, i) => {
			if (untrack(() => pointsBad[i])) return;
			const typed = parsePoints(untrack(() => pointsText[i]) ?? '');
			if (!typed || typed.join() !== t.points.join()) pointsText[i] = t.points.join(', ');
		});
		if (untrack(() => pointsText.length) > value.length) pointsText.length = value.length;
	});

	const siteLabel = (id: string | null) => options.find((o) => o.id === id)?.label ?? 'Outlet';

	async function remove(i: number) {
		const t = value[i]!;
		const grids = ['EWR', ...(t.lowFlow ? ['low-flow'] : []), ...(t.natural ? ['natural-flow'] : [])];
		const ok = await confirmDialog({
			title: `Remove the rule table at ${siteLabel(t.siteNodeId)}?`,
			message: `Its ${grids.join(', ')} grid${grids.length === 1 ? '' : 's'}${t.highFlows?.length ? `, ${t.highFlows.length} high-flow component${t.highFlows.length === 1 ? '' : 's'}` : ''} and source go with it.`,
			confirmLabel: 'Remove the table',
			danger: true
		});
		if (!ok) return;
		value.splice(i, 1);
		for (const list of [pointsText, pointsBad, pasteText, pasteNote, fileNote, readers] as unknown[][]) list.splice(i, 1);
	}

	function onPoints(i: number, text: string) {
		pointsText[i] = text;
		const p = parsePoints(text);
		pointsBad[i] = p === null;
		if (p) value[i] = setPoints(value[i]!, p);
	}

	function setNaturalSource(i: number, source: EwrRuleTable['naturalSource']) {
		const t = value[i]!;
		t.naturalSource = source;
		if (source === 'table' && !t.natural) t.natural = Array.from({ length: 12 }, () => t.points.map(() => null as unknown as number));
		// From the run, the natural grid isn't used: keep a complete one (switching back restores it), drop a half-typed one so it can't block Save.
		if (source === 'run' && t.natural && !naturalComplete(t.natural)) t.natural = null;
	}

	/** What the table covers: a low-flow table can't also carry a separate low-flow grid, so switching to it drops one. */
	function setComponent(i: number, component: EwrRuleTable['component']) {
		value[i] = { ...value[i]!, component, ...(component === 'lowFlow' ? { lowFlow: null } : {}) };
	}

	/**
	 * A Desktop Reserve Model file fills the table at once (issue #455): a .rul its grids, unit, points and REC
	 * (asking first over values), a .tab its natural MAR and REC. Any other text file (a CSV) goes into the paste
	 * box, to fill whichever grid the user picks. What happened is said beside the picker, at the top of the table.
	 */
	// One file reader per table, removed with it: the latest file picked for a table wins (a
	// large one still read can't land over a smaller one picked after it), and a read lands in
	// the table it was picked for even when a table above it was removed meanwhile.
	const readers: ReturnType<typeof latestFileText>[] = [];
	async function loadFile(i: number, e: Event & { currentTarget: HTMLInputElement }) {
		const f = e.currentTarget.files?.[0];
		e.currentTarget.value = '';
		if (!f) return;
		const reader = (readers[i] ??= latestFileText());
		const text = await reader(f);
		const at = readers.indexOf(reader);
		if (text === null || at < 0) return;
		const drm = parseDrmFile(text);
		if (drm === null) {
			pasteText[at] = text;
			fileNote[at] = { ok: true, text: `Read ${f.name} into the paste box below the table: pick which values to fill.` };
			return;
		}
		if ('error' in drm) {
			fileNote[at] = { ok: false, text: `${f.name}: ${drm.error}` };
			return;
		}
		const t = value[at]!;
		if (drm.kind === 'tab') {
			value[at] = ruleTableFromTab(t, drm);
			fileNote[at] = {
				ok: true,
				text: `Read ${f.name} (DRM summary): ${drm.marMm3 !== null ? `the natural MAR, ${drm.marMm3} Mm³/a` : 'no MAR'}${drm.category ? ` and the REC, ${drm.category}` : ''}. Its monthly totals aren't a rule table: load the .rul file for the % points.`
			};
			return;
		}
		const filled = filledCells(t.ewr) + filledCells(t.lowFlow) + filledCells(t.natural);
		if (
			filled &&
			!(await confirmDialog({
				title: `Replace the rule table at ${siteLabel(t.siteNodeId)} with ${f.name}?`,
				message: `${filled === 1 ? 'The 1 value' : `The ${filled} values`} in its grids will be replaced by the file's, and its unit and % points by the file's.`,
				confirmLabel: 'Replace the values'
			}))
		)
			return;
		const next = ruleTableFromRul(t, drm, f.name);
		value[at] = next;
		pointsText[at] = next.points.join(', ');
		pointsBad[at] = false;
		fileNote[at] = {
			ok: true,
			text:
				`Read ${f.name} (DRM rule curves, ${drm.unit === 'm3s' ? 'm³/s' : 'Mm³ a month'}): the total Reserve as the EWR` +
				`${drm.lowFlow ? ', the low flows' : ''}${drm.natural ? ', the natural duration curve' : ''}${drm.category ? ` and the REC, ${drm.category}` : ''}.` +
				(drm.natural && next.naturalSource === 'run' ? ' To place each month on the file’s natural curve, set “Natural-flow percentile from” to the table’s natural flows.' : '') +
				(drm.lowFlow ? '' : ' The file has no low-flow block.')
		};
	}

	async function paste(i: number, which: GridKey) {
		const g = parseGrid(pasteText[i] ?? '');
		if ('error' in g) {
			pasteNote[i] = { ok: false, text: g.error };
			return;
		}
		const out = applyPaste(value[i]!, which, g);
		if ('error' in out) {
			pasteNote[i] = { ok: false, text: out.error };
			return;
		}
		// Over a grid that already holds values: say how many cells are replaced, and ask.
		const t = value[i]!;
		const filled = filledCells(which === 'ewr' ? t.ewr : which === 'lowFlow' ? t.lowFlow : t.natural);
		const name = which === 'ewr' ? 'EWR' : which === 'lowFlow' ? 'low-flow' : 'natural-flow';
		if (
			filled &&
			!(await confirmDialog({
				title: `Replace the ${name} values at ${siteLabel(t.siteNodeId)}?`,
				message: `${filled === 1 ? 'The 1 value' : `The ${filled} values`} in the grid will be replaced by the pasted ones.`,
				confirmLabel: 'Replace the values'
			}))
		)
			return;
		value[i] = out;
		pointsText[i] = out.points.join(', ');
		pointsBad[i] = false;
		const what = which === 'ewr' ? 'EWR' : which === 'lowFlow' ? 'low-flow' : 'natural flow';
		pasteNote[i] = {
			ok: true,
			text: [`Filled the ${what} values: 12 months × ${out.points.length} % points${g.monthLabels ? ' (rows matched by month name)' : ' (rows read as Oct … Sep)'}.`, ...g.notes].join(' ')
		};
		pasteText[i] = '';
	}
</script>

{#each value as t, i (i)}
	{@const errs = tableErrors(t)}
	{@const notes = Object.keys(errs).length ? [] : tableNotes(t)}
	{@const u = UNIT[t.unit] ?? t.unit}
	<fieldset class="plain rule" aria-describedby="{uid}-{i}-file {uid}-{i}-status">
		<legend>Rule table at {siteLabel(t.siteNodeId)}</legend>
		{#if !readonly}
			<div class="load" data-testid="rule-file-load">
				<div class="load-row">
					<label class="btn btn-sm file">
						Load a DRM file (.rul / .tab) or a CSV
						<input type="file" accept=".rul,.tab,.csv,.tsv,.txt,text/csv,text/plain" onchange={(e) => loadFile(i, e)} aria-describedby="{uid}-{i}-load-h" />
					</label>
					<span class="hint" id="{uid}-{i}-load-h">A .rul fills the grids, unit, % points and REC; a .tab the natural MAR and REC; a CSV goes into the paste box below the table.</span>
				</div>
				<p id="{uid}-{i}-file" class="small" class:err={fileNote[i] && !fileNote[i].ok} role="status" aria-label="File result">{fileNote[i]?.text ?? ''}</p>
				<DrmFormatHelp target="ruleTable" context="of a file for the rule table at {siteLabel(t.siteNodeId)}" />
			</div>
		{/if}
		<div class="fields">
			<div class="field">
				<label for="{uid}-{i}-site">EWR site</label>
				<select id="{uid}-{i}-site" disabled={readonly} bind:value={t.siteNodeId}>
					{#each options as o (o.id ?? '(outlet)')}
						<option value={o.id} disabled={o.id !== t.siteNodeId && value.some((x) => x.siteNodeId === o.id)}>{o.label}</option>
					{/each}
				</select>
			</div>
			<div class="field wide">
				<label for="{uid}-{i}-src">Source</label>
				<input
					id="{uid}-{i}-src"
					readonly={readonly}
					maxlength="500"
					placeholder="Reserve determination, gazette notice, table"
					bind:value={t.source}
					aria-invalid={errs.source ? 'true' : undefined}
					aria-describedby="{uid}-{i}-src-e"
				/>
				{#if errs.source}<span class="err" id="{uid}-{i}-src-e">{errs.source}</span>{/if}
			</div>
			<div class="field">
				<label for="{uid}-{i}-kind">Kind of source</label>
				<select
					id="{uid}-{i}-kind"
					disabled={readonly}
					value={t.sourceKind ?? ''}
					onchange={(e) => (t.sourceKind = (e.currentTarget.value || null) as EwrRuleTable['sourceKind'])}
					aria-describedby="{uid}-{i}-kind-h"
				>
					<option value="">Not stated</option>
					<option value="gazetted">Gazetted Reserve</option>
					<option value="desktop">Desktop estimate (low confidence)</option>
					<option value="other">Other</option>
				</select>
				<span class="hint" id="{uid}-{i}-kind-h">
					{#if errs.sourceKind}<span class="err">{errs.sourceKind}</span>{:else}Shown beside the Reserve results and in the printed report as its confidence.{/if}
				</span>
			</div>
			<div class="field">
				<label for="{uid}-{i}-rec">Recommended ecological category (REC)</label>
				<input
					id="{uid}-{i}-rec"
					readonly={readonly}
					maxlength="5"
					placeholder="e.g. B/C"
					value={t.category ?? ''}
					oninput={(e) => (t.category = categoryFromText(e.currentTarget.value))}
					aria-invalid={errs.category ? 'true' : undefined}
					aria-describedby="{uid}-{i}-rec-h"
				/>
				<span class="hint" id="{uid}-{i}-rec-h">
					{#if errs.category}<span class="err">{errs.category}</span>{:else}As the determination states it: A to F, or a band like B/C. A label for the evidence report; no result depends on it.{/if}
				</span>
			</div>
			<div class="field">
				<label for="{uid}-{i}-comp">The table covers</label>
				<select id="{uid}-{i}-comp" disabled={readonly} value={t.component} onchange={(e) => setComponent(i, e.currentTarget.value as EwrRuleTable['component'])}>
					<option value="total">Total flow (low and high flows)</option>
					<option value="lowFlow">Low flows only</option>
				</select>
				{#if t.component === 'total'}
					<label class="check">
						<input type="checkbox" disabled={readonly} checked={!!t.lowFlow} onchange={(e) => (value[i] = setLowFlowSplit(t, e.currentTarget.checked))} />
						Also enter the low flows (maintenance and drought), to see which part fails
					</label>
				{/if}
			</div>
			<div class="field">
				<label for="{uid}-{i}-unit">Unit</label>
				<select id="{uid}-{i}-unit" disabled={readonly} bind:value={t.unit} aria-describedby="{uid}-{i}-unit-h">
					<option value="mcm">Mm³ per month</option>
					<option value="m3s">m³/s (the month’s mean flow)</option>
				</select>
				<span class="hint" id="{uid}-{i}-unit-h">As the table gives it; the run compares in the same unit.</span>
			</div>
			<div class="field">
				<label for="{uid}-{i}-nat">Natural-flow percentile from</label>
				<select
					id="{uid}-{i}-nat"
					disabled={readonly}
					value={t.naturalSource}
					onchange={(e) => setNaturalSource(i, e.currentTarget.value as EwrRuleTable['naturalSource'])}
					aria-describedby="{uid}-{i}-nat-h"
				>
					<option value="run">The run’s natural flow at the site</option>
					<option value="table">The table’s natural flows</option>
				</select>
				<span class="hint" id="{uid}-{i}-nat-h">
					{t.naturalSource === 'run'
						? `Each month is ranked among the same month in every complete year of the run; fewer than ${EWR_ASSURANCE_MIN_YEARS} years is flagged as coarse.`
						: 'Enter the natural flow the determination gives at each point (its natural flow duration curve).'}
				</span>
			</div>
			<div class="field">
				<label for="{uid}-{i}-scale">Scale the table by</label>
				<NumberInput id="{uid}-{i}-scale" min={0} max={1000} nullable disabled={readonly} bind:value={t.scale} aria-describedby="{uid}-{i}-scale-h" />
				<span class="hint" id="{uid}-{i}-scale-h">
					{#if errs.scale}<span class="err">{errs.scale}</span>{:else}1 unless the table is for a different catchment size, e.g. site area ÷ table area.{/if}
				</span>
			</div>
			<div class="field">
				<label for="{uid}-{i}-mar">Natural MAR in the determination (Mm³/a)</label>
				<NumberInput
					id="{uid}-{i}-mar"
					min={0}
					nullable
					disabled={readonly}
					bind:value={() => t.naturalMarMcm ?? null, (v) => (t.naturalMarMcm = v)}
					aria-invalid={errs.naturalMarMcm ? 'true' : undefined}
					aria-describedby="{uid}-{i}-mar-h"
				/>
				<span class="hint" id="{uid}-{i}-mar-h">
					{#if errs.naturalMarMcm}<span class="err">{errs.naturalMarMcm}</span>{:else}Optional, scaled like the table. The run compares its own natural MAR at the site{t.naturalSource === 'run'
							? ` and warns beyond ±${100 * EWR_NATURAL_MAR_TOLERANCE} %`
							: ''}.{/if}
				</span>
			</div>
			<div class="field">
				<label for="{uid}-{i}-pts">% points</label>
				<input
					id="{uid}-{i}-pts"
					readonly={readonly}
					value={pointsText[i] ?? t.points.join(', ')}
					oninput={(e) => onPoints(i, e.currentTarget.value)}
					aria-invalid={pointsBad[i] || errs.points ? 'true' : undefined}
					aria-describedby="{uid}-{i}-pts-h"
				/>
				<span class="hint" id="{uid}-{i}-pts-h">
					{#if pointsBad[i]}<span class="err">Enter numbers separated by commas.</span>{:else if errs.points}<span class="err">{errs.points}</span>{:else}Exceedance %, rising (the DRM uses 10, 20 … 90, 99).{/if}
				</span>
			</div>
		</div>

		{#snippet grid(which: GridKey, label: string)}
			{@const rows = which === 'ewr' ? t.ewr : which === 'lowFlow' ? t.lowFlow! : t.natural!}
			<div class="table-wrap">
				<table class="data compact rulegrid">
					<caption>{label} at each % point <span class="u">({u})</span></caption>
					<thead>
						<tr>
							<th scope="col" class="sticky">Month</th>
							{#each t.points as p (p)}<th scope="col" class="num">{p} %</th>{/each}
						</tr>
					</thead>
					<tbody>
						{#each WATER_YEAR_MONTHS as m, r (m)}
							<tr>
								<th scope="row" class="sticky">{m}</th>
								{#each t.points as p, c (p)}
									<td>
										<NumberInput
											label="{label}, {m}, {p} %, {u}"
											min={0}
											nullable
											disabled={readonly}
											value={rows[r]?.[c] ?? null}
											onchange={(v) => (rows[r]![c] = v as number)}
										/>
									</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/snippet}
		{@render grid('ewr', t.component === 'lowFlow' ? 'EWR (low flows)' : t.lowFlow ? 'EWR (total flow)' : 'EWR')}
		{#if errs.ewr}<p class="err" role="alert">{errs.ewr}</p>{/if}
		{#if t.component === 'total' && t.lowFlow}
			{@render grid('lowFlow', 'Low flows (maintenance to drought)')}
			{#if errs.lowFlow}<p class="err" role="alert">{errs.lowFlow}</p>{/if}
		{/if}
		{#if t.naturalSource === 'table' && t.natural}
			{@render grid('natural', 'Natural flow')}
			{#if errs.natural}<p class="err" role="alert">{errs.natural}</p>{/if}
		{/if}

		{#if !readonly}
			<div class="paste">
				<label for="{uid}-{i}-paste">Paste from a spreadsheet</label>
				<textarea
					id="{uid}-{i}-paste"
					rows="4"
					placeholder={'Copy the 12 month rows (Oct … Sep, or with month names in the first column), optionally with the heading row of % points, and paste here.'}
					value={pasteText[i] ?? ''}
					oninput={(e) => (pasteText[i] = e.currentTarget.value)}
					aria-describedby="{uid}-{i}-status"
				></textarea>
				<div class="actions">
					<button type="button" class="btn btn-sm" onclick={() => paste(i, 'ewr')}>Fill the EWR values</button>
					{#if t.component === 'total' && t.lowFlow}
						<button type="button" class="btn btn-sm" onclick={() => paste(i, 'lowFlow')}>Fill the low flows</button>
					{/if}
					{#if t.naturalSource === 'table'}
						<button type="button" class="btn btn-sm" onclick={() => paste(i, 'natural')}>Fill the natural flows</button>
					{/if}
				</div>
			</div>
		{/if}
		<EwrHighFlowsEditor bind:value={() => t.highFlows ?? [], (v) => (t.highFlows = v)} {readonly} siteLabel={siteLabel(t.siteNodeId)} />
		<p id="{uid}-{i}-status" class="small" class:err={pasteNote[i] && !pasteNote[i].ok} role="status" aria-label="Paste result">{pasteNote[i]?.text ?? ''}</p>
		{#if notes.length}
			<ul class="notes small" aria-label="Checks on this table">
				{#each notes as n (n)}<li>Check: {n}.</li>{/each}
			</ul>
		{/if}
		{#if !readonly}
			<button type="button" class="btn btn-sm btn-ghost" onclick={() => remove(i)}>Remove the rule table at {siteLabel(t.siteNodeId)}</button>
		{/if}
	</fieldset>
{/each}

<style>
	.u {
		font-weight: 400;
		color: var(--text-muted);
		font-size: 0.8rem;
	}
	.hint {
		font-size: 0.8rem;
		max-width: 75ch;
	}
	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 0 1.25rem;
		margin-top: 0.5rem;
	}
	.field :global(input),
	.field select {
		width: 100%;
	}
	.field.wide {
		grid-column: 1 / -1;
		max-width: 60ch;
	}
	.plain {
		border: 0;
		padding: 0;
		margin: 0.25rem 0 0.75rem;
		min-width: 0;
	}
	.rule {
		border-top: 1px solid var(--border);
		padding-top: 0.75rem;
		margin-top: 0.75rem;
	}
	.plain legend {
		font-weight: 600;
		font-size: 0.95rem;
		color: var(--text-2);
		margin-bottom: 0.35rem;
		padding: 0;
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
	.rulegrid td {
		min-width: 78px;
		padding-left: 0.3rem;
		padding-right: 0.3rem;
	}
	.load {
		display: grid;
		gap: 0.35rem;
		margin: 0.25rem 0 0.5rem;
		max-width: 75ch;
	}
	.load-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.35rem 0.75rem;
	}
	.load p {
		margin: 0;
	}
	.paste {
		display: grid;
		gap: 0.35rem;
		margin-top: 0.75rem;
		max-width: 75ch;
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
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.check {
		display: flex;
		gap: 0.4rem;
		align-items: flex-start;
		font-size: 0.8rem;
		margin-top: 0.35rem;
	}
	.check input {
		width: auto;
		margin-top: 0.15rem;
	}
	.notes {
		color: var(--warning);
		margin: 0.25rem 0 0.5rem;
		padding-left: 1.1rem;
	}
	.err {
		color: var(--danger);
		font-size: 0.8rem;
	}
</style>
