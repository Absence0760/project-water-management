// Client-side check of settings.dataQuality, mirroring the backend's
// SettingsPatch rules (backend/src/projects/settings.ts), so Save is blocked
// with a readable message instead of a 400.
import type { DataQualitySettings } from '@water-management/engine';

export function dataQualityError(dq: Partial<DataQualitySettings> | null | undefined): string | null {
	const min = dq?.agreementMinRatio;
	const max = dq?.agreementMaxRatio;
	const days = dq?.agreementMinDays;
	const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
	if (!num(min) || !(min > 0 && min <= 1)) return 'The lowest gauge/logger ratio must be above 0 % and at most 100 %.';
	if (!num(max) || !(max >= 1 && max <= 100)) return 'The highest gauge/logger ratio must be between 100 % and 10 000 %.';
	if (!num(days) || !Number.isInteger(days) || days < 1 || days > 366) return 'Minimum shared days must be a whole number from 1 to 366.';
	return null;
}
