use super::*;
use chrono::{FixedOffset, TimeZone};
use std::{fs, io::Write, sync::atomic::{AtomicU64, Ordering}};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture { root: PathBuf }
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("heydesk-codex-test-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(root.join("sessions")).unwrap(); Self { root }
    }
    fn file(&self, name: &str, text: &str) { fs::write(self.root.join("sessions").join(name), text).unwrap(); }
    fn importer(&self) -> importer::Importer { importer::Importer::open(self.root.clone(), &self.root.join("metrics.sqlite")).unwrap() }
    fn collect(&self, importer: &mut importer::Importer) -> CodexUsageSnapshot {
        importer.start_scan().unwrap();
        while importer.step().unwrap() {}
        importer.snapshot(false).unwrap()
    }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); } }
fn meta(owner: &str) -> String {
    serde_json::json!({"type": "session_meta", "payload": {"id": owner, "cwd": "PRIVATE_PROJECT"}}).to_string() + "\n"
}
fn record(id: &str, owner: &str, total: u64) -> String {
    serde_json::json!({
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "type": "token_usage_record",
        "payload": {
            "thread_id": owner,
            "response_id": id,
            "usage": {
                "input_tokens": 10,
                "cached_input_tokens": 4,
                "output_tokens": 5,
                "reasoning_output_tokens": 2,
                "total_tokens": total
            }
        }
    }).to_string() + "\n"
}
fn total(s: &CodexUsageSnapshot) -> u64 { s.days.iter().map(|d| d.total_tokens).sum() }

fn quota_record(at: i64, used: u32) -> String {
    serde_json::json!({"timestamp":chrono::DateTime::from_timestamp(at, 0).unwrap().to_rfc3339(),
        "type":"event_msg","payload":{"type":"token_count","info":null,
        "rate_limits":{"limit_id":"codex","primary":{"used_percent":used,"window_minutes":10080,"resets_at":at+86400},"secondary":null}}}).to_string()+"\n"
}

#[test]
fn quota_is_available_even_when_usage_is_legacy_only() {
    let f = Fixture::new(); let now = Utc::now().timestamp();
    f.file("quota.jsonl", &(meta("root")+&quota_record(now, 61)));
    let mut i=f.importer(); let usage=f.collect(&mut i);
    assert_eq!(usage.status, UsageStatus::InsufficientData); assert_eq!(total(&usage), 0);
    let quota=i.quota_snapshot_at(now).unwrap();
    assert_eq!(quota.state, "available"); assert_eq!(quota.windows[0].remaining_percent, Some(39.0));
    assert_eq!(quota.windows[0].window_minutes, Some(10080));
}

#[test]
fn quota_remains_independent_when_response_aggregation_fails() {
    let f=Fixture::new(); let now=Utc::now().timestamp();
    f.file("a.jsonl", &(meta("a")+&record("r1","a",MAX_SAFE_INTEGER)+&record("r2","a",1)+&quota_record(now,61)));
    let mut i=f.importer(); i.start_scan().unwrap(); while i.step().unwrap() {}
    assert!(i.snapshot(false).is_err());
    assert_eq!(i.quota_snapshot_at(now).unwrap().windows[0].remaining_percent,Some(39.0));
}

#[test]
fn identical_quota_replay_preserves_original_observation_after_restart() {
    let f=Fixture::new(); let now=Utc::now().timestamp();
    let original=quota_record(now-600,61);
    // Mesmo reset e janela, alterando somente timestamp do envelope.
    let mut replay: serde_json::Value=serde_json::from_str(original.trim()).unwrap();
    replay["timestamp"]=serde_json::json!(chrono::DateTime::from_timestamp(now,0).unwrap().to_rfc3339());
    f.file("a.jsonl", &(meta("a")+&original+&replay.to_string()+"\n"));
    { let mut i=f.importer(); f.collect(&mut i); }
    let mut i=f.importer(); f.collect(&mut i); let quota=i.quota_snapshot_at(now).unwrap();
    assert_eq!(quota.state,"stale"); assert_eq!(quota.windows[0].remaining_percent,None);
    assert_eq!(chrono::DateTime::parse_from_rfc3339(quota.observed_at.as_ref().unwrap()).unwrap().timestamp(),now-600);
}

