<script lang="ts">
	// Load crop factors (issue #54 item 1; docs/ui.md § Load crop factors): from the
	// reference library (./library.ts), a b023 workbook's [Crop demand] or a
	// node-based workbook's [Crop_Factors] (the browser importer, in its worker,
	// with the crop-table warnings it gives), with a pan coefficient defaulted by the
	// source's shape (1 for A-pan factors, 0.75 for FAO-56 Kc; issue #289),
	// mapped onto the project's crops by name, a diff per crop and the demand
	// difference. Nothing changes until Apply, which edits the model like any
	// other edit: the save bar saves it, with a reason, and History records it.
	// Laid out as the task's steps: the source and Kp, then a card per crop
	// (largest planted area first) with its match, system and month-by-month
	// change together, beside the effect on demand; one column on a phone.
	// Its own chunk, loaded when the button is first pressed (CropsTab).
	import { onDestroy, tick, untrack } from 'svelte';
	import type { ProjectSettings } from '@water-management/engine';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { describeFailure, WORKBOOK_ACCEPT } from '$lib/components/import/workbookFile';
	import type { WorkbookImportSession } from '$lib/spreadsheet/import/runner';
	import { fmtNum } from '$lib/format/number';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import { ARC4_URL, citation, CROP_LIBRARY, libraryCropFactor, type LibraryCrop } from './library';
	import { cropAreaTotals, rankCrops } from './cards';
	import CropSystemSelect from './CropSystemSelect.svelte';
	import { findSystem, systemLabel, systemsOf } from '$lib/model/systems';
	import { applyLine, matchedLine, plantingFor, rowsByChange, type PlantingDraft } from './loadFactorsView';
	import {
		applyChanges,
		b023CropWarnings,
		cropChanges,
		defaultKp,
		demandDifference,
		FAO56_TABLE5_URL,
		isKp,
		FACTOR_SHEET,
		kpForShape,
		matchByName,
		nodeWarningText,
		pctChange,
		shapeOf,
		SOURCE_KINDS,
		withKp,
		type CropChoice,
		type SourceKind
	} from './loadFactors';

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

	let kind = $state<SourceKind>('library');
	// Kp starts at the source's default (loadFactors.ts defaultKp: 1 for A-pan factors, 0.75 for FAO-56 Kc).
	const shape = $derived(shapeOf(kind));
	const kpDefault = $derived(defaultKp(shape));
	let kp = $state<number | null>(defaultKp(shapeOf('library')));
	// A change of shape re-applies its default unless the modeller set their own Kp (kpForShape).
	let kpShape = shapeOf('library');
	$effect(() => {
		const next = shape;
		if (next === kpShape) return;
		kp = kpForShape(untrack(() => kp), defaultKp(kpShape), next);
		kpShape = next;
	});
	// The button removes itself, so focus goes back to the input it reset, once
	// the input shows the default (NumberInput doesn't follow its value while focused).
	async function useDefaultKp() {
		kp = kpDefault;
		await tick();
		document.getElementById('lcf-kp')?.focus();
	}
	// The workbook read for the current kind (a change of kind drops it), with the reader's crop warnings as text.
	let wb = $state<{ file: string; sheet: string; crops: Source[]; warnings: string[] } | null>(null);
	let reading = $state(false);
	let wbError = $state<string | null>(null);
	// The workbook's warnings: the first few, then all of them on request (a bad workbook can give 100).
	const WARN_SHOWN = 5;
	let allWarnings = $state(false);
	let session: WorkbookImportSession | null = null;
	let attempt = 0;
	// Per project crop: the source crop ('' keeps the current factors), a planting for a staged crop, the system ('' keeps the efficiency), rejected.
	let pick = $state<Record<string, string>>({});
	let plant = $state<Record<string, PlantingDraft>>({});
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
		// A vegetable matched by name needs its planting fields as much as one picked by hand.
		// (From the matches, not `pick`: reading `pick` here would make the effect below rerun on every choice.)
		for (const c of crops) {
			const lib = byId.get(m.get(c.id) ?? '')?.lib;
			if (lib?.kind === 'staged') plant[c.id] = plantingFor(lib, untrack(() => plant[c.id]));
		}
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
		if (s?.kind === 'staged') plant[cropId] = plantingFor(s, plant[cropId]);
	}

	const choices = $derived.by(() => {
		const out = new Map<string, CropChoice>();
		for (const c of crops) {
			const s = byId.get(pick[c.id] ?? '');
			const p = plant[c.id];
			const planting = p && p.month && p.day && p.days ? { month: p.month, day: p.day, days: p.days } : null;
			const raw = s ? (s.lib ? libraryCropFactor(s.lib, planting) : (s.factors ?? null)) : null;
			const sys = system[c.id] ? findSystem(editor.model, system[c.id]) : null;
			out.set(c.id, { factors: raw && kp !== null && kp > 0 ? withKp(raw, kp) : null, ...(sys ? { systemId: sys.id } : {}) });
		}
		return out;
	});
	const changes = $derived(cropChanges(crops, choices));
	const changeOf = $derived(new Map(changes.map((c) => [c.cropId, c])));
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
		allWarnings = false;
		reading = true;
		let s: WorkbookImportSession | null = null;
		try {
			const { createWorkbookImport, WorkbookImportFailed, WorkbookImportCancelled } = await import('$lib/spreadsheet/import/runner');
			if (mine !== attempt) return;
			s = session = createWorkbookImport();
			try {
				if (kind === 'node') {
					const set = await s.readNodeCrops(f);
					if (mine === attempt)
						wb = {
							file: f.name,
							sheet: set.sheets.factors ?? FACTOR_SHEET.node,
							crops: set.crops.map((c) => ({ id: `nb:${c.name}`, name: c.name, factors: c.cropFactor })),
							warnings: set.warnings.map(nodeWarningText)
						};
				} else {
					const r = await s.parse(f, {});
					if (mine === attempt)
						wb = {
							file: f.name,
							sheet: FACTOR_SHEET.b023,
							crops: r.project.model.crops.map((c) => ({ id: `wb:${c.id}`, name: c.name, factors: c.cropFactor })),
							warnings: b023CropWarnings(r.notes)
						};
				}
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

	// Another kind of source: drop the workbook (and any read in flight) picked for the last one.
	function pickKind(k: SourceKind) {
		if (k === kind) return;
		attempt++;
		session?.cancel();
		session = null;
		wb = null;
		wbError = null;
		reading = false;
		kind = k;
	}

	function apply() {
		const names = accepted.map((c) => c.name || 'unnamed crop');
		editor.model.crops = applyChanges(editor.model.crops, accepted);
		open = false;
		onapplied?.(names);
	}

	const f2 = (v: number) => fmtNum(v, 2);
	// A crop's default system in words (engine ≥ 1.72.0).
	const sysText = (id: string | null) => {
		const s = findSystem(editor.model, id);
		return s ? systemLabel(s) : 'none (the unit’s efficiency for crops with no system)';
	};
	const ha = (m2: number) => fmtNum(m2 / 10_000, 1, true);

	// The crops by planted area, largest first (the Crops page's order), so the crops that make the demand come first.
	const areas = $derived(cropAreaTotals(editor.model.cropAreas, farmIds));
	const ordered = $derived(rankCrops(crops, areas));
	const matched = $derived(crops.filter((c) => pick[c.id]).length);
	// The demand review: the biggest change first, the first few, the rest on request.
	const UNITS_SHOWN = 8;
	let allUnits = $state(false);
	const unitRows = $derived(demand ? rowsByChange(demand.rows) : []);
	// A month table in one row of twelve, or two of six where a card is narrow (a phone).
	let listWidth = $state(0);
	const ALL_MONTHS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
	const monthRows = $derived(listWidth > 0 && listWidth < 560 ? [ALL_MONTHS.slice(0, 6), ALL_MONTHS.slice(6)] : [ALL_MONTHS]);
	// The units table: both measures side by side, or one table each where the review is narrow (a phone).
	let reviewWidth = $state(0);
	const MEASURE = { gross: 'Crop requirement', abstraction: 'Abstraction' } as const;
</script>


<!-- The demand review's units: one table with both measures, or one per measure where the review is narrow. -->
{#snippet unitTable(measures: ('gross' | 'abstraction')[], caption: string)}
	<div class="table-wrap">
		<table class="data compact units">
			<caption class="small">{caption}</caption>
			<thead>
				{#if measures.length > 1}
					<tr>
						<th scope="col" rowspan="2">Hydrological unit</th>
						{#each measures as k (k)}<th scope="colgroup" colspan="3" class="grp">{MEASURE[k]}</th>{/each}
					</tr>
				{/if}
				<tr>
					{#if measures.length === 1}<th scope="col">Hydrological unit</th>{/if}
					{#each measures as k (k)}
						<th scope="col" class="num">Now</th>
						<th scope="col" class="num">New</th>
						<th scope="col" class="num">Change</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each allUnits ? unitRows : unitRows.slice(0, UNITS_SHOWN) as r (r.nodeId)}
					<tr>
						<th scope="row">{r.name}</th>
						{#each measures as k (k)}
							<td class="num">{fmtNum(r[k][0])}</td>
							<td class="num">{fmtNum(r[k][1])}</td>
							<td class="num">{pctChange(r[k])}</td>
						{/each}
					</tr>
				{/each}
			</tbody>
			{#if demand}
				<tfoot>
					<tr>
						<th scope="row">Catchment</th>
						{#each measures as k (k)}
							<td class="num">{fmtNum(demand.total[k][0])}</td>
							<td class="num">{fmtNum(demand.total[k][1])}</td>
							<td class="num" data-testid={k === 'gross' ? 'demand-change' : undefined}>{pctChange(demand.total[k])}</td>
						{/each}
					</tr>
				</tfoot>
			{/if}
		</table>
	</div>
{/snippet}

<Dialog bind:open title="Load crop factors" full keepInputs>
	<div class="lcf-frame">
		<div class="lcf">
			<div class="steps">
				<p class="lead">
					Fill this project’s crop factors from published values or a workbook. Nothing changes until you apply, and then you save the model
					with a reason, as for any edit.
				</p>

				<section class="step" aria-labelledby="lcf-h-src">
					<h3 id="lcf-h-src"><span class="stepno" aria-hidden="true">1</span> Where the factors come from</h3>
					<fieldset class="sources">
						<legend class="visually-hidden">Source</legend>
						{#each SOURCE_KINDS as k (k.id)}
							<label class="source" class:on={kind === k.id}>
								<input type="radio" name="lcf-src" checked={kind === k.id} onchange={() => pickKind(k.id)} aria-describedby="lcf-src-{k.id}" />
								<span class="source-text">
									<span class="source-name">{k.label}</span>
									<span class="source-hint" id="lcf-src-{k.id}" aria-hidden="true">{k.hint}</span>
								</span>
							</label>
						{/each}
					</fieldset>
					{#if kind === 'library'}
						<p class="muted small">
							Design crop factors × A-pan from the <a href={ARC4_URL} target="_blank" rel="noopener noreferrer">ARC/SABI Irrigation Design Manual, ch. 4</a>
							(Tables 4.13–4.15, 1990; pecan from Table 4.10). They are site-specific design values (an orchard cover crop raises them), and which set
							fits the catchment is the hydrologist’s call.
						</p>
					{:else}
						{#key kind}
							<label class="file">
								<span>Workbook (.xlsx, .xlsm)</span>
								<input type="file" accept={WORKBOOK_ACCEPT} onchange={readWorkbook} disabled={reading} />
							</label>
						{/key}
						<p class="muted small">Read in this browser; the file isn’t uploaded.</p>
						{#if reading}<p class="small" role="status">Reading the workbook…</p>{/if}
						{#if wbError}<p class="alert alert-error small" role="alert">{wbError}</p>{/if}
						{#if wb}
							<p class="small" role="status">{wb.crops.length} crops from [{wb.sheet}] in {wb.file}.</p>
							{#if wb.warnings.length}
								<div class="alert alert-warning small" role="group" aria-labelledby="lcf-wb-warn">
									<p id="lcf-wb-warn"><strong>Check {wb.warnings.length === 1 ? 'this' : 'these'} in the workbook</strong></p>
									<ul>
										{#each allWarnings ? wb.warnings : wb.warnings.slice(0, WARN_SHOWN) as w, i (i)}<li>{w}</li>{/each}
									</ul>
									{#if wb.warnings.length > WARN_SHOWN}
										<button type="button" class="btn btn-sm btn-ghost" aria-expanded={allWarnings} onclick={() => (allWarnings = !allWarnings)}>
											{allWarnings ? 'Show the first ' + WARN_SHOWN : `Show all ${wb.warnings.length}`}
										</button>
									{/if}
								</div>
							{/if}
						{/if}
					{/if}
				</section>

				<section class="step" aria-labelledby="lcf-h-kp">
					<h3 id="lcf-h-kp"><span class="stepno" aria-hidden="true">2</span> Convert them to A-pan</h3>
					<div class="kp">
						<label for="lcf-kp">Pan coefficient Kp</label>
						<NumberInput id="lcf-kp" min={0.1} max={1.5} step={0.05} bind:value={kp} aria-describedby="lcf-kp-why lcf-kp-range" />
						<span class="muted small" id="lcf-kp-range">0.1 to 1.5</span>
						{#if !isKp(kp, kpDefault)}<button type="button" class="btn btn-sm" onclick={useDefaultKp}>Use the default, {kpDefault}</button>{/if}
					</div>
					<p class="muted small" id="lcf-kp-why" data-testid="kp-why">
						{#if shape === 'fao-et0'}
							Default 0.75: these are FAO-56 Kc values, set against reference ET₀, and the model multiplies crop factors by A-pan. Kp (ET₀ ÷ pan) is
							0.35–0.85 for a Class A pan in <a href={FAO56_TABLE5_URL} target="_blank" rel="noopener noreferrer">FAO-56 Table 5</a>; 0.75 is a mid value.
							Your site’s humidity, wind and pan surroundings set the real one.
						{:else}
							Default 1: these factors already multiply A-pan, as the model does (demand = A-pan × factor). An FAO-56 Kc set (against ET₀) would need
							a Kp of 0.35–0.85 (<a href={FAO56_TABLE5_URL} target="_blank" rel="noopener noreferrer">FAO-56 Table 5</a>).
						{/if}
					</p>
					{#if kp === null || !(kp > 0)}<p class="alert alert-warning small">Enter a pan coefficient between 0.1 and 1.5.</p>{/if}
				</section>

				<section class="step" aria-labelledby="lcf-h-crops">
					<h3 id="lcf-h-crops"><span class="stepno" aria-hidden="true">3</span> Match your crops and check each change</h3>
					{#if !crops.length}
						<p class="muted">Add the project’s crops first, then load factors into them.</p>
					{:else if !sources.length}
						<p class="muted small">Pick a workbook above: its crops are what this project’s crops can take their factors from.</p>
					{:else}
						<p class="muted small intro">
							{matchedLine(matched, crops.length)} Largest planted area first; <strong>Keep current</strong> leaves a crop as it is. An irrigation
							system is the crop’s default <HelpTip key="crop.irrigationSystemId" />, from the project’s table on Crops &amp; demand; a unit that
							puts the crop on its own system keeps it. Confirm which ones the hydrological units use.
						</p>
						<ul class="crops" bind:clientWidth={listWidth}>
							{#each ordered as c (c.id)}
								{@const ch = changeOf.get(c.id)}
								{@const src = byId.get(pick[c.id] ?? '')}
								{@const st = staged(c.id)}
								{@const p = plant[c.id]}
								{@const area = areas.get(c.id) ?? 0}
								{@const name = c.name || 'unnamed crop'}
								<li class="crop" class:picked={!!src}>
									<div class="crop-head">
										<div class="crop-name">
											<span class="name">{c.name || '(unnamed)'}</span>
											<span class="area">{area > 0 ? `${ha(area)} ha` : 'Not planted'}</span>
										</div>
										<div class="from">
											<span class="lab" aria-hidden="true">Load factors from</span>
											<select aria-label="Load factors from, for {name}" value={pick[c.id] ?? ''} onchange={(e) => choose(c.id, e.currentTarget.value)}>
												<option value="">Keep current</option>
												{#each sources as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
											</select>
										</div>
										<CropSystemSelect crop={c} systems={systemsOf(editor.model)} value={system[c.id] ?? ''} typical={src?.lib?.system ?? null} onchange={(v) => (system[c.id] = v)} />
										<div class="status">
											{#if ch?.differs}
												<label class="apply"><input type="checkbox" checked={!reject[c.id]} onchange={(e) => (reject[c.id] = !e.currentTarget.checked)} /> Apply<span class="visually-hidden">{' '}to {name}</span></label>
											{:else if ch}
												<span class="tag">No change</span>
											{:else if st && p && !p.month}
												<span class="tag warn">No month yet</span>
											{/if}
										</div>
									</div>
									{#if st && p}
										<div class="plant">
											<label class="pf">
												<span aria-hidden="true">Planting month</span>
												<select aria-label="{c.name} planting month" aria-describedby={p.month ? undefined : `lcf-${c.id}-month`} bind:value={p.month}>
													<option value={0}>Pick…</option>
													{#each MONTHS as m, i (m)}<option value={i + 1}>{m}</option>{/each}
												</select>
											</label>
											<div class="pf">
												<span aria-hidden="true">Day</span>
												<NumberInput label="{c.name} planting day" min={1} max={31} step={1} bind:value={p.day} />
											</div>
											<div class="pf">
												<span aria-hidden="true">Season, days</span>
												<NumberInput label="{c.name} season, days" min={1} max={365} step={1} bind:value={p.days} />
											</div>
											<div class="seasons small">
												<span class="muted">Table 4.7:</span>
												{#each st.seasons as s (s.label)}
													<button type="button" class="btn btn-sm season" aria-pressed={p.days === s.days} onclick={() => (p.days = s.days)}>{s.label}, {s.days} days</button>
												{/each}
											</div>
										</div>
										{#if !p.month}
											<!-- Otherwise the crop is quietly left out of Apply: say why. -->
											<p class="month-why small" id="lcf-{c.id}-month" data-testid="planting-month-why">
												Pick a planting month: until then {st.name} has no factors to load{c.name.trim().toLowerCase() === st.name.toLowerCase()
													? ''
													: ` into ${c.name || 'this crop'}`}.
											</p>
										{/if}
									{/if}
									{#if ch}
										{@const effChanged = ch.nextSystemId !== ch.currentSystemId}
										<div class="diff" role="region" aria-label="{ch.name}: changes">
											<div class="table-wrap">
												<table class="data compact months">
													<caption>
														Crop factor by month{#if src}: now, and from <strong>{src.name}</strong>{#if kp !== 1}{' '}× Kp {kp}{/if}{/if}
													</caption>
													{#each monthRows as ms, gi (gi)}
														<tbody>
															<tr class="mh">
																<th scope="col"><span class="visually-hidden">Factors</span></th>
																{#each ms as m (m)}<th scope="col" class="num">{WATER_YEAR_MONTHS[m]}</th>{/each}
															</tr>
															<tr>
																<th scope="row">Current</th>
																{#each ms as m (m)}<td class="num">{f2(ch.current[m]!)}</td>{/each}
															</tr>
															<tr>
																<th scope="row">New</th>
																{#each ms as m (m)}<td class="num" class:changed={ch.changed[m]}>{f2(ch.next[m]!)}</td>{/each}
															</tr>
														</tbody>
													{/each}
												</table>
											</div>
											<p class="small eff">
												{#if effChanged}
													Irrigation system: {sysText(ch.currentSystemId)} → <strong>{sysText(ch.nextSystemId)}</strong>
												{:else}
													Irrigation system stays {sysText(ch.currentSystemId)}.
												{/if}
											</p>
											{#if src?.lib}<p class="muted small">{citation(src.lib)}. {src.lib.notes}</p>{:else if src && wb}<p class="muted small">From [{wb.sheet}] in {wb.file}.</p>{/if}
										</div>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</section>
			</div>

			<!-- Its own scroll box beside the steps: focusable, so a keyboard can scroll it (axe scrollable-region-focusable). -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<section class="review" aria-labelledby="lcf-h-demand" tabindex="0">
				<h3 id="lcf-h-demand"><span class="stepno" aria-hidden="true">4</span> Check the effect on demand</h3>
				{#if demand}
					<p class="muted small">
						Mean over the year, m³/day, with the saved A-pan and before rain, for the ticked changes. Abstraction is the crop requirement ÷ each
						hydrological unit’s irrigation efficiency: what the unit takes from its sources.
					</p>
					<div class="kpis">
						<div class="kpi">
							<span class="kpi-label">Crop requirement</span>
							<span class="kpi-val">{pctChange(demand.total.gross)}</span>
							<span class="kpi-sub">{fmtNum(demand.total.gross[0])} → {fmtNum(demand.total.gross[1])} m³/day</span>
						</div>
						<div class="kpi">
							<span class="kpi-label">Abstraction</span>
							<span class="kpi-val" data-testid="abstraction-change">{pctChange(demand.total.abstraction)}</span>
							<span class="kpi-sub">{fmtNum(demand.total.abstraction[0])} → {fmtNum(demand.total.abstraction[1])} m³/day</span>
						</div>
					</div>
					<div class="units-tables" data-testid="demand-difference" bind:clientWidth={reviewWidth}>
						{#if reviewWidth > 0 && reviewWidth < 470}
							{@render unitTable(['gross'], 'Crop requirement by hydrological unit, m³/day, the biggest change first')}
							{@render unitTable(['abstraction'], 'Abstraction by hydrological unit, m³/day')}
						{:else}
							{@render unitTable(['gross', 'abstraction'], 'By hydrological unit, m³/day, the biggest change first')}
						{/if}
					</div>
					{#if unitRows.length > UNITS_SHOWN}
						<button type="button" class="btn btn-sm btn-ghost more" aria-expanded={allUnits} onclick={() => (allUnits = !allUnits)}>
							{allUnits ? `Show the ${UNITS_SHOWN} biggest changes` : `Show all ${unitRows.length} hydrological units`}
						</button>
					{/if}
					<div class="table-wrap">
						<table class="data compact monthly">
							<caption class="small">Catchment abstraction by month, m³/day</caption>
							<thead>
								<tr>
									<th scope="col">Month</th>
									<th scope="col" class="num">Now</th>
									<th scope="col" class="num">New</th>
									<th scope="col" class="num">Change</th>
								</tr>
							</thead>
							<tbody>
								{#each WATER_YEAR_MONTHS as m, i (m)}
									<tr>
										<th scope="row">{m}</th>
										<td class="num">{fmtNum(demand.monthly[0][i])}</td>
										<td class="num">{fmtNum(demand.monthly[1][i])}</td>
										<td class="num">{pctChange([demand.monthly[0][i]!, demand.monthly[1][i]!])}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{:else}
					<p class="empty muted small">
						{#if !crops.length}
							The effect shows here once the project has crops.
						{:else if kp === null || !(kp > 0)}
							Enter a pan coefficient (step 2) to see the effect.
						{:else if changes.some((c) => c.differs)}
							Every change is unticked. Tick <strong>Apply</strong> on a crop to see what it does to demand.
						{:else if changes.length}
							The chosen factors and systems are the ones the crops already have: nothing would change.
						{:else}
							Choose where at least one crop’s factors come from (step 3) to see what it does to the hydrological units’ demand.
						{/if}
					</p>
				{/if}
			</section>
		</div>
	</div>

	{#snippet actions()}
		<p class="apply-line small">
			{applyLine(accepted.length, crops.length)}{#if demand}{' '}Abstraction {pctChange(demand.total.abstraction)}.{/if}
		</p>
		<button type="button" class="btn" onclick={() => (open = false)}>Cancel</button>
		<button type="button" class="btn btn-primary" disabled={!accepted.length} onclick={apply}>
			Apply {accepted.length} {accepted.length === 1 ? 'crop' : 'crops'}
		</button>
	{/snippet}
</Dialog>

<style>
	/* The frame fills the full dialog's body. Wide: the steps and the review are two
	   columns, each scrolling on its own, so the effect on demand stays in view
	   while crops are matched. Narrow (a phone): one column, the frame scrolls. */
	/* Every box that scrolls is positioned, so the visually hidden words inside it
	   (the Apply ticks' "to <crop>") are clipped with it rather than growing the dialog. */
	.lcf-frame,
	.steps,
	.review {
		position: relative;
	}
	.lcf-frame {
		container: lcf / inline-size;
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		margin: 0 -1.25rem;
		padding: 0 1.25rem;
	}
	.lcf {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	@container lcf (min-width: 64rem) {
		.lcf {
			display: grid;
			grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
			gap: 0 1.25rem;
			height: 100%;
		}
		.steps,
		.review {
			min-height: 0;
			overflow-y: auto;
		}
		.steps {
			padding-right: 0.5rem;
		}
	}
	.lead {
		margin: 0 0 0.75rem;
		color: var(--text-2);
	}
	.step + .step {
		margin-top: 1.25rem;
	}
	h3 {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0 0 0.5rem;
		font-size: 1rem;
	}
	.stepno {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 50%;
		background: var(--accent-soft);
		color: var(--text);
		font-size: 0.85rem;
		font-weight: 600;
	}
	.sources {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
		gap: 0.5rem;
		border: 0;
		padding: 0;
		margin: 0 0 0.5rem;
	}
	.source {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		padding: 0.5rem 0.6rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		cursor: pointer;
	}
	.source.on {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.source input {
		margin-top: 0.2rem;
	}
	.source-text {
		display: flex;
		flex-direction: column;
	}
	.source-name {
		font-weight: 600;
	}
	.source-hint {
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.file {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.75rem;
		margin: 0.5rem 0 0;
	}
	.file input {
		width: auto;
		max-width: 100%;
	}
	.kp {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.5rem;
		margin: 0 0 0.25rem;
	}
	.kp :global(input) {
		width: 5rem;
	}
	.intro {
		margin: 0 0 0.6rem;
	}
	.crops {
		container: crops / inline-size;
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.crop {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.5rem 0.75rem;
		background: var(--surface);
	}
	.crop.picked {
		border-color: var(--border-strong);
	}
	/* Name and status on the first line, the two selects under it; side by side once the card is wide. */
	.crop-head {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-areas: 'name status' 'from from' 'sys sys';
		gap: 0.4rem 0.75rem;
		align-items: start;
	}
	.crop-name {
		grid-area: name;
		display: flex;
		flex-direction: column;
		min-width: 0;
		padding-top: 0.15rem;
	}
	.name {
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.area {
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.from {
		grid-area: from;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
	}
	.from select {
		width: 100%;
		min-height: 2rem;
	}
	.crop-head > :global(.sys) {
		grid-area: sys;
	}
	.status {
		grid-area: status;
		justify-self: end;
		padding-top: 0.15rem;
	}
	@container crops (min-width: 40rem) {
		.crop-head {
			grid-template-columns: minmax(7rem, 1fr) minmax(10rem, 1.4fr) minmax(10rem, 1.3fr) 5.5rem;
			grid-template-areas: 'name from sys status';
		}
		.status {
			padding-top: 1.2rem;
		}
	}
	.lab {
		font-size: 0.8rem;
		color: var(--text-2);
	}
	.apply {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		min-height: 1.75rem;
		font-weight: 600;
		white-space: nowrap;
	}
	.apply input {
		width: 1.1rem;
		height: 1.1rem;
	}
	.tag {
		display: inline-block;
		font-size: 0.8rem;
		color: var(--text-2);
		white-space: nowrap;
	}
	.tag.warn {
		color: var(--warning);
		font-weight: 600;
		white-space: normal;
		text-align: right;
	}
	.plant {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.4rem 0.75rem;
		margin: 0.6rem 0 0;
	}
	.pf {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		font-size: 0.8rem;
		color: var(--text-2);
	}
	.pf select {
		min-height: 2rem;
	}
	.pf :global(input) {
		width: 5rem;
	}
	.seasons {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.3rem;
	}
	.season[aria-pressed='true'] {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.month-why {
		margin: 0.4rem 0 0;
		color: var(--warning);
	}
	.diff {
		margin-top: 0.5rem;
	}
	.diff p {
		margin: 0.3rem 0 0;
	}
	caption {
		text-align: left;
		padding: 0.3rem 0.5rem;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.months td.changed {
		font-weight: 700;
		background: var(--accent-soft);
	}
	.months tbody + tbody tr.mh th {
		border-top: 2px solid var(--border);
	}
	.months th[scope='row'] {
		width: 4.5rem;
	}
	.review {
		align-self: stretch;
		padding: 0.75rem 1rem;
		border-radius: var(--radius);
		background: var(--surface-2);
	}
	.review:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.kpis {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
		gap: 0.5rem;
		margin: 0.5rem 0 0.75rem;
	}
	.kpi {
		display: flex;
		flex-direction: column;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
	}
	.kpi-label {
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.kpi-val {
		font-size: 1.6rem;
		font-weight: 600;
		line-height: 1.2;
		font-variant-numeric: tabular-nums;
	}
	.kpi-sub {
		font-size: 0.8rem;
		color: var(--text-2);
		font-variant-numeric: tabular-nums;
	}
	.units th.grp {
		text-align: center;
		border-bottom: 1px solid var(--border);
	}
	.units thead th {
		white-space: normal;
		vertical-align: bottom;
	}
	.units-tables {
		display: flex;
		flex-direction: column;
	}
	.review .table-wrap {
		max-height: none;
		margin-bottom: 0.5rem;
	}
	.more {
		margin: 0 0 0.75rem;
	}
	.empty {
		margin: 0.5rem 0;
	}
	.apply-line {
		margin: 0 auto 0 0;
		align-self: center;
		color: var(--text-2);
	}
</style>
