-- 093_farm_notice — which version of the farm view's "Before you look at
-- your farm" notice each account acknowledged, and when (issue #47; the CPA
-- s49 research's R2: specific notice of the "modelled, not measured" risk,
-- and assent to it, before a farmer sees their figures).
--
-- The farm pages show the notice before any figure until the account has
-- acknowledged the version in force (the engine's FARMER_NOTICE_VERSION);
-- "I understand" sends that version to POST /auth/me/farm-notice, which
-- refuses any other and stores it here. /auth/me answers `farmNoticeCurrent`.
--
-- The same shape as 087's terms record: two columns on app_user, both NULL
-- or both set, the version a YYYY-MM-DD date; the time is the database's,
-- never the caller's (app_user_farm_notice_stamp), and a record is never
-- cleared. New columns on an existing table: the table-level grants to
-- water_app (001) and app_user's policies (068) already cover them; no
-- foreign key, so no index. Both are in the data-subject export
-- (auth/export.ts) and go with the row when an account is deleted.

ALTER TABLE app_user
	ADD COLUMN farm_notice_version text,
	ADD COLUMN farm_notice_accepted_at timestamptz,
	ADD CONSTRAINT app_user_farm_notice_both CHECK ((farm_notice_version IS NULL) = (farm_notice_accepted_at IS NULL)),
	ADD CONSTRAINT app_user_farm_notice_version_date CHECK (farm_notice_version ~ '^\d{4}-\d{2}-\d{2}$');

COMMENT ON COLUMN app_user.farm_notice_version IS
	'The farm view notice ("Before you look at your farm") this account acknowledged: its effective date, YYYY-MM-DD (the engine''s FARMER_NOTICE_VERSION). NULL: never acknowledged.';
COMMENT ON COLUMN app_user.farm_notice_accepted_at IS
	'When farm_notice_version was acknowledged: stamped by the database (app_user_farm_notice_stamp), never the caller.';

CREATE FUNCTION app_user_farm_notice_stamp() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF NEW.farm_notice_version IS NULL THEN
			-- A record is never cleared: the version and time stay.
			NEW.farm_notice_version := OLD.farm_notice_version;
			NEW.farm_notice_accepted_at := OLD.farm_notice_accepted_at;
		ELSIF NEW.farm_notice_version IS DISTINCT FROM OLD.farm_notice_version THEN
			NEW.farm_notice_accepted_at := now();
		ELSE
			NEW.farm_notice_accepted_at := OLD.farm_notice_accepted_at;
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER app_user_farm_notice_stamp BEFORE UPDATE OF farm_notice_version, farm_notice_accepted_at ON app_user
	FOR EACH ROW EXECUTE FUNCTION app_user_farm_notice_stamp();
