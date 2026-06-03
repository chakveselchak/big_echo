use rusqlite::{params, Connection};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_LEASE_TTL_SECS: i64 = 2 * 60 * 60;

#[derive(Debug)]
pub struct BrainUploadLeaseGuard {
    app_data_dir: std::path::PathBuf,
    lease_key: String,
    active: bool,
}

impl Drop for BrainUploadLeaseGuard {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let _ = release_brain_upload_lease(&self.app_data_dir, &self.lease_key);
    }
}

fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn ensure_lease_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS brain_upload_leases (
            lease_key TEXT PRIMARY KEY,
            holder_pid INTEGER NOT NULL,
            expires_at_epoch INTEGER NOT NULL
        );
        ",
    )
    .map_err(|e| e.to_string())
}

fn open_with_leases(app_data_dir: &Path) -> Result<Connection, String> {
    let conn = crate::storage::sqlite_repo::open_connection(app_data_dir)?;
    ensure_lease_table(&conn)?;
    Ok(conn)
}

pub fn try_acquire_brain_upload_lease(
    app_data_dir: &Path,
    lease_key: &str,
    ttl_secs: i64,
) -> Result<BrainUploadLeaseGuard, String> {
    let conn = open_with_leases(app_data_dir)?;
    let now = now_epoch();
    let expires_at = now.saturating_add(ttl_secs.max(1));
    let pid = std::process::id() as i64;

    conn.execute(
        "DELETE FROM brain_upload_leases WHERE expires_at_epoch <= ?1",
        params![now],
    )
    .map_err(|e| e.to_string())?;

    let inserted = conn
        .execute(
            "
            INSERT INTO brain_upload_leases (lease_key, holder_pid, expires_at_epoch)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(lease_key) DO NOTHING
            ",
            params![lease_key, pid, expires_at],
        )
        .map_err(|e| e.to_string())?;

    if inserted == 0 {
        let holder_expires: i64 = conn
            .query_row(
                "
                SELECT expires_at_epoch
                FROM brain_upload_leases
                WHERE lease_key = ?1
                ",
                params![lease_key],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        if holder_expires <= now {
            release_brain_upload_lease(app_data_dir, lease_key)?;
            return try_acquire_brain_upload_lease(app_data_dir, lease_key, ttl_secs);
        }

        return Err(format!(
            "BRAIN_ALREADY_RUNNING: Brain upload lease is held by another process ({lease_key})"
        ));
    }

    Ok(BrainUploadLeaseGuard {
        app_data_dir: app_data_dir.to_path_buf(),
        lease_key: lease_key.to_string(),
        active: true,
    })
}

pub fn release_brain_upload_lease(app_data_dir: &Path, lease_key: &str) -> Result<(), String> {
    let conn = open_with_leases(app_data_dir)?;
    conn.execute(
        "DELETE FROM brain_upload_leases WHERE lease_key = ?1",
        params![lease_key],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn archive_lease_key() -> &'static str {
    "archive"
}

pub fn session_lease_key(session_id: &str) -> String {
    format!("session:{session_id}")
}

pub fn default_lease_ttl_secs() -> i64 {
    DEFAULT_LEASE_TTL_SECS
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn second_process_cannot_acquire_same_lease() {
        let dir = tempdir().expect("tempdir");
        let first = try_acquire_brain_upload_lease(dir.path(), "session:s1", 60).expect("first lease");
        let err = try_acquire_brain_upload_lease(dir.path(), "session:s1", 60)
            .expect_err("second lease should fail");
        assert!(err.contains("BRAIN_ALREADY_RUNNING"));
        drop(first);
        assert!(try_acquire_brain_upload_lease(dir.path(), "session:s1", 60).is_ok());
    }
}