#[test]
fn fork_parent_metadata_does_not_make_inherited_quota_safe() {
    let f=Fixture::new(); let now=Utc::now().timestamp();
    let child=serde_json::json!({"type":"session_meta","payload":{"id":"child","forked_from_id":"parent"}}).to_string()+"\n";
    f.file("child.jsonl", &(child+&meta("parent")+&quota_record(now,61)+&record("own","child",15)));
    { let mut i=f.importer(); assert_eq!(total(&f.collect(&mut i)),15); assert_eq!(i.quota_snapshot_at(now).unwrap().state,"unavailable"); }
    // A flag de segurança também deve sobreviver ao checkpoint/reinício.
    let mut file=fs::OpenOptions::new().append(true).open(f.root.join("sessions/child.jsonl")).unwrap();
    file.write_all(quota_record(now,62).as_bytes()).unwrap(); drop(file);
    let mut i=f.importer(); f.collect(&mut i); assert_eq!(i.quota_snapshot_at(now).unwrap().state,"unavailable");
}

#[test]
fn subagent_and_missing_owner_do_not_establish_account_quota() {
    let f=Fixture::new(); let now=Utc::now().timestamp();
    let child=serde_json::json!({"type":"session_meta","payload":{"id":"child","source":{"subagent":{"parent_thread_id":"p"}}}}).to_string()+"\n";
    f.file("agent.jsonl", &(child+&quota_record(now,61)));
    f.file("missing.jsonl", &quota_record(now,61));
    let mut i=f.importer(); f.collect(&mut i); assert_eq!(i.quota_snapshot_at(now).unwrap().state,"unavailable");
}

#[test]
fn simultaneous_conflicting_quota_is_unknown() {
    let f=Fixture::new(); let now=Utc::now().timestamp();
    f.file("a.jsonl", &(meta("a")+&quota_record(now,61)+&quota_record(now,62)));
    let mut i=f.importer(); f.collect(&mut i); assert_eq!(i.quota_snapshot_at(now).unwrap().state,"unavailable");
}

#[test]
fn schema_one_migration_replays_eof_without_losing_responses() {
    let f=Fixture::new(); let now=Utc::now().timestamp();
    f.file("a.jsonl", &(meta("a")+&record("r1","a",15)+&quota_record(now,61)));
    { let mut i=f.importer(); assert_eq!(total(&f.collect(&mut i)),15); }
    {
        let db=rusqlite::Connection::open(f.root.join("metrics.sqlite")).unwrap();
        db.execute_batch("DROP TABLE quota_observations; ALTER TABLE checkpoints DROP COLUMN quota_safe; PRAGMA user_version=1;").unwrap();
        assert!(db.query_row("SELECT offset FROM checkpoints",[],|row|row.get::<_,i64>(0)).unwrap()>0);
    }
    let mut i=f.importer(); assert_eq!(total(&f.collect(&mut i)),15);
    assert_eq!(i.quota_snapshot_at(now).unwrap().windows[0].remaining_percent,Some(39.0));
    let db=rusqlite::Connection::open(f.root.join("metrics.sqlite")).unwrap();
    assert_eq!(db.query_row("SELECT COUNT(*) FROM responses",[],|row|row.get::<_,i64>(0)).unwrap(),1);
    assert_eq!(db.query_row("PRAGMA user_version",[],|row|row.get::<_,i64>(0)).unwrap(),2);
}

#[test]
fn disabled_monitor_keeps_quota_disabled_without_opening_database() {
    let f=Fixture::new(); let database=f.root.join("must-not-exist.sqlite");
    let monitor=CodexMonitor::new(f.root.clone(),database.clone(),false);
    assert_eq!(monitor.quota_snapshot().state,"disabled");
    assert!(!monitor.quota_snapshot().enabled); assert!(!database.exists());
}

#[test]
fn durable_and_legacy_mirror_are_one_response_and_restart_is_idempotent() {
    let f = Fixture::new();
    f.file("a.jsonl", &(meta("a") + &record("r1", "a", 15) + "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"total_tokens\":99999}}}}\n"));
    { let mut i = f.importer(); let s = f.collect(&mut i); assert_eq!(total(&s), 15); assert_eq!(s.days[0].response_count, 1); assert_eq!(s.legacy_only_files, 0); }
    let mut i = f.importer(); assert_eq!(total(&f.collect(&mut i)), 15);
}
#[test]
fn distinct_ids_with_identical_metrics_are_both_counted() {
    let f = Fixture::new(); f.file("a.jsonl", &(meta("a") + &record("r1", "a", 15) + &record("r2", "a", 15)));
    let mut i = f.importer(); let s = f.collect(&mut i); assert_eq!(total(&s), 30); assert_eq!(s.days[0].cached_input_tokens, 8); assert_eq!(s.days[0].cache_write_input_tokens, None);
}
#[test]
fn conflicting_response_is_excluded_from_confirmed_totals() {
    let f = Fixture::new(); f.file("a.jsonl", &(meta("a") + &record("r1", "a", 15) + &record("r1", "a", 20)));
    let mut i = f.importer(); let s = f.collect(&mut i); assert_eq!(total(&s), 0); assert_eq!(s.conflicts, 1); assert_eq!(s.status, UsageStatus::InsufficientData);
}
#[test]
fn child_own_usage_counts_and_inherited_usage_is_not_reattributed() {
    let f = Fixture::new(); f.file("parent.jsonl", &(meta("p") + &record("parent", "p", 15)));
    f.file("child.jsonl", &(meta("c") + &record("parent", "p", 15) + &record("child", "c", 15)));
    let mut i = f.importer(); let s = f.collect(&mut i); assert_eq!(total(&s), 30); assert_eq!(s.days[0].session_count, 2); assert_eq!(s.invalid_records, 1);
}

