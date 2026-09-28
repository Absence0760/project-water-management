import { describe, expect, it } from 'vitest';
import { withNoteLine } from './csvNote';

describe('withNoteLine', () => {
	it('puts the note first, after the BOM, as one # line, and keeps the file as it was after it', () => {
		const csv = '﻿date,Supplied (m³/day)\r\n2024-01-01,3\r\n';
		expect(withNoteLine(csv, 'Estimates,\nnot measurements.')).toBe('﻿# Estimates, not measurements.\r\ndate,Supplied (m³/day)\r\n2024-01-01,3\r\n');
		// Blob.text() drops the BOM: it is put back.
		expect(withNoteLine('date\r\n', 'x')).toBe('﻿# x\r\ndate\r\n');
	});
});
