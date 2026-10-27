// pnpm import:dws without a database: the arguments, which station a file
// names, and the calls a file becomes (the load itself: feeds/gaugeRecord.db.test.ts).
import { describe, expect, it } from 'vitest';
import { CHUNK_DAYS, parseArgs, planImport, readText, stationOf, SYNTHETIC_DWS_REPLY, type Args } from './import-dws.js';

const args = (over: Partial<Args> = {}): Args => ({ file: SYNTHETIC_DWS_REPLY, reference: 'R', station: null, source: 'dws-request', from: null, to: null, origin: 'fixtures', ...over });

describe('import:dws arguments', () => {
	it('takes a file and a reference, defaulting to a DWS reply and the origin FEED_SOURCE implies', () => {
		expect(parseArgs(['reply.txt', '--reference', 'GR/2026/17'], { INIT_CWD: '/tmp' })).toEqual({
			file: '/tmp/reply.txt',
			reference: 'GR/2026/17',
			station: null,
			source: 'dws-request',
			from: null,
			to: null,
			origin: 'fixtures'
		});
		expect(parseArgs(['reply.txt', '--reference', 'R'], { FEED_SOURCE: 'live' })).toMatchObject({ origin: 'dws' });
		expect(parseArgs(['page.html', '--source', 'upload'], {})).toMatchObject({ source: 'upload', reference: null });
		expect(parseArgs(['r.txt', '--reference', 'R', '--station', 'A2H012', '--from', '2000-01-01', '--to', '2001-12-31'], {})).toMatchObject({ station: 'A2H012', from: '2000-01-01', to: '2001-12-31' });
	});

	it.each([
		[[], 'give one file'],
		[['a.txt', 'b.txt', '--reference', 'R'], 'give one file'],
		[['a.txt'], 'with its reference'],
		[['a.txt', '--reference'], 'needs a value'],
		[['a.txt', '--reference', 'R', '--source', 'dws-web'], '--source is'],
		[['a.txt', '--reference', 'R', '--station', 'A2R012'], 'not a DWS river gauge'],
		[['a.txt', '--reference', 'R', '--from', '2000-01-01'], 'together'],
		[['a.txt', '--reference', 'R', '--from', '2001-01-01', '--to', '2000-01-01'], '--from first'],
		[['a.txt', '--reference', 'R', '--from', '2001-02-30', '--to', '2001-03-01'], 'are dates'],
		[['a.txt', '--reference', 'R', '--origin', 'chc'], '--origin'],
		[['a.txt', '--reference', 'R', '--force', 'x'], 'unknown option'],
		[['a.txt', '--reference', 'x'.repeat(201)], 'at most 200']
	])('refuses %j', (argv, why) => {
		expect(parseArgs(argv, {})).toContain(why);
	});
});

describe('import:dws: the station', () => {
	it('is the one river gauge the text before the table names, else the file name’s, else --station', () => {
		expect(stationOf(readText(SYNTHETIC_DWS_REPLY), SYNTHETIC_DWS_REPLY, null)).toBe('X0H001');
		expect(stationOf('Station : A2H012100.00\nDATE     D AVG F/R  QUAL\n', 'x.txt', null)).toBe('A2H012');
		expect(stationOf('DATE     D AVG F/R  QUAL\n', '/tmp/A2H012-reply.txt', null)).toBe('A2H012');
		expect(stationOf('DATE     D AVG F/R  QUAL\n', '/tmp/reply.txt', 'B1H001')).toBe('B1H001');
		expect(() => stationOf('A2H012 and B1H001\nDATE     D AVG F/R  QUAL\n', 'x.txt', null)).toThrow(/several stations/);
		expect(() => stationOf('DATE     D AVG F/R  QUAL\n', 'reply.txt', null)).toThrow(/no station/);
	});
});

describe('import:dws: the plan', () => {
	it('reads the synthetic reply with the feed’s reader: 89 listed days, one a gap, one call', () => {
		const p = planImport(readText(SYNTHETIC_DWS_REPLY), args());
		expect(p).toMatchObject({ station: 'X0H001', gaps: 1 });
		expect(p.rows).toHaveLength(89);
		expect(p.chunks).toEqual([{ from: '2010-01-01', to: '2010-03-31', rows: p.rows }]);
	});

	it('splits a span longer than one call into calls of CHUNK_DAYS days, each with its rows', () => {
		const p = planImport(readText(SYNTHETIC_DWS_REPLY), args({ from: '1980-01-01', to: '2010-12-31' }));
		expect(p.chunks.length).toBe(2);
		expect(p.chunks[0]).toMatchObject({ from: '1980-01-01', rows: [] });
		expect(p.chunks[1]!.to).toBe('2010-12-31');
		const first = new Date(`${p.chunks[1]!.from}T00:00:00Z`).getTime() - new Date('1980-01-01T00:00:00Z').getTime();
		expect(first / 86_400_000).toBe(CHUNK_DAYS);
		expect(p.chunks[1]!.rows).toHaveLength(89);
	});

	it('refuses a file with no days, or one that isn’t a DWS daily table of flow in m³/s', () => {
		expect(() => planImport('Station : A2H012100.00\nNo data for this period\n', args())).toThrow(/no days/);
		expect(() => planImport('A2H012\nPOS. 10-18  = Daily avg level in metres\nDATE     D AVG F/R  QUAL\n20200101 1.0 1\n', args())).toThrow(/m³\/s/);
	});
});
