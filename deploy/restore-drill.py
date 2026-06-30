#!/usr/bin/env python3
"""Postgres backup + RESTORE drill for the multitenant Ghost stack.

Dumps the live database, restores it into a throwaway scratch DB, and verifies that
row counts + a sample tenant's data survive the round trip. The point is to prove
your backups actually restore — *untested backups are not backups*.

Defaults target the dev stack (ghost-dev-postgres, superuser `ghost`). For production,
set PG_CONTAINER / PG_SUPERUSER, and ideally adapt it to dump to an OFF-box file and
restore into a SEPARATE instance (this version dumps+restores within one instance,
which still proves dump integrity + restorability + data parity).

Env:
  PG_CONTAINER  postgres container name      (default ghost-dev-postgres)
  PG_SUPERUSER  superuser role               (default ghost)
  PG_DB         source DB name               (default: auto-discover the one with a `sites` table)
  TB_TENANT     tenant slug to spot-check    (default wayland)

Exit 0 = backup restored and verified; 1 = a mismatch or failure (do NOT trust the backup).
"""
import os
import subprocess
import sys
import time

PG = os.environ.get("PG_CONTAINER", "ghost-dev-postgres")
USER = os.environ.get("PG_SUPERUSER", "ghost")
TENANT = os.environ.get("TB_TENANT", "wayland")
SCRATCH = "tb_restore_drill"
DUMP = "/tmp/tb_restore_drill.dump"
TABLES = ["sites", "users", "posts", "pages", "members", "tags", "newsletters", "subscriptions"]

failures = []


def run(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, **kw)


def psql(db, sql):
    r = run(["docker", "exec", PG, "psql", "-U", USER, "-d", db, "-tAc", sql])
    return r.stdout.strip(), r.returncode, r.stderr.strip()


def count(db, table, where=""):
    sql = "SELECT count(*) FROM {}{}".format(table, (" WHERE " + where) if where else "")
    out, rc, err = psql(db, sql)
    if rc != 0:
        return None
    try:
        return int(out)
    except ValueError:
        return None


print("=" * 68)
print("POSTGRES RESTORE DRILL  (container={}, user={})".format(PG, USER))
print("=" * 68)

# 0. preflight
if run(["docker", "exec", PG, "true"]).returncode != 0:
    print("FAIL: cannot exec into container '{}'".format(PG))
    sys.exit(1)

# 1. discover the source DB (the one holding the multitenant schema)
src = os.environ.get("PG_DB", "").strip()
if not src:
    dbs, _, _ = psql("postgres", "SELECT datname FROM pg_database WHERE datistemplate=false "
                                  "AND datname NOT IN ('postgres','{}')".format(SCRATCH))
    for d in [x.strip() for x in dbs.splitlines() if x.strip()]:
        ok, rc, _ = psql(d, "SELECT to_regclass('public.sites')")
        if rc == 0 and ok and ok != "":
            src = d
            break
if not src:
    print("FAIL: could not find a source DB with a `sites` table (set PG_DB).")
    sys.exit(1)
print("source DB: {}".format(src))

# 2. capture source row counts + the tenant's site_id
src_counts = {t: count(src, t) for t in TABLES}
site_id, _, _ = psql(src, "SELECT id FROM sites WHERE slug='{}' LIMIT 1".format(TENANT))
tenant_posts_src = count(src, "posts", "site_id='{}'".format(site_id)) if site_id else None
print("source counts: " + ", ".join("{}={}".format(t, src_counts[t]) for t in TABLES if src_counts[t] is not None))
print("tenant '{}' (site_id={}): posts={}".format(TENANT, site_id or "?", tenant_posts_src))

# 3. dump
t0 = time.time()
print("\n[1/4] pg_dump ...", end=" ", flush=True)
d = run(["docker", "exec", PG, "pg_dump", "-U", USER, "-d", src, "-Fc", "-f", DUMP])
if d.returncode != 0:
    print("FAIL\n" + d.stderr[-400:])
    sys.exit(1)
sz, _, _ = psql("postgres", "SELECT 1")  # noop
size = run(["docker", "exec", PG, "sh", "-c", "ls -la {} | awk '{{print $5}}'".format(DUMP)]).stdout.strip()
print("ok ({} bytes, {:.1f}s)".format(size, time.time() - t0))

# 4. (re)create scratch DB and restore into it
print("[2/4] create scratch DB '{}' ...".format(SCRATCH), end=" ", flush=True)
psql("postgres", "DROP DATABASE IF EXISTS {}".format(SCRATCH))
_, rc, err = psql("postgres", "CREATE DATABASE {}".format(SCRATCH))
print("ok" if rc == 0 else "FAIL " + err)
print("[3/4] pg_restore ...", end=" ", flush=True)
r = run(["docker", "exec", PG, "pg_restore", "-U", USER, "-d", SCRATCH, "--no-owner", DUMP])
# pg_restore can exit non-zero on benign warnings; verify by data, not just exit code.
print("done (exit {})".format(r.returncode))

# 5. verify parity
print("[4/4] verify parity:")
for t in TABLES:
    if src_counts.get(t) is None:
        continue
    rc_dst = count(SCRATCH, t)
    ok = rc_dst == src_counts[t]
    if not ok:
        failures.append("{}: src={} restored={}".format(t, src_counts[t], rc_dst))
    print("   {:14} src={:>7} restored={:>7}  {}".format(t, src_counts[t], rc_dst, "OK" if ok else "MISMATCH"))
if site_id:
    rc_t = count(SCRATCH, "posts", "site_id='{}'".format(site_id))
    ok = rc_t == tenant_posts_src
    if not ok:
        failures.append("tenant {} posts: src={} restored={}".format(TENANT, tenant_posts_src, rc_t))
    print("   tenant {:7} posts  src={:>7} restored={:>7}  {}".format(TENANT, tenant_posts_src, rc_t, "OK" if ok else "MISMATCH"))

# 6. cleanup
psql("postgres", "DROP DATABASE IF EXISTS {}".format(SCRATCH))
run(["docker", "exec", PG, "rm", "-f", DUMP])

print("\n" + "=" * 68)
if failures:
    print("RESULT: RESTORE DRILL FAILED — backup is NOT trustworthy")
    for f in failures:
        print("  -", f)
    sys.exit(1)
print("RESULT: backup dumped, restored, and verified — restore path is GOOD ({:.1f}s total)".format(time.time() - t0))
sys.exit(0)
