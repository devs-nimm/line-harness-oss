-- 052: Audit trail for admin-triggered archives (MIN-266)
--
-- archived_by records WHICH staff member archived the session. Only the
-- admin-delete trigger sets it ('/new' and the idle TTL have no actor);
-- together with friend_id + archived_at it forms the audit trail required
-- by the admin "delete conversation" action.

ALTER TABLE chat_sessions ADD COLUMN archived_by TEXT;
