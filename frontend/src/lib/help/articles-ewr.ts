// The glossary's articles for the EWR topic (category 'ewr' in tips.ts):
// the Reserve, the pragmatic EWR, its shortfalls and ecological categories.
// Same shape and rules as articles.ts, in the tips' order. A module of its
// own, like articles-data.ts, so the /help pages load the glossary's long
// text in chunks each under the bundle guard's per-chunk ceiling
// (vite.config.ts helpArticlesChunk); content.ts joins them.

import type { HelpArticle } from './types';

export const EWR_ARTICLES: Record<string, HelpArticle> = {
	// ---- EWR ----------------------------------------------------------------
	'ewr': {
		long: 'In South Africa the National Water Act’s term is the Reserve: its ecological part, often called the ecological Reserve, is the water kept to protect aquatic ecosystems (the other part is basic human needs). Older studies call it the IFR (instream flow requirement). It is derived per river for an ecological category, typically with the Desktop Reserve Model. This model checks every day whether the simulated flow meets it.',
		aliases: ['Reserve', 'ecological reserve', 'IFR', 'instream flow requirement', 'environmental flow'],
		related: ['pragmatic-ewr', 'ewr-shortfall', 'ecological-category', 'desktop-reserve-model'],
		source: 'b023 EWR Cfg; docs/model.md §7'
	},
	'pragmatic-ewr': {
		long: 'Reserve tables vary the requirement with how wet the month is, which is hard to plan for on a farm. b023 instead picks one value per month — typically a percentile of the Reserve flows without high flows, converted to m³/day — so farmers know in advance how much to leave in the river.\n\nEnter the 12 monthly values, Oct … Sep. The catchment value is checked at the outflow gauge and split into per-unit shares by the flow shares; each gauge is checked against the shares of everything upstream of it.',
		related: ['ewr', 'desktop-reserve-model', 'flow-share'],
		source: 'b023 Help (EWR configuration); EWR Cfg; docs/model.md §3 Q10'
	},
	'ewr-share': {
		long: 'The daily series is the cumulative EWR: the hydrological unit’s own share plus the cumulative EWR of the elements directly upstream, as the b023 Element sheets compute it (quirk Q4). A gauge is checked against the same sum, and the outflow gauge against the full EWR. Who is charged for a shortfall is the EWR charge, not a hydrological unit’s own share.',
		related: ['pragmatic-ewr', 'ewr-shortfall'],
		source: 'b023 Fragmented EWR; docs/model.md §3 Q4'
	},
	'ewr-shortfall': {
		long: 'At the outflow gauge it is simulated outflow minus the pragmatic EWR on days it falls short; at a gauge, the flow there minus the EWR of everything upstream. Who is charged for it is the EWR charge.',
		aliases: ['EWR not met', 'deficit to the river'],
		related: ['ewr-days-not-met', 'pragmatic-ewr', 'ewr-charge'],
		source: 'b023 EWR shortfalls sheet'
	},
	'ewr-charge': {
		long: 'The EWR is assessed at EWR sites: the outlet and every gauge marked as an EWR site (the default). On a day a site is short by D, each hydrological unit upstream of it has a net impact e = inflow + runoff + transfers − outflow (its consumptive use, storage gain and exports; a transfer counts only when it leaves the site’s catchment). The hydrological units are charged D in proportion to the positive impacts, but never more than the sum of those impacts: the rest is natural, because natural flow was already below the EWR. A hydrological unit that added water that day (a dam release, return flow) is neither charged nor credited. A hydrological unit above several sites carries the largest of its charges, not the sum, because a cut upstream raises the flow at every site below it; the site that sets it is its binding site, stored with the run each day (engine 1.5.0).\n\nA hydrological unit short on its own reach is not charged while every EWR site is met. Add gauges at the Reserve determination’s EWR sites to protect upstream reaches. A cut can be taken up by a dam between two nested sites; only a re-run with the cuts applied shows that.\n\nThe curtailment report uses the charge (engine 0.17.0). Before, it used the reach shortfall, which could charge a hydrological unit more than it took or for low flow nobody caused. Decided on a simulated CMA-assessor recommendation (2026-09-24), pending the real assessor and hydrologist.\n\nEvery table and export shows the charge as a positive volume charged (m³/day), and its irrigate-less and store-less parts the same way; the changes it asks for (supply cut, total change) are negative, a reduction. Only the daily series (ewr_charge, ewr_charge_irrigation) keep the workbook’s sign, negative on a day with a charge.',
		aliases: ['EWR attribution', 'charged to hydrological units', 'charged to farms', 'natural shortfall', 'binding site', 'net impact'],
		related: ['ewr-shortfall', 'ewr-charge-split', 'reach-shortfall'],
		source: 'docs/model.md §2.7b; docs/engine-audit.md Q17'
	},
	'ewr-charge-split': {
		long: 'For a hydrological unit charged A on a day, c = supplied − return flow is its consumptive irrigation and o = e − c the rest of its impact (storage gain and net export). The irrigation part is A × c ÷ (c + max(o, 0)); the rest is “store less / pass inflow”. A hydrological unit with no irrigation therefore gets no irrigation cut: its charge is a storage or release condition.\n\nThe supply cut that removes the irrigation part is irrigation part ÷ (1 − r), with r the return flow (the share of the water supplied that comes back to the river, at most 1 − the irrigation efficiency): cutting supply by ΔG removes ΔG × (1 − r) of consumptive use, since the returned water comes back to the river.',
		aliases: ['supply cut', 'pass inflow', 'store less'],
		related: ['ewr-charge', 'irrigation-efficiency'],
		source: 'docs/model.md §2.7b and §2.11; docs/engine-audit.md Q13, Q17'
	},
	'reach-shortfall': {
		long: 'MIN(AA − Σ AA of the elements directly upstream, 0), as the b023 Element sheets compute it. It shows where along the river the flow falls below the accumulated EWR, but it does not add up to the outlet shortfall, never credits a hydrological unit that adds water, and can charge a hydrological unit for a reach the next hydrological unit makes good. From engine 0.17.0 it no longer drives curtailment: the EWR charge does.',
		aliases: ['incremental shortfall', 'AB'],
		related: ['ewr-charge'],
		source: 'b023 Element sheets column AB; docs/model.md §3 Q17'
	},
	'ewr-days-not-met': {
		long: 'The headline measure of how often the river fails. Look at when the failures happen, too: a few summer weeks every year differ from a multi-year drought.\n\nFor a hydrological unit it counts the days the hydrological unit was charged for a shortfall at an EWR site below it (engine 0.17.0; before, the days its reach shortfall was below 0).',
		related: ['ewr-shortfall'],
		source: 'b023 EWR analysis'
	},
	'reserve-rules': {
		long: 'A South African Reserve determination (the Desktop Reserve Model and its revised form) gives the ecological water requirement as a table: for each month, the flow required at each assurance level, or “% point” (10 %, 20 % … 90 %, 99 %). Assurance is the share of time the flow should be equalled or exceeded, so 10 % is the requirement in wet conditions and 99 % the drought flow. The gazette pairs it with the natural flow at the same points.\n\nEnter one table per EWR site: the outlet, or a gauge placed at the determination’s EWR site. Say where it comes from, the hydrological unit (Mm³ per month, or the month’s mean m³/s), whether it is the total flow or low flows only, and where the natural-flow percentile comes from: the run’s own natural flow at the site (ranked among the same month in every year of the run), or the table’s natural flows. The scale multiplies every value, for a table given for a larger or smaller catchment than the site.\n\nPaste the 12 month rows from a spreadsheet or a PDF, with the heading row of % points if you have it; month names in the first column put rows in order. The table adds a monthly compliance report. The pragmatic EWR drives the daily EWR charge and curtailment unless the Settings choice “EWR charge follows” is set to the rule tables.',
		aliases: ['assurance rules', 'assurance table', 'rule curve', 'Reserve rule table', 'Reserve determination', 'maintenance low flows', 'drought flows'],
		related: ['reserve-compliance', 'ewr', 'desktop-reserve-model', 'ewr-days-not-met'],
		source: 'Hughes & Hannart (2003); Hughes et al. (2014); Pollard et al. (2011) WRC K8/881/2; docs/model.md §2.9c'
	},
	'reserve-compliance': {
		long: 'For each complete calendar month, the month’s natural flow at the EWR site (the upstream hydrological units’ runoff, before any dam or abstraction) is placed on that month’s natural flow duration curve. The EWR is read from the rule table at the same % point, interpolated between points, and the month is met when the simulated flow at the site is at least that. A naturally dry month is held to the drought flow; a wet one to more. The requirement depends only on natural flow, so more abstraction can only lose months.\n\nThe report gives the share of months met (the headline), per month of the year, the deficit volume, the longest run of consecutive months not met and the FDC check: whether the simulated flow duration curve of each month lies on or above the EWR curve at each % point. Days below the pragmatic EWR stay alongside as a second measure. With fewer than 10 years of a month the percentiles are coarse, and the run says so. The daily series ewr_rule is each month’s requirement per day.',
		aliases: ['Reserve compliance', 'assurance compliance', 'months met', 'contiguity', 'FDC check'],
		related: ['reserve-rules', 'ewr-days-not-met', 'ewr-agreement', 'reserve-low-flows', 'reserve-high-flows'],
		source: 'Hughes & Münster (2000); Sawunyama & Hughes (2010); Pollard et al. (2011); Riddell et al. (2014); docs/model.md §2.9c'
	},
	'reserve-low-flows': {
		long: 'The Desktop Reserve Model gives two assurance tables for a site: the total flow (low flows plus high flows) and the low flows alone, each per month at the 10 % … 99 % points. The low flows fall from the maintenance low flow at the wetter points to the drought low flow at 99 %.\n\nEnter the low-flow table beside a total-flow table and each month is judged twice at the same natural percentile: against the total and against the low flows. A month that meets its low flows but not the total failed only its high flows (the heat map shows ◐); one below its low flows (●) is the more serious failure. The difference between the two requirements is the month’s high-flow part. As a provisional default, not yet confirmed by the catchment’s hydrologist: both are judged on the month’s total flow volume, unless the Settings choice “Low flows judged on” is set to base flow.',
		aliases: ['maintenance low flow', 'drought low flow', 'low-flow table', 'low flows', 'base flow requirement'],
		related: ['reserve-rules', 'reserve-compliance', 'reserve-high-flows', 'desktop-reserve-model'],
		source: 'Hughes & Hannart (2003); Hughes et al. (2014); docs/model.md §2.9d'
	},
	'reserve-high-flows': {
		long: 'Reserve determinations ask for high flows as well as low flows: small freshets that reset the riverbed and cue fish to spawn, and larger floods that scour pools and reach the floodplain. Each component here is a name, the months it may peak in, a peak (m³/s, daily mean), the event’s duration in days from the rise to the end of the recession (not days held at the peak), and how many such events a water year needs.\n\nThe check runs on every complete water year at the site. An event is a run of days at or above half the peak that reaches the peak, first in one of the months, and lasts at least half the duration: what a flood hydrograph of that peak and duration, drawn as a triangle, spends above half its peak. Two peaks count as two events only if the flow falls below half the peak between them. A year is asked for no more events than the site’s natural flow had that year: a dry year that would have had no flood is not failed for it, while a dam that holds back a flood the river would have had is. The table’s scale multiplies the peak too.',
		aliases: ['freshet', 'flood', 'high flow', 'flood pulse', 'maintenance high flows'],
		related: ['reserve-rules', 'reserve-compliance', 'reserve-low-flows'],
		source: 'Hughes & Hannart (2003); Pollard et al. (2011); docs/model.md §2.9d'
	},
	'ewr-charge-source': {
		long: 'The EWR charge (each hydrological unit’s share of the shortfall at the EWR sites below it) and the curtailment it sets follow a daily requirement at each site. By default that is the pragmatic EWR, as in the b023 workbook. Set it to the Reserve rule tables and, at a site with a rule table, each complete calendar month’s requirement from the table (the one the monthly compliance report judges, the daily series ewr_rule) becomes the daily requirement for that month’s days. A site without a table, and a part month at either end of the run, keep the pragmatic EWR, and the run says how many days that was.\n\nThe EWR required and met at each site (under the EWR by month grid on River & reserve) follow the same choice. The shortfall the charge followed at such a site is the daily series ewr_charge_shortfall; the pragmatic EWR, its days not met and the observed-record agreement stay as they are. Which the charge should follow is a question for the hydrologist and the assessor, so the pragmatic EWR stays the default.',
		aliases: ['charge from the rule table', 'EWR charge basis', 'rule-table charge', 'ewrChargeSource'],
		related: ['ewr-charge', 'reserve-rules', 'reserve-compliance', 'water-account'],
		source: 'Provisional decision 2026-10-01, not yet confirmed by the catchment’s hydrologist (plan.md question 17); docs/model.md §2.9c'
	},
	'ewr-daily-source': {
		long: 'The outlet’s daily EWR is what every day is judged by: it is split between the hydrological units by their flow share, and the shortfalls, the EWR charge, curtailment and the compliance grid all follow it. It can come from one of three places.\n\nThe pragmatic EWR (the default): one flow per month, as in the b023 workbook. The DRM TAB file: the Desktop Reserve Model summary’s monthly “Total Flows, Maint.”, entered in m³/s (a .tab file’s Mm³ a month are converted over each month’s days, February 28), the same flow every day of the month. The DRM percentile tables: the rule-curve output’s natural flow and total Reserve flow at the ten % points; each day, the natural flow at the outlet (net of the natural bed losses when they are on) picks its place in that month’s natural flows, and the Reserve flow is read there, interpolated between points, held at the wettest point above it and scaled with the flow below the driest.\n\nThe tables are usually for a larger catchment than the model, so every value is multiplied by a scale factor: the model’s natural MAR at the outlet ÷ the table’s MAR, or the modelled area ÷ the table’s area. Each run works its factor out from its own natural flow and says in its warnings and summary which EWR it was judged by.',
		aliases: ['TAB file', 'rul file', 'percentile tables', 'DRM tables', 'daily EWR source', 'ewrDailySource', 'scale factor'],
		related: ['pragmatic-ewr', 'desktop-reserve-model', 'reserve-rules', 'ewr-shortfall'],
		source: 'Hughes & Hannart 2003 (Desktop Reserve Model); docs/model.md §2.9f; issue #455'
	},
	'low-flow-measure': {
		long: 'A low-flow requirement (a table that covers low flows only, or the low-flow part of a total-flow table) is judged against one figure for the month. By default that is the month’s total flow volume, so a month with a flood can pass its low flows even though the river ran short the rest of the month.\n\nSet it to base flow and the month is judged on its base flow instead: the simulated flow at the site with the quick flow taken out by the Lyne–Hollick digital filter (three passes, α = 0.995, the value found for daily flows in most South African catchments). The total-flow requirement is still judged on the month’s total flow, and the natural-flow percentile still comes from the natural flow. The catchment’s hydrologist judges the low flows on the total flow (2026-10-10), so it stays the default. The filter settings are unconfirmed: the Desktop Reserve Model’s own base-flow separation (Hughes, Hannart & Watkins 2003) may use one pass rather than three, so check it before relying on the base-flow option.',
		aliases: ['base flow', 'baseflow filter', 'Lyne–Hollick', 'digital filter', 'lowFlowMeasure'],
		related: ['reserve-low-flows', 'reserve-compliance', 'reserve-rules'],
		source: 'Lyne & Hollick (1979); Nathan & McMahon (1990); Smakhtin & Watkins (1997) WRC 494/1/97; Hughes et al. (2003) Water SA 29(1); docs/model.md §2.9d'
	},
	'ewr-agreement': {
		long: 'A gauge or logger measures the same river the outlet EWR test uses, so on each observed day the observed flow takes the test too. Hit rate: share of the river’s failures the model also has (1 ideal). False-alarm ratio: share of the model’s failures the river didn’t have (0 ideal). Frequency bias: the model’s share of days below the EWR ÷ the observed share (1 ideal). Use it to judge which runoff model’s EWR count to trust.',
		aliases: ['EWR agreement', 'frequency bias', 'hit rate', 'false-alarm ratio', 'contingency table'],
		related: ['ewr-days-not-met'],
		source: 'docs/model.md §2.9b'
	},
	'desktop-reserve-model': {
		long: 'Its tables — with and without high flows, in M.m³ per month at the 10 %–99 % points — are the usual starting point for the pragmatic EWR.',
		aliases: ['Desktop Version 2', 'DRM', 'Reserve tables'],
		related: ['pragmatic-ewr', 'ecological-category'],
		source: 'b023 EWR Cfg',
		countries: ['ZA']
	},
	'ecological-category': {
		long: 'The higher the target category, the more flow the Reserve keeps in the river. A river’s present state can be E or F (seriously or critically modified), but those aren’t management targets: the lowest category a Reserve is set for is D.',
		aliases: ['EC', 'present ecological state', 'category B'],
		related: ['ewr'],
		source: 'docs/model.md §7'
	}
};