#[test]
fn copied_parent_meta_does_not_replace_child_owner_even_after_restart() {
    let f = Fixture::new();
    f.file("child.jsonl", &(meta("child") + &meta("parent") + &record("inherited", "parent", 15) + &record("own", "child", 15)));
    {
        let mut i = f.importer(); let s = f.collect(&mut i);
        assert_eq!(total(&s), 15); assert_eq!(s.days[0].response_count, 1);
        assert_eq!(s.invalid_records, 1); assert_eq!(s.status, UsageStatus::InsufficientData);
    }
    let mut file = fs::OpenOptions::new().append(true).open(f.root.join("sessions/child.jsonl")).unwrap();
    file.write_all((meta("parent") + &record("own-after-restart", "child", 15)).as_bytes()).unwrap(); drop(file);
    let mut i = f.importer(); let s = f.collect(&mut i);
    assert_eq!(total(&s), 30); assert_eq!(s.days[0].response_count, 2); assert_eq!(s.days[0].session_count, 1);
}
#[test]
fn legacy_only_is_insufficient_and_not_zero_usage() {
    let f = Fixture::new(); f.file("old.jsonl", &(meta("a") + "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\"}}\n"));
    let mut i = f.importer(); let s = f.collect(&mut i); assert_eq!(s.status, UsageStatus::InsufficientData); assert_eq!(s.legacy_only_files, 1); assert!(s.today.is_none());
}
#[test]
fn partial_line_waits_then_truncation_replays_without_duplicates() {
    let f = Fixture::new(); let r = record("r1", "a", 15); let split = r.len() / 2;
    f.file("a.jsonl", &(meta("a") + &r[..split])); let mut i = f.importer();
    let partial = f.collect(&mut i); assert_eq!(total(&partial), 0);
    assert_eq!(partial.pending_files, 1); assert!(!partial.scanning);
    assert_eq!(partial.status, UsageStatus::InsufficientData);
    let mut out = fs::OpenOptions::new().append(true).open(f.root.join("sessions/a.jsonl")).unwrap(); out.write_all(r[split..].as_bytes()).unwrap(); drop(out);
    let complete = f.collect(&mut i); assert_eq!(total(&complete), 15); assert_eq!(complete.pending_files, 0);
    f.file("a.jsonl", &(meta("a") + &record("r1", "a", 15) + &record("r2", "a", 15)));
    assert_eq!(total(&f.collect(&mut i)), 30);
}
#[test]
fn oversized_lines_are_bounded_and_following_records_survive() {
    let f = Fixture::new(); f.file("a.jsonl", &(meta("a") + &"x".repeat(6 * 1024 * 1024) + "\n" + &record("r1", "a", 15)));
    let mut i = f.importer(); let s = f.collect(&mut i); assert_eq!(total(&s), 15); assert_eq!(s.invalid_records, 1);
}
#[test]
fn local_day_uses_offset_instead_of_utc_day() {
    let at = chrono::DateTime::parse_from_rfc3339("2026-10-28T01:30:00Z").unwrap();
    let zone = FixedOffset::west_opt(3 * 3600).unwrap();
    assert_eq!(importer::local_date(at.timestamp(), &zone).unwrap().to_string(), "2026-10-27");
    assert_eq!(zone.with_ymd_and_hms(2026, 10, 27, 22, 30, 0).unwrap().timestamp(), at.timestamp());
}
#[test]
fn disabled_monitor_does_not_create_database_or_read_invalid_home() {
    let f = Fixture::new(); let db = f.root.join("never-created.sqlite");
    let m = CodexMonitor::new(f.root.join("absent"), db.clone(), false);
    assert_eq!(m.request_refresh().status, UsageStatus::Disabled); drop(m); assert!(!db.exists());
}
#[test]
fn database_contains_only_metrics_and_minimal_ids() {
    let f = Fixture::new(); f.file("a.jsonl", &(meta("a") + "{\"type\":\"response_item\",\"payload\":{\"content\":\"PRIVATE_PROMPT_AND_RESPONSE\"}}\n" + &record("r1", "a", 15)));
    { let mut i = f.importer(); f.collect(&mut i); }
    let bytes = fs::read(f.root.join("metrics.sqlite")).unwrap();
    let raw = String::from_utf8_lossy(&bytes); assert!(!raw.contains("PRIVATE_PROMPT")); assert!(!raw.contains("PRIVATE_PROJECT"));
}

