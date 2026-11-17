-- 321_feed_source_station_api — a rainfall station's data read from its
-- provider's own web API (issue #784; docs/data-model.md § Data feeds and
-- § Station API credentials, docs/architecture.md § Data feeds).
--
-- data_feed.source accepts 'station_api' beside 'chirps', 'chirps_gefs',
-- 'dws', 'ecmwf_ens' and 'agera5_et0'. The CHECK is 260_feed_source_agera5_et0's
-- (its latest definition, data_feed_source_check), dropped and added again
-- under the same name in one statement, so the table is never without it.
-- feeds/config.ts FEED_SOURCES lists the same six, and
-- scripts/guards/data_sources.mjs checks that they agree. Its schedule is
-- app_feed_next_attempt's default (243, 253): a day after the last attempt.
--
-- data_feed_credential: the key a station API feed sends, sealed by the API to
-- the fetcher's public key (feeds/credential.ts: X25519 + HKDF + AES-GCM, the
-- feed's id as additional data, so a sealed value copied onto another feed's
-- row doesn't open). Nothing in the database can open it. Its own table, not a
-- column of data_feed, because:
--   * viewers read data_feed (the feed panel); only editors read this table,
--     and only the fetch job does (as the feed's acting user, an owner, which
--     passes the sealed bytes to the fetcher unopened);
--   * replacing a key must not reset the feed: data_feed_stamp clears a feed's
--     progress when its config changes, and fires only on data_feed.
-- One row per feed (cascades with it). `hint` is the secret's last four
-- characters, kept only for a secret of 16 or more (credentialHint), for the
-- card's "key saved · ends …abcd". RLS: SELECT editor, INSERT/UPDATE/DELETE
-- owner (feeds are owner-configured, 018). data_feed_credential_stamp checks the
-- feed is the row's project's and a station_api feed, and stamps who and when.
-- The routes delete the row when a feed's source moves off station_api.
-- app_feed_credential_state: what the panel shows of the key (saved, when; the
-- hint to editors and owners), to viewers too, never the sealed bytes.

ALTER TABLE data_feed
	DROP CONSTRAINT data_feed_source_check,
	ADD CONSTRAINT data_feed_source_check CHECK (source IN ('chirps', 'chirps_gefs', 'dws', 'ecmwf_ens', 'agera5_et0', 'station_api'));

CREATE TABLE data_feed_credential (
	feed_id    uuid PRIMARY KEY REFERENCES data_feed(id) ON DELETE CASCADE,
	project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- feeds/credential.ts SEALED_MAX: the longest secret and user, sealed, base64.
	sealed     text NOT NULL CHECK (char_length(sealed) BETWEEN 1 AND 6000),
	hint       text CHECK (char_length(hint) = 4),
	updated_at timestamptz NOT NULL DEFAULT now(),
	updated_by uuid REFERENCES app_user(id) ON DELETE SET NULL
);
-- Cover the project_id and updated_by foreign keys (feed_id is covered by the primary key).
CREATE INDEX data_feed_credential_project_idx ON data_feed_credential (project_id);
CREATE INDEX data_feed_credential_updated_by_idx ON data_feed_credential (updated_by);

COMMENT ON TABLE data_feed_credential IS
	'A station API feed''s key, sealed to the fetcher''s public key (321, feeds/credential.ts); nothing in the database can open it. water_app: SELECT (editor: the fetch job, as the feed''s acting user), INSERT/UPDATE/DELETE (owner). Never returned by the API.';
COMMENT ON COLUMN data_feed_credential.hint IS
	'The secret''s last four characters, only for a secret of 16 or more (feeds/credential.ts credentialHint); NULL otherwise.';

-- The feed must be the row's project's and a station API feed; who saved it and when are stamped, never taken from the caller.
CREATE FUNCTION data_feed_credential_stamp() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		feed_project uuid;
		feed_source  text;
	BEGIN
		SELECT f.project_id, f.source INTO feed_project, feed_source FROM data_feed f WHERE f.id = NEW.feed_id;
		IF feed_project IS DISTINCT FROM NEW.project_id THEN
			RAISE EXCEPTION 'feed_id % belongs to a different project', NEW.feed_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF feed_source IS DISTINCT FROM 'station_api' THEN
			RAISE EXCEPTION 'only a station API feed keeps a credential' USING ERRCODE = 'check_violation';
		END IF;
		IF TG_OP = 'UPDATE' AND NEW.sealed IS NOT DISTINCT FROM OLD.sealed AND NEW.hint IS NOT DISTINCT FROM OLD.hint THEN
			-- The key is unchanged (an account deletion's ON DELETE SET NULL, say): keep when, and let who only be cleared.
			NEW.updated_at := OLD.updated_at;
			NEW.updated_by := CASE WHEN NEW.updated_by IS NULL THEN NULL ELSE OLD.updated_by END;
			RETURN NEW;
		END IF;
		NEW.updated_at := now();
		NEW.updated_by := app_current_user_id();
		RETURN NEW;
	END
	$$;
CREATE TRIGGER data_feed_credential_stamp BEFORE INSERT OR UPDATE ON data_feed_credential
	FOR EACH ROW EXECUTE FUNCTION data_feed_credential_stamp();

ALTER TABLE data_feed_credential ENABLE ROW LEVEL SECURITY;
CREATE POLICY data_feed_credential_select ON data_feed_credential FOR SELECT USING (app_has_role(project_id, 'editor'));
CREATE POLICY data_feed_credential_insert ON data_feed_credential FOR INSERT WITH CHECK (app_has_role(project_id, 'owner'));
CREATE POLICY data_feed_credential_update ON data_feed_credential FOR UPDATE
	USING (app_has_role(project_id, 'owner')) WITH CHECK (app_has_role(project_id, 'owner'));
CREATE POLICY data_feed_credential_delete ON data_feed_credential FOR DELETE USING (app_has_role(project_id, 'owner'));

GRANT SELECT, INSERT, UPDATE, DELETE ON data_feed_credential TO water_app;

-- What the feed panel shows of a station API feed's key, to every member who can read the feed (viewer and up): whether
-- one is saved and when; the hint (its last four characters) only to an editor or owner, who can read the row itself.
-- NULL for another source, or for a caller who can't read the feed. SECURITY DEFINER because a viewer may not read
-- data_feed_credential (its policy is editor), and the sealed bytes never leave through it.
CREATE FUNCTION app_feed_credential_state(p_feed uuid) RETURNS jsonb
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	SELECT jsonb_build_object(
		'saved', c.feed_id IS NOT NULL,
		'hint', CASE WHEN app_has_role(f.project_id, 'editor') THEN c.hint END,
		'updatedAt', to_char(c.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
	FROM data_feed f LEFT JOIN data_feed_credential c ON c.feed_id = f.id
	WHERE f.id = p_feed AND f.source = 'station_api' AND app_has_role(f.project_id, 'viewer')
	$$;
REVOKE EXECUTE ON FUNCTION app_feed_credential_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_feed_credential_state(uuid) TO water_app;
