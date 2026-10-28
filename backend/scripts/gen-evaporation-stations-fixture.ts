// Write the committed synthetic evaporation stations (issue #646 item 6;
// docs/maps.md § Evaporation stations): an invented station list and an
// invented DWS daily evaporation reply per station, in
// backend/fixtures/evaporation-stations/. Deterministic (a fixed-seed
// generator), so a re-run rewrites the same bytes.
//
//   pnpm -C backend exec tsx scripts/gen-evaporation-stations-fixture.ts
//
// Every station is in drainage region Z, which DWS doesn't use, and every
// value is made up: a smooth seasonal pan curve (summer high, winter low)
// with noise and a few missing days, never a real station's record. The
// stations sit round the Sandspruit example's catchment (21.31° E, 33.79° S;
// backend/scripts/examples/map.ts), so its boundary proposes them:
//  * Z1E001 a Class-A pan inside the catchment, 2014–2019: the one to use;
//  * Z1E002 a Symons pan nearby, 2010–2015: its July S-pan mean is between
//    the two equations' floors, so Taljaard (2023) converts it and WR90 refuses;
//  * Z1E003 a Class-A pan with under two years: too short for monthly means;
//  * Z2E001 a Class-A pan 200 km away: outside the default search radius.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';

const DIR = fileURLToPath(new URL('../fixtures/evaporation-stations/', import.meta.url));

interface Spec {
	code: string;
	name: string;
	pan: 'A' | 'S';
	lat: number;
	lon: number;
	from: string;
	to: string;
	/** Mean daily A-pan, mm, and the seasonal swing either side of it. */
	mean: number;
	swing: number;
	seed: number;
}

const STATIONS: Spec[] = [
	{ code: 'Z1E001', name: 'Testpan Dam (invented)', pan: 'A', lat: -33.765, lon: 21.335, from: '2014-01-01', to: '2019-12-31', mean: 6, swing: 4, seed: 1 },
	{ code: 'Z1E002', name: 'Symons Testpan (invented)', pan: 'S', lat: -33.9, lon: 21.55, from: '2010-01-01', to: '2015-12-31', mean: 5.5, swing: 4, seed: 2 },
	{ code: 'Z1E003', name: 'Short Record (invented)', pan: 'A', lat: -33.55, lon: 21.05, from: '2017-03-01', to: '2018-12-31', mean: 6.5, swing: 4.5, seed: 3 },
	{ code: 'Z2E001', name: 'Far Station (invented)', pan: 'A', lat: -33.0, lon: 23.4, from: '2012-01-01', to: '2016-12-31', mean: 7, swing: 4, seed: 4 }
];

/** A small fixed-seed generator (mulberry32): the same numbers on every run. */
function rng(seed: number) {
	let a = seed * 0x9e3779b9;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function reply(s: Spec): string {
	const r = rng(s.seed);
	const rows: string[] = [];
	for (let d = toEpochDay(s.from); d <= toEpochDay(s.to); d++) {
		const iso = fromEpochDay(d);
		const date = iso.replaceAll('-', '');
		const doy = (d - toEpochDay(`${iso.slice(0, 4)}-01-01`)) / 365.25;
		const a = (s.mean + s.swing * Math.cos(2 * Math.PI * (doy - 15 / 365.25))) * (0.85 + 0.3 * r());
		// A Symons pan reads less than a Class-A pan: S = 0.8706 A − 11.1745 mm a month, spread over its days.
		const v = s.pan === 'A' ? a : Math.max(0, 0.8706 * a - 11.1745 / 30.4);
		const gap = r() < 0.02;
		rows.push(gap ? `${date}${'255'.padStart(16)}` : `${date}${v.toFixed(1).padStart(10)}${'1'.padStart(6)}`);
	}
	return [
		'<html><head><title>Hydrological Services - Station data (SYNTHETIC)</title></head><body>',
		'<!-- An INVENTED reply in the layout of a DWS HyData.aspx daily page: never a real station. -->',
		'<p><pre>',
		`STATION ${s.code}  ${s.name.toUpperCase()}  ${s.pan === 'A' ? 'CLASS-A PAN' : 'SYMONS PAN'}  SYNTHETIC TEST DATA`,
		'POS.  1-8   = Date of daily reading  CCYYMMDD',
		'POS. 10-18  = Daily pan evaporation in millimetres 9999.9',
		'POS. 20-24  = Quality code',
		'',
		'DATE        D EVAP  QUAL',
		...rows,
		'ZZZZZZZZZZZZ',
		'</pre></p>',
		'</body></html>',
		''
	].join('\n');
}

const list = ['code,name,pan,lat,lon', ...STATIONS.map((s) => [s.code, s.name, s.pan, s.lat, s.lon].join(','))].join('\n') + '\n';
writeFileSync(`${DIR}stations.synthetic.csv`, list);
for (const s of STATIONS) writeFileSync(`${DIR}${s.code}-reply.synthetic.html`, reply(s));
console.log(`${STATIONS.length} synthetic evaporation stations written to ${DIR}`);
