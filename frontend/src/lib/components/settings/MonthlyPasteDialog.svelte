<script lang="ts">
	// Paste the monthly A-pan and pan coefficients from a spreadsheet (issue #477; monthlyPaste.ts): into a month of
	// either row, or from a "Paste from a spreadsheet…" button. One per place the rows show: Demand's A-pan row
	// (SettingsTab.svelte) and Flow calibration's pan coefficient row (CalibrationSettings.svelte), so each half keeps
	// its own when the calibration panels move to a page of their own (issue #586). The panel calls openPaste() from
	// its button and paste() from its row's onpaste. Editors only: a viewer gets neither.
	import GridPasteDialog from '#lib/components/model/GridPasteDialog.svelte';
	import { gridPasteTarget, type PasteAnchor, type PastePlan } from '#lib/spreadsheet/paste/grid.js';
	import { applyMonthlyPaste } from '#lib/spreadsheet/paste/monthlyRows.js';
	import { WATER_YEAR_MONTHS } from '#lib/format/months.js';
	import { MONTHLY_SETTINGS_FORMAT, monthlySettingRows, monthlySettingsCsv, planSettingsPaste, type MonthlySettingId } from './monthlyPaste';
	import type { SettingsDraft } from './settingsDraft.svelte';

	let {
		draft,
		pan,
		readonly
	}: {
		/** The unsaved settings the paste writes into (settingsDraft.svelte.ts). */
		draft: SettingsDraft;
		/** GR4J runs on pan coefficient × A-pan, so the pan coefficient row shows and takes a paste too. */
		pan: boolean;
		readonly: boolean;
	} = $props();

	const s = $derived(draft.s);
	const rows = $derived(monthlySettingRows(s, pan));
	let open = $state(false);
	let text = $state('');
	let anchor = $state<PasteAnchor | null>(null);
	let announce = $state('');
	const where = $derived(anchor ? `${rows[anchor.row]?.name ?? 'A-pan evaporation'}, ${WATER_YEAR_MONTHS[anchor.col] ?? 'Oct'}` : null);

	/** The panel's "Paste from a spreadsheet…" button: an empty box, anchored nowhere. */
	export function openPaste() {
		if (readonly) return;
		anchor = null;
		text = '';
		open = true;
	}

	/** A block pasted into a month of the A-pan or pan coefficient row: that row and month anchor a block without names. */
	export function paste(e: ClipboardEvent, row: MonthlySettingId) {
		if (readonly) return;
		const t = gridPasteTarget(e);
		if (!t) return;
		const cell = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-paste-col]') : null;
		anchor = { row: Math.max(0, rows.findIndex((r) => r.id === row)), col: cell ? Number(cell.dataset.pasteCol) : 0 };
		text = t.text;
		open = true;
	}

	function apply(plan: PastePlan) {
		applyMonthlyPaste(plan, (id, m, v) => {
			if (id === 'apanMm') s.apanMm[m] = v;
			else if (id === 'panCoefficient') s.panCoefficient[m] = v;
		});
		announce = `Pasted ${plan.changes.length} monthly ${plan.changes.length === 1 ? 'value' : 'values'}. Save the settings to keep them.`;
	}
</script>

<p class="visually-hidden" aria-live="polite">{announce}</p>
{#if !readonly}
	<GridPasteDialog
		bind:open
		bind:text
		title="Paste monthly evaporation"
		layout={pan
			? 'The monthly A-pan (mm) and pan coefficients (× A-pan): a row each, named A-pan evaporation and Pan coefficient, under a heading row of months, Oct to Sep (as the CSV below has them); one row is enough. Without names or headings the values fill from the month you pasted into.'
			: 'The monthly A-pan in mm: a row named A-pan evaporation under a heading row of months, Oct to Sep (as the CSV below has it); without a name or headings the values fill from the month you pasted into.'}
		{where}
		plan={(t) => planSettingsPaste(t, rows, anchor)}
		onapply={apply}
		csv={() => monthlySettingsCsv(rows)}
		csvName="monthly-evaporation.csv"
		format={MONTHLY_SETTINGS_FORMAT}
	/>
{/if}
