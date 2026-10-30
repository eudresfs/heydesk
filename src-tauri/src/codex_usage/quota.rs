//! Observações de cota da fonte local. Não há inferência a partir de tokens.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const FRESH_SECONDS: i64 = 300;
const EARLIEST_TIMESTAMP: i64 = 1_577_836_800; // 2020-01-01, em segundos.
const MAX_WINDOW_MINUTES: u32 = 366 * 24 * 60;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    pub id: String,
    pub used_percent: f64,
    pub remaining_percent: Option<f64>,
    pub last_known_remaining_percent: f64,
    pub window_minutes: Option<u32>,
    pub resets_at: Option<i64>,
    pub state: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexQuotaSnapshot {
    pub enabled: bool,
    pub provider_id: String,
    pub provider_name: String,
    pub state: String,
    pub source: String,
    pub observed_at: Option<String>,
    pub windows: Vec<QuotaWindow>,
}

impl CodexQuotaSnapshot {
    pub(super) fn initial(enabled: bool) -> Self {
        Self { enabled, provider_id: "codex".into(), provider_name: "Codex".into(),
            state: if enabled { "unavailable" } else { "disabled" }.into(),
            source: "codex_log".into(), observed_at: None, windows: Vec::new() }
    }

    pub(super) fn age(&mut self, now: i64) {
        if !self.enabled || self.windows.is_empty() { return; }
        let fresh = self.observed_at.as_deref().and_then(|at| DateTime::parse_from_rfc3339(at).ok())
            .is_some_and(|at| at.timestamp() <= now.saturating_add(60) && now.saturating_sub(at.timestamp()) <= FRESH_SECONDS);
        for window in &mut self.windows {
            window.state = if window.resets_at.is_some_and(|reset| reset <= now) { "reset_pending" }
                else if fresh { "available" } else { "stale" }.into();
            window.remaining_percent = (window.state == "available").then_some(window.last_known_remaining_percent);
        }
        self.state = if self.windows.iter().any(|window| window.state == "available") { "available" } else { "stale" }.into();
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub(super) struct ObservedWindow {
    pub id: String,
    pub used: f64,
    pub minutes: Option<u32>,
    pub resets: Option<i64>,
}

pub(super) struct Observation { pub at: i64, pub windows: Vec<ObservedWindow> }

// Apenas raízes sem metadados de herança são elegíveis. O log não fornece um
// ordinal de corte confiável para distinguir token_count herdado de um fork.
pub(super) fn safe_session(metadata: &Value) -> bool {
    let Some(object) = metadata.as_object() else { return false; };
    if object.iter().any(|(key, value)| !value.is_null()
        && (key.starts_with("parent_") || key.starts_with("forked_from") || key.starts_with("history_base"))) { return false; }
    match object.get("source") {
        Some(Value::Object(_)) => false,
        Some(Value::String(source)) => {
            let source = source.to_ascii_lowercase();
            !source.contains("subagent") && !source.contains("fork")
        },
        _ => true,
    }
}

pub(super) fn parse(timestamp: Option<&str>, payload: &str) -> Option<Observation> {
    parse_at(timestamp, payload, Utc::now().timestamp())
}

fn parse_at(timestamp: Option<&str>, payload: &str, now: i64) -> Option<Observation> {
    let at = DateTime::parse_from_rfc3339(timestamp?).ok()?.timestamp();
    if !(EARLIEST_TIMESTAMP..=now.saturating_add(60)).contains(&at) { return None; }
    let payload: Value = serde_json::from_str(payload).ok()?;
    let limits = payload.get("rate_limits")?.as_object()?;
    // Identidades de outros produtos não representam a cota Codex.
    if limits.get("limit_id")?.as_str()? != "codex" { return None; }
    let mut windows = Vec::new();
    for id in ["primary", "secondary"] {
        let Some(window) = limits.get(id).and_then(Value::as_object) else { continue; };
        let Some(used) = window.get("used_percent").and_then(Value::as_f64)
            .filter(|n| n.is_finite() && (0.0..=100.0).contains(n)) else { continue; };
        let used = if used == 0.0 { 0.0 } else { used };
        let minutes = match window.get("window_minutes") {
            None | Some(Value::Null) => None,
            Some(value) => match value.as_u64().and_then(|n| u32::try_from(n).ok()).filter(|n| *n > 0 && *n <= MAX_WINDOW_MINUTES) {
                Some(n) => Some(n), None => continue,
            },
        };
        let resets = match window.get("resets_at") {
            None | Some(Value::Null) => None,
            Some(value) => match value.as_i64().filter(|n| (EARLIEST_TIMESTAMP..=now.saturating_add(366 * 86_400)).contains(n)) {
                Some(n) => Some(n), None => continue,
            },
        };
        windows.push(ObservedWindow { id: id.into(), used, minutes, resets });
    }
    if windows.is_empty() { None } else { Some(Observation { at, windows }) }
}

pub(super) fn snapshot(at: i64, windows: Vec<ObservedWindow>, now: i64) -> CodexQuotaSnapshot {
    let mut snapshot = CodexQuotaSnapshot::initial(true);
    let Some(observed) = DateTime::from_timestamp(at, 0) else { return snapshot; };
    snapshot.observed_at = Some(observed.to_rfc3339());
    let fresh = now.saturating_sub(at) <= FRESH_SECONDS && at <= now.saturating_add(60);
    snapshot.windows = windows.into_iter().map(|window| {
        let remaining = 100.0 - window.used;
        let state = if window.resets.is_some_and(|reset| reset <= now) { "reset_pending" }
            else if fresh { "available" } else { "stale" };
        QuotaWindow { id: window.id, used_percent: window.used,
            remaining_percent: (state == "available").then_some(remaining),
            last_known_remaining_percent: remaining, window_minutes: window.minutes,
            resets_at: window.resets, state: state.into() }
    }).collect();
    snapshot.state = if snapshot.windows.iter().any(|window| window.state == "available") { "available" } else { "stale" }.into();
    snapshot
}

#[cfg(test)]
mod tests {
    use super::*;
    const NOW: i64 = 1_793_200_000;
    fn payload(used: Value, minutes: Value, resets: Value) -> String {
        serde_json::json!({"type":"token_count","info":null,"rate_limits":{"limit_id":"codex","primary":{
            "used_percent":used,"window_minutes":minutes,"resets_at":resets},"secondary":null}}).to_string()
    }
    fn time(at: i64) -> String { DateTime::from_timestamp(at, 0).unwrap().to_rfc3339() }
    #[test]
    fn seven_day_primary_is_not_assumed_to_be_five_hours() {
        let observation = parse_at(Some(&time(NOW)), &payload(61.into(), 10080.into(), (NOW+86400).into()), NOW).unwrap();
        let result = snapshot(observation.at, observation.windows, NOW);
        assert_eq!(result.windows.len(), 1); assert_eq!(result.windows[0].window_minutes, Some(10080));
        assert_eq!(result.windows[0].remaining_percent, Some(39.0));
    }
    #[test]
    fn missing_invalid_percent_duration_and_millisecond_reset_are_unknown() {
        for (used, minutes, resets) in [(Value::Null, 10080.into(), (NOW+100).into()), ((-1).into(), 10080.into(), (NOW+100).into()),
            (101.into(), 10080.into(), (NOW+100).into()), (61.into(), 0.into(), (NOW+100).into()), (61.into(), 10080.into(), (NOW*1000).into())] {
            assert!(parse_at(Some(&time(NOW)), &payload(used, minutes, resets), NOW).is_none());
        }
        assert!(parse_at(Some(&time(NOW+3600)), &payload(61.into(), 10080.into(), (NOW+86400).into()), NOW).is_none());
    }
    #[test]
    fn stale_and_reset_do_not_restore_remaining() {
        let observation = parse_at(Some(&time(NOW)), &payload(61.into(), 10080.into(), (NOW+86400).into()), NOW).unwrap();
        let stale = snapshot(observation.at, observation.windows.clone(), NOW+301);
        assert_eq!(stale.state, "stale"); assert_eq!(stale.windows[0].remaining_percent, None);
        assert_eq!(stale.windows[0].last_known_remaining_percent, 39.0);
        let reset = snapshot(observation.at, observation.windows, NOW+86400);
        assert_eq!(reset.windows[0].state, "reset_pending"); assert_eq!(reset.windows[0].remaining_percent, None);
    }
    #[test]
    fn reset_can_expire_while_observation_is_still_fresh() {
        let observation = parse_at(Some(&time(NOW)), &payload(61.into(), 10080.into(), (NOW+10).into()), NOW).unwrap();
        let mut result = snapshot(observation.at, observation.windows, NOW);
        result.age(NOW+10);
        assert_eq!(result.state,"stale"); assert_eq!(result.windows[0].state,"reset_pending");
        assert_eq!(result.windows[0].remaining_percent,None);
        assert_eq!(result.windows[0].last_known_remaining_percent,39.0);
    }
}
