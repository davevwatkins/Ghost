-- Town Brief newsletter + title branding — PRODUCTION apply
-- ONLY valid against the MULTITENANT Ghost DB (the one with a `sites` table +
-- site_id-scoped settings/newsletters). If prod is still per-town separate Ghost
-- containers, this does NOT apply — brand each town's Ghost via its own admin/API.
--
-- BACK UP FIRST, e.g.:
--   docker exec <pg-container> pg_dump -U ghost -d <proddb> --no-owner --no-privileges \
--     | gzip > prod-prebrand-YYYYMMDD.sql.gz
--
-- Standard (decided 2026-06-30): title = "<Town> News"; counties = "<Cap> County News";
-- legacy names flattened (Wayland/Lexington/Concord); default site excluded.
-- From = news@townbrief.com, reply-to = news@townbrief.com, footer = "by Town Brief".

BEGIN;

-- 1) Site titles  (sender_name is blank, so this also sets the email From display name)
WITH target AS (
  SELECT s.id sid,
    CASE
      WHEN s.slug ~ 'county$' THEN initcap(regexp_replace(s.slug,'county$','')) || ' County News'
      WHEN s.slug = 'wayland'   THEN 'Wayland News'
      WHEN s.slug = 'lexington' THEN 'Lexington News'
      WHEN s.slug = 'concord'   THEN 'Concord News'
      ELSE s.name || ' News'
    END nt
  FROM sites s
  WHERE s.slug <> 'default'
)
UPDATE settings st SET value = t.nt, updated_at = now()
FROM target t
WHERE st.site_id = t.sid AND st.key = 'title';

-- 2) Newsletters: branded sender, real reply-to, "by Town Brief" footer
WITH target AS (
  SELECT s.id sid,
    CASE
      WHEN s.slug ~ 'county$' THEN initcap(regexp_replace(s.slug,'county$','')) || ' County News'
      WHEN s.slug = 'wayland'   THEN 'Wayland News'
      WHEN s.slug = 'lexington' THEN 'Lexington News'
      WHEN s.slug = 'concord'   THEN 'Concord News'
      ELSE s.name || ' News'
    END nt
  FROM sites s
  WHERE s.slug <> 'default'
)
UPDATE newsletters n SET
  sender_email    = 'news@townbrief.com',
  sender_reply_to = 'news@townbrief.com',
  footer_content  = '<p>' || t.nt || ' is a Town Brief publication. <a href="https://townbrief.com">townbrief.com</a></p>',
  updated_at = now()
FROM target t
WHERE n.site_id = t.sid;

-- Review the row counts, then:   COMMIT;   (or ROLLBACK; to back out)
COMMIT;
```
