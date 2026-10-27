<!--
	Settings → EWR → the daily EWR at the outlet (engine ≥ 1.77.0, issue #455,
	docs/model.md §2.9f, docs/ui.md § The daily EWR at the outlet): where the
	outlet's daily EWR comes from, the pragmatic EWR above, the Desktop Reserve
	Model's TAB file (12 monthly flows) or its percentile tables (the natural
	flow and a Reserve table, read at each day's natural flow: the total Reserve
	flows or, by choice, the Reserve flows without high flows, issue #552; a
	.rul fills all three), and how the tables are
	scaled to the modelled catchment (by MAR or by area), with the factor. The
	tables are typed, pasted (Paste…, the shared paste dialog with its preview,
	issue #521), or loaded from the DRM's .tab / .rul files (both on the source
	picker's line, "Fill from", with the Expected format under it); a .tab's
	converted flows are shown before they are used, and a file never changes
	the method on its own. Bind `value`
	(settings.ewrDailySource; null = the pragmatic EWR); `error` is set while it
	can't be saved, and shown under the fields as an alert unless `announce` is
	false (a scenario's change form, whose own alert says it on Add change, so a
	screen reader hears it once). The .tab used is kept whole with the source
	(`tabFile`, issue #617) and shown under the TAB flows (DrmTabFileView; folded
	under the percentile tables when it gave only the table MAR), and the .rul's
	name, date, unit and REC (`rulFile`) above its tables; both are display only.
	Its own chunk: the Settings tab chunk sits at its size
	ceiling. Helpers in ./ewrDailySource.ts and ./drmFiles.ts.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { blankEwrDailySource, EWR_PERCENTILE_POINTS, reserveTableOf, type EwrDailySource, type EwrReserveTable } from '@water-management/engine';
	import Fold from '#lib/components/common/Fold.svelte';
	import NumberInput from '#lib/components/common/NumberInput.svelte';
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import { confirmDialog } from '#lib/components/common/confirm.svelte.js';
	import { latestFileText } from '#lib/files/latest.js';
	import { WATER_YEAR_MONTHS } from '#lib/format/months.js';
	import { fmtNum } from '#lib/format/number.js';
	import DrmFormatHelp from './DrmFormatHelp.svelte';
	import { parseDrmFile, percentileTablesFromRul, rulFileRecord, tabFileM3s, tabFileRecord, tabFlowsEdited, type TabFile } from './drmFiles';
	import DrmTabFileView from './DrmTabFileView.svelte';
	import { api } from '#lib/api/index.js';
	import { isScenarioRun } from '#lib/components/runs/scenarioRun.js';
	import ScaledEwrTablesView from './ScaledEwrTablesView.svelte';
	import GridPasteDialog from '#lib/components/model/GridPasteDialog.svelte';
	import { dailyCsv, planDailyPaste, type DailyTable } from './ewrPaste';
	import { DAILY_TABLE_LABELS, dailySourceError, knownScale, lastRunScale, reserveGridRole, rulLoad, scaledEwrTables, scaleFactor, type LastRunScale } from './ewrDailySource';

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
	/** The three percentile tables a .rul fills. */
	type GridKey = 'naturalPctM3s' | 'reservePctM3s' | 'lowFlowPctM3s';
	const reserveTable = $derived(reserveTableOf(src));
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

	// What the last file did and what the last paste did, said under the Fill from line.
	let note = $state<{ ok: boolean; text: string } | null>(null);
	let pasteNote = $state<{ ok: boolean; text: string } | null>(null);
	// A .rul loaded under another method filled the percentile tables without switching to them: offer the switch.
	let offerPercentile = $state(false);
	let tabPreview = $state<{ file: string; tab: TabFile } | null>(null);
	// The paste dialog: its text, and which table it fills (the TAB flows, or one of the three percentile tables).
	let pasteOpen = $state(false);
	let pasteText = $state('');
	let pasteGridTarget = $state<GridKey>('naturalPctM3s');
	const pasteTarget = $derived<DailyTable>(method === 'tab' ? 'tabM3s' : pasteGridTarget);
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
			note = { ok: false, text: `${f.name} isn't a Desktop Reserve Model .tab or .rul file. Use Paste… to read a CSV's rows instead.` };
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
		if ((src.naturalPctM3s || src.reservePctM3s || src.lowFlowPctM3s) && !(await confirmDialog({ title: `Replace the percentile tables with ${f.name}?`, message: 'All three tables will be replaced by the file’s.', confirmLabel: 'Replace the tables' }))) return;
		// A .rul fills the percentile tables and nothing else: the method and the Reserve table stay as picked, and the switch is offered.
		const out = rulLoad(method, tables, f.name, drm.unit, reserveTableOf(src));
		// The file's header goes with its tables (issue #617): shown above them, read by no run.
		edit({ ...out.patch, rulFile: rulFileRecord(drm, f.name) });
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
		// The whole file is kept with what it gave (issue #617), so it shows after a reload; no run reads it.
		const tabFile = tabFileRecord(tab, file);
		if (method === 'tab') {
			edit({ tabM3s: [...tab.totalMaintM3s], ...mar, tabFile });
			note = { ok: true, text: `Used ${file}: the 12 TAB flows${tab.marMm3 !== null ? ` and the table MAR, ${tab.marMm3} Mm³/a` : ''}.` };
		} else {
			if (tab.marMm3 !== null) edit({ ...mar, tabFile });
			note = { ok: true, text: tab.marMm3 !== null ? `Used ${file}'s MAR, ${tab.marMm3} Mm³/a, as the table MAR.` : `${file} has no MAR line: nothing used.` };
		}
		tabPreview = null;
	}

	function openPaste() {
		pasteText = '';
		pasteOpen = true;
	}

	/** The dialog's Apply: the same values the parsers give (./ewrPaste.ts), said under the actions. */
	function applyPaste() {
		const r = planDailyPaste(src, pasteTarget, pasteText);
		if ('error' in r) return;
		edit({ ...r.patch, ...rulEdited(pasteTarget) });
		pasteNote = { ok: true, text: r.message };
	}

	function setCell(which: GridKey, r: number, c: number, v: number | null) {
		const grid = (untrack(() => $state.snapshot(src[which])) as number[][] | null) ?? WATER_YEAR_MONTHS.map(() => EWR_PERCENTILE_POINTS.map(() => null as unknown as number));
		grid[r]![c] = v as number;
		edit({ [which]: grid, ...rulEdited(which) });
	}

	/** A percentile table typed or pasted over after a .rul loaded: its header line then says the tables changed since (issue #617). */
	function rulEdited(which: DailyTable): Pick<EwrDailySource, 'rulFile'> | object {
		const f = untrack(() => src.rulFile);
		return f && which !== 'tabM3s' && !f.edited ? { rulFile: { ...$state.snapshot(f), edited: true } } : {};
	}

	/** A .tab kept for its MAR only, now under the TAB method: take its flows too, on the person's say. */
	function useKeptTabFlows() {
		if (!src.tabFile) return;
		edit({ tabM3s: tabFileM3s(src.tabFile) });
		note = { ok: true, text: `Used ${src.tabFile.name}'s 12 TAB flows.` };
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
	<!-- The source and where its values come from on one line (issue #521): "Fill from" a DRM file or a paste. -->
	<div class="source-row">
		<div class="field source">
			<label for="{uid}-method">Daily EWR from</label>
			<select id="{uid}-method" disabled={readonly} value={method} onchange={(e) => edit({ method: e.currentTarget.value as EwrDailySource['method'] })} aria-describedby="{uid}-method-h">
				<option value="pragmatic">The pragmatic EWR (the monthly row)</option>
				<option value="tab">The DRM TAB file (monthly total flows)</option>
				<option value="percentile">The DRM percentile tables (read at each day’s natural flow)</option>
			</select>
		</div>
		{#if method !== 'pragmatic' && !readonly}
			<div class="fill" role="group" aria-label="Fill the tables from" data-testid="ewr-daily-fill">
				<span class="fill-lbl" aria-hidden="true">Fill from:</span>
				<label class="btn btn-sm file">
					Load a DRM file (.rul / .tab)
					<input type="file" accept=".tab,.rul,.txt,text/plain" onchange={loadFile} data-testid="ewr-daily-file" aria-describedby="{uid}-load-h" />
				</label>
				<span class="sep" aria-hidden="true">·</span>
				<button type="button" class="btn btn-sm" onclick={openPaste} aria-haspopup="dialog">Paste…</button>
			</div>
		{/if}
	</div>
	<p class="hint explain" id="{uid}-method-h">
		The outlet’s daily EWR, which is split between the units and judged every day: shortfalls, the charge, curtailment and the compliance grid all follow it.
		{#if method === 'tab'}Each month’s TAB flow × the scale factor, every day of the month.{:else if method === 'percentile'}Each day, the Reserve flow ({reserveTable === 'withoutHighFlows' ? 'without high flows' : 'the total, with high flows'}) at the point the day’s natural flow at the outlet sits at in that month’s natural flows, interpolated between points, × the scale factor.{/if}
	</p>

	{#if method !== 'pragmatic'}
		{#if !readonly}
			<div class="load" data-testid="ewr-daily-load">
				<p class="hint explain" id="{uid}-load-h">A .tab gives the TAB flows and the table MAR, a .rul the three percentile tables (natural flow, total Reserve flow, Reserve flow without high flows). A file never changes the choice in Daily EWR from.</p>
				<p class="small" class:err={note && !note.ok} role="status" aria-label="File result">{note?.text ?? ''}</p>
				<p class="small" id="{uid}-paste-s" class:err={pasteNote && !pasteNote.ok} role="status" aria-label="Paste result">{pasteNote?.text ?? ''}</p>
				{#if offerPercentile && method !== 'percentile'}
					<div class="actions"><button type="button" class="btn btn-sm" onclick={usePercentile}>Use the percentile tables</button></div>
				{/if}
				{#if tabPreview}
					<div class="preview" data-testid="ewr-tab-preview">
						<p class="preview-h">{tabPreview.file}, as read</p>
						<DrmTabFileView file={tabFileRecord(tabPreview.tab, tabPreview.file)} used={method === 'tab' ? 'tab' : 'mar'} testid="ewr-tab-preview-file" />
						<p class="small">
							{tabPreview.tab.marMm3 !== null ? '' : 'No MAR line. '}A .tab and a .rul from the same determination go together: the .tab’s MAR scales the .rul’s percentile tables too.
						</p>
						<div class="actions">
							<button type="button" class="btn btn-sm btn-primary" onclick={useTab}>{method === 'tab' ? 'Use these values' : 'Use its MAR only'}</button>
							<button type="button" class="btn btn-sm btn-ghost" onclick={() => (tabPreview = null)}>Cancel</button>
						</div>
					</div>
				{/if}
				<DrmFormatHelp target="dailyEwr" context="of a file for the daily EWR at the outlet" />
			</div>
			<GridPasteDialog
				bind:open={pasteOpen}
				bind:text={pasteText}
				title={method === 'tab' ? 'Paste the TAB flows' : 'Paste a percentile table'}
				layout={method === 'tab'
					? 'The 12 TAB flows in m³/s, Oct … Sep, in a row or a column; month names are skipped. With tabs or semicolons between them, 12,5 is a decimal comma.'
					: 'A percentile table in m³/s: 12 month rows (Oct … Sep, or with month names in the first column) × the 10 points (10 % … 99 %), optionally under a heading row of points. It replaces the whole table.'}
				wholeTable
				plan={(t) => {
					const r = planDailyPaste(src, pasteTarget, t);
					return 'error' in r ? r : r.plan;
				}}
				onapply={applyPaste}
				csv={() => dailyCsv(src, pasteTarget)}
				csvName={method === 'tab' ? 'tab-flows.csv' : pasteTarget === 'naturalPctM3s' ? 'natural-flow-percentiles.csv' : pasteTarget === 'lowFlowPctM3s' ? 'reserve-without-high-flows-percentiles.csv' : 'total-reserve-percentiles.csv'}
			>
				{#snippet target()}
					{#if method === 'percentile'}
						<fieldset class="plain target">
							<legend>Fill</legend>
							{#each ['naturalPctM3s', 'reservePctM3s', 'lowFlowPctM3s'] as const as k (k)}
								<label class="check"><input type="radio" name="{uid}-pt" value={k} bind:group={pasteGridTarget} /> {DAILY_TABLE_LABELS[k]}</label>
							{/each}
						</fieldset>
					{/if}
				{/snippet}
			</GridPasteDialog>
		{/if}
		<div class="fields">
			{#if method === 'percentile'}
				<div class="field">
					<label for="{uid}-reserve">The EWR is the Reserve table</label>
					<select id="{uid}-reserve" disabled={readonly} value={reserveTable} onchange={(e) => edit({ reserveTable: e.currentTarget.value as EwrReserveTable })} aria-describedby="{uid}-reserve-h" data-testid="ewr-reserve-table">
						<option value="total">Total Reserve flow (with high flows; the default)</option>
						<option value="withoutHighFlows">Reserve flow without high flows</option>
					</select>
					<span class="hint explain" id="{uid}-reserve-h">Which of the .rul’s two Reserve tables is read at each day’s natural flow. The other is kept and shown, and drives nothing.</span>
				</div>
			{/if}
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
				<span class="hint explain" id="{uid}-mar-h">The natural MAR the tables were determined for, the TAB header’s “MAR =”.</span>
			</div>
			<div class="field">
				<label for="{uid}-area">Table catchment area <span class="u">(km²)</span></label>
				<NumberInput id="{uid}-area" min={0} nullable disabled={readonly} value={src.tableAreaKm2} onchange={(v) => edit({ tableAreaKm2: v })} aria-describedby="{uid}-area-h {uid}-area-x" />
				<span class="hint" id="{uid}-area-h">Modelled area {fmtNum(modelAreaKm2, 1)} km².<span class="explain" id="{uid}-area-x"> Needed for the area ratio (the default). The modelled area is the area the natural flow is made on (the calibration catchment area when set, else the units’ areas).</span></span>
			</div>
			<p class="factor" id="{uid}-s-h" data-testid="ewr-scale-factor" aria-live="polite">{factor}</p>
		</div>

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
			<!-- The whole .tab the TAB flows came from (issue #617), open: what the client asked to see beside the row. -->
			{#if src.tabFile}
				<!-- Kept for its MAR only (under the percentile tables): no TAB flow came from it, so it says that, and offers them. -->
				{@const marOnly = !src.tabM3s || src.tabM3s.every((v) => v === null)}
				{@const edited = !marOnly && tabFlowsEdited(src.tabM3s, src.tabFile)}
				{#if marOnly}
					<p class="small state" data-testid="ewr-tab-mar-only">{src.tabFile.name} gave only the table MAR.</p>
					{#if !readonly}<div class="actions"><button type="button" class="btn btn-sm" onclick={useKeptTabFlows}>Use its TAB flows</button></div>{/if}
				{:else if edited}<p class="small state" data-testid="ewr-tab-edited">The TAB flows were changed after loading {src.tabFile.name}; the file is shown as loaded.</p>{/if}
				<Fold name="The .tab file:" line="{src.tabFile.name}{src.tabFile.category ? ` · REC ${src.tabFile.category}` : ''}{marOnly ? ' · gave the table MAR only' : edited ? ' · TAB flows changed since' : ' · Total flows, maint. are the TAB flows'}" change="Show" open={true} problem={false} body="none" spaced testid="ewr-tab-file">
					<DrmTabFileView file={src.tabFile} used={marOnly ? 'mar' : 'tab'} testid="ewr-tab-file-view" />
				</Fold>
			{:else if src.tabM3s}
				<p class="small state" data-testid="ewr-tab-legacy">These TAB flows were saved without their .tab file.{readonly ? '' : ' Load the .tab again to see the whole file.'}</p>
			{/if}
		{:else}
			{#snippet grid(which: GridKey)}
				{@const label = DAILY_TABLE_LABELS[which]}
				{@const role = reserveGridRole(which, reserveTable)}
				<div class="table-wrap">
					<table class="data compact rulegrid">
						<caption>{label} <span class="u">(m³/s, before scaling{role ? `, ${role}` : ''})</span></caption>
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
			{#if src.rulFile}
				<!-- The .rul the tables came from (issue #617): its REC shows here even with no outlet rule table. -->
				{@const f = src.rulFile}
				<p class="small state" data-testid="ewr-rul-file">{`From ${f.name}${f.generated ? `, generated ${f.generated}` : ''}, in ${f.unit === 'mcm' ? 'Mm³ a month (converted to m³/s, February 28 days)' : 'm³/s'}${f.category ? ` · Recommended ecological category (REC) ${f.category}` : ''}${f.edited ? '; the tables were changed since' : ''}.`}</p>
			{/if}
			{@render grid('naturalPctM3s')}
			<!-- The Reserve table the daily EWR reads, open; the other folds into its line, since it drives nothing (issue #552). -->
			{@const used = reserveTable === 'withoutHighFlows' ? 'lowFlowPctM3s' : 'reservePctM3s'}
			{@const unused = used === 'lowFlowPctM3s' ? 'reservePctM3s' : 'lowFlowPctM3s'}
			{@render grid(used)}
			<Fold {readonly} name="{DAILY_TABLE_LABELS[unused]}:" line="not used by the daily EWR · {src[unused] ? 'entered' : 'empty'}" open={false} body="none" spaced testid="ewr-unused-reserve">
				{@render grid(unused)}
			</Fold>
			{#if src.tabFile}
				<!-- A .tab used for its MAR only (issue #617, open question 1): kept and shown, folded, as the determination's record. -->
				<Fold name="The .tab this table MAR came from:" line="{src.tabFile.name}{src.tabFile.category ? ` · REC ${src.tabFile.category}` : ''}" change="Show" open={false} problem={false} body="none" spaced testid="ewr-tab-file">
					<DrmTabFileView file={src.tabFile} used="mar" testid="ewr-tab-file-view" />
				</Fold>
			{/if}
		{/if}

		<!-- A statement, not fields: open to start with, its line saying whether the tables are there yet (common/Fold). -->
		<Fold
			name="The tables scaled to the model:"
			line={scaled ? 'each value × s' : 'once the tables and the scale factor are known'}
			open={true}
			problem={false}
			body="none"
			spaced
			testid="ewr-scaled"
		>
			{#if scaled}
				<ScaledEwrTablesView tables={scaled} />
			{:else}
				<p class="small pending" data-testid="ewr-scaled-pending">The scaled tables show here once the tables and the scale factor are known (see the scale factor above).</p>
			{/if}
		</Fold>

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
	/* The source picker and "Fill from" on one line, the buttons level with the select; stacked when narrow. */
	.source-row {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.5rem 1.25rem;
	}
	.source {
		flex: 0 1 24rem;
		min-width: min(100%, 16rem);
		margin-bottom: 0;
	}
	.fill {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
		min-height: 36px;
	}
	.fill-lbl {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.sep {
		color: var(--text-muted);
	}
	.target {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
		margin: 0.25rem 0;
	}
	.target legend {
		font-weight: 500;
		font-size: 0.85rem;
		padding: 0;
	}
	.target .check {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		min-height: 32px;
	}
	.hint {
		font-size: var(--font-sm);
		max-width: 75ch;
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
		font-size: var(--font-sm);
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
	.rulegrid td {
		min-width: 78px;
		padding-left: 0.3rem;
		padding-right: 0.3rem;
	}
	/* As Settings' pragmatic EWR row: slim cells, so the twelve months fit beside the side index at 1440 px (issue #521). */
	.monthly td {
		width: calc(6.5ch + 0.7rem + 2px + 0.4rem);
		padding-left: 0.1rem;
		padding-right: 0.1rem;
	}
	table.data.monthly td :global(input) {
		min-width: calc(6.5ch + 0.7rem + 2px);
		width: 100%;
	}
	.monthly td :global(input[type='number']) {
		appearance: textfield;
		-moz-appearance: textfield;
	}
	.monthly td :global(input[type='number']::-webkit-inner-spin-button),
	.monthly td :global(input[type='number']::-webkit-outer-spin-button) {
		-webkit-appearance: none;
		margin: 0;
	}
	/* The text keeps a reading measure; the .tab preview's monthly table takes the width it needs (issue #617). */
	.load,
	.preview {
		display: grid;
		gap: 0.35rem;
		margin-top: 0.4rem;
		min-width: 0;
	}
	.load p {
		margin: 0;
		max-width: 75ch;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.err {
		color: var(--danger);
		font-size: var(--font-sm);
	}
	.pending {
		margin: 0.35rem 0 0;
	}
	.state {
		margin: 0.35rem 0 0;
		max-width: 75ch;
	}
	.preview-h {
		margin: 0.25rem 0 0;
		font-weight: 500;
		font-size: 0.85rem;
	}
</style>
