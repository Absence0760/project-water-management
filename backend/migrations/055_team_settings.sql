-- 055_team_settings — a team's own settings, starting with the portfolio's
-- traffic-light thresholds (roadmap WP-2.14, decision D11;
-- docs/data-model.md § Teams, docs/api.md § Teams and § Portfolio).
--
-- Expand-only:
--
--   team.settings jsonb, '{}' by default. The one key so far:
--
--     { "portfolio": { "thresholds": { "green": 5, "amber": 20 } } }
--
--   Percent of the last 30 days with the outlet EWR not met: green below
--   `green`, amber below `amber`, red otherwise. Both 0–100, green < amber.
--   Absent means the defaults (5 % and 20 %, backend/src/portfolio/status.ts
--   EWR_THRESHOLDS), which the hydrologist still has to confirm (plan.md
--   D11). The API validates the same shape (backend/src/teams/settings.ts);
--   the CHECK below holds it for any other writer, and rejects unknown keys
--   so a typo can't sit there silently ignored.
--
-- Access is unchanged: team_select (002) lets every member read the row, so
-- the portfolio can say which thresholds apply; team_update lets only a team
-- admin change it. water_app's table-level grant on team (002) covers the
-- new column. A change is recorded as a `team_thresholds.changed` audit
-- event on each of the team's projects (backend/src/teams/routes.ts), since
-- it changes the status each of them shows.

-- Whether `s` is a valid team settings document. plpgsql so every step is
-- guarded before the next casts (a SQL AND may evaluate out of order).
CREATE FUNCTION app_team_settings_valid(s jsonb) RETURNS boolean
	LANGUAGE plpgsql IMMUTABLE SET search_path = public
	AS $$
	DECLARE
		p jsonb;
		t jsonb;
	BEGIN
		IF s IS NULL OR jsonb_typeof(s) <> 'object' THEN
			RETURN false;
		END IF;
		IF EXISTS (SELECT 1 FROM jsonb_object_keys(s) k WHERE k <> 'portfolio') THEN
			RETURN false;
		END IF;
		p := s->'portfolio';
		IF p IS NULL THEN
			RETURN true;
		END IF;
		IF jsonb_typeof(p) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p) k WHERE k <> 'thresholds') THEN
			RETURN false;
		END IF;
		t := p->'thresholds';
		IF t IS NULL THEN
			RETURN true;
		END IF;
		IF jsonb_typeof(t) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(t) k WHERE k NOT IN ('green', 'amber')) THEN
			RETURN false;
		END IF;
		IF jsonb_typeof(t->'green') IS DISTINCT FROM 'number' OR jsonb_typeof(t->'amber') IS DISTINCT FROM 'number' THEN
			RETURN false;
		END IF;
		RETURN (t->>'green')::numeric >= 0 AND (t->>'amber')::numeric <= 100 AND (t->>'green')::numeric < (t->>'amber')::numeric;
	END
	$$;

ALTER TABLE team
	ADD COLUMN settings jsonb NOT NULL DEFAULT '{}'::jsonb CONSTRAINT team_settings_valid CHECK (app_team_settings_valid(settings));

COMMENT ON COLUMN team.settings IS
	'The team''s settings: { portfolio?: { thresholds?: { green, amber } } }, percent of the last 30 days with the outlet EWR not met; absent = the defaults (5, 20). 055, WP-2.14 D11.';