#[test]
fn invalid_or_unsafe_numbers_are_never_confirmed() {
    let f = Fixture::new();
    let unsafe_record = record("unsafe", "a", MAX_SAFE_INTEGER + 1);
    let negative_record = record("negative", "a", 15).replace("\"input_tokens\":10", "\"input_tokens\":-1");
    f.file("a.jsonl", &(meta("a") + &unsafe_record + &negative_record));
    let mut i = f.importer(); let s = f.collect(&mut i);
    assert_eq!(s.invalid_records, 2); assert!(s.days.is_empty()); assert!(s.today.is_none());
}

#[test]
fn daily_overflow_returns_error_instead_of_rounding_or_zero() {
    let f = Fixture::new();
    f.file("a.jsonl", &(meta("a") + &record("r1", "a", MAX_SAFE_INTEGER) + &record("r2", "a", 1)));
    let mut i = f.importer(); i.start_scan().unwrap(); while i.step().unwrap() {}
    assert!(i.snapshot(false).is_err());
}

#[test]
fn cache_write_is_sum_only_when_all_records_report_it() {
    let f = Fixture::new();
    let known = record("r1", "a", 15).replace("\"cached_input_tokens\":4", "\"cached_input_tokens\":4,\"cache_write_input_tokens\":2");
    f.file("a.jsonl", &(meta("a") + &known));
    let mut i = f.importer(); assert_eq!(f.collect(&mut i).days[0].cache_write_input_tokens, Some(2));
    let mut file = fs::OpenOptions::new().append(true).open(f.root.join("sessions/a.jsonl")).unwrap();
    file.write_all(record("r2", "a", 15).as_bytes()).unwrap(); drop(file);
    assert_eq!(f.collect(&mut i).days[0].cache_write_input_tokens, None);
}

#[test]
fn incomplete_record_crossing_batch_boundary_is_retried_in_next_batch() {
    let f = Fixture::new();
    let padding = serde_json::json!({"type": "response_item", "payload": {"text": "x".repeat(50_000)}}).to_string() + "\n";
    let mut text = meta("a"); while text.len() < 4 * 1024 * 1024 - 150 { text.push_str(&padding); }
    text.push_str(&record("r1", "a", 15)); f.file("a.jsonl", &text);
    let mut i = f.importer(); let s = f.collect(&mut i); assert_eq!(total(&s), 15);
}

#[test]
fn rotating_file_preserves_previous_usage_and_adds_new_ids_once() {
    let f = Fixture::new(); f.file("a.jsonl", &(meta("a") + &record("r1", "a", 15)));
    let mut i = f.importer(); assert_eq!(total(&f.collect(&mut i)), 15);
    f.file("a.jsonl", &meta("a")); assert_eq!(total(&f.collect(&mut i)), 15);
    f.file("a.jsonl", &(meta("a") + &record("r2", "a", 15)));
    assert_eq!(total(&f.collect(&mut i)), 30);
}

#[test]
fn corrupted_checkpoint_sizes_and_negative_numbers_fail_without_unbounded_allocation() {
    for statement in ["UPDATE checkpoints SET anchor_len=257", "UPDATE checkpoints SET prefix_len=9223372036854775807", "UPDATE checkpoints SET offset=-1"] {
        let f = Fixture::new(); f.file("a.jsonl", &(meta("a") + &record("r1", "a", 15)));
        { let mut i = f.importer(); f.collect(&mut i); }
        {
            let db = rusqlite::Connection::open(f.root.join("metrics.sqlite")).unwrap();
            db.execute(statement, []).unwrap();
        }
        let mut i = f.importer(); i.start_scan().unwrap(); assert!(i.step().is_err());
    }
}
