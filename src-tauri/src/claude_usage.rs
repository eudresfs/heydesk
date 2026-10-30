// Cota oficial do Claude (mesma fonte do /usage do Claude Code). O token OAuth do
// Claude Code é lido do arquivo de credenciais a cada consulta, só em memória.
// Vencido, ele é renovado como o CLI faz e gravado de volta no mesmo arquivo
// (autorizado pelo usuário): o refresh token gira, então o arquivo tem de receber
// o par novo, preservando todos os outros campos.
use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{path::PathBuf, sync::{Arc, Condvar, Mutex}, thread, time::{Duration, Instant}};

const ENDPOINT: &str = "https://api.anthropic.com/api/oauth/usage";
// Valores do próprio Claude Code (versão 2.1.308): TOKEN_URL e CLIENT_ID de produção.
const TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/// Renova um pouco antes de vencer, para a consulta não pegar o token no limite.
const REFRESH_MARGIN_MS: i64 = 60_000;
static REFRESHING: std::sync::Mutex<()> = std::sync::Mutex::new(());
const POLL: Duration = Duration::from_secs(60);
const BACKOFF: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeLimit {
    pub kind: String,
    pub group: String,
    pub label: String,
    pub percent: f64,
    pub severity: String,
    pub resets_at: Option<i64>,
    pub window_minutes: Option<u32>,
    pub active: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeQuotaSnapshot {
    pub enabled: bool,
    /// "available" | "stale" | "unavailable" | "disabled"
    pub state: String,
    pub plan: Option<String>,
    pub observed_at: Option<i64>,
    pub limits: Vec<ClaudeLimit>,
    pub reason: Option<String>,
}

impl ClaudeQuotaSnapshot {
    fn empty(enabled: bool) -> Self {
        Self { enabled, state: if enabled { "unavailable" } else { "disabled" }.into(), plan: None, observed_at: None, limits: Vec::new(), reason: None }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OAuth { access_token: String, refresh_token: Option<String>, expires_at: Option<i64>, #[serde(default)] scopes: Vec<String>, subscription_type: Option<String>, rate_limit_tier: Option<String> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Credentials { claude_ai_oauth: Option<OAuth> }

fn credentials_path() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") { return Some(PathBuf::from(dir).join(".credentials.json")); }
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(|home| PathBuf::from(home).join(".claude").join(".credentials.json"))
}

pub(crate) fn plan_label(subscription: Option<&str>, tier: Option<&str>) -> Option<String> {
    let tier = tier.unwrap_or_default();
    for (key, label) in [("max_20x", "Max 20x"), ("max_5x", "Max 5x")] {
        if tier.contains(key) { return Some(label.into()); }
    }
    let name = subscription.filter(|value| !value.is_empty())?;
    let mut chars = name.chars();
    Some(chars.next().map(|first| first.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default())
}

fn millis(value: Option<&Value>) -> Option<i64> {
    DateTime::parse_from_rfc3339(value?.as_str()?).ok().map(|time| time.timestamp_millis())
}

fn window(group: &str) -> Option<u32> {
    match group { "session" => Some(300), "weekly" => Some(10080), _ => None }
}

/// Lê a lista `limits`; respostas sem ela caem nos campos `five_hour`/`seven_day*`.
pub(crate) fn parse_usage(body: &str) -> Result<Vec<ClaudeLimit>, String> {
    let json: Value = serde_json::from_str(body).map_err(|_| "Resposta de uso inválida.".to_string())?;
    let mut limits = Vec::new();
    for item in json.get("limits").and_then(Value::as_array).into_iter().flatten() {
        let Some(percent) = item.get("percent").and_then(Value::as_f64) else { continue };
        let kind = item.get("kind").and_then(Value::as_str).unwrap_or("limit").to_string();
        let group = item.get("group").and_then(Value::as_str).unwrap_or(&kind).to_string();
        let model = item.pointer("/scope/model/display_name").and_then(Value::as_str);
        let label = match (group.as_str(), model) {
            ("session", _) => "Sessão".to_string(),
            ("weekly", Some(model)) => format!("Semana · {model}"),
            ("weekly", None) => "Semana".to_string(),
            (_, Some(model)) => model.to_string(),
            _ => kind.clone(),
        };
        limits.push(ClaudeLimit {
            window_minutes: window(&group), resets_at: millis(item.get("resets_at")),
            severity: item.get("severity").and_then(Value::as_str).unwrap_or("normal").to_string(),
            active: item.get("is_active").and_then(Value::as_bool).unwrap_or(false),
            kind, group, label, percent: percent.clamp(0.0, 100.0),
        });
    }
    if limits.is_empty() {
        for (key, group, label) in [("five_hour", "session", "Sessão"), ("seven_day", "weekly", "Semana"), ("seven_day_opus", "weekly", "Semana · Opus"), ("seven_day_sonnet", "weekly", "Semana · Sonnet")] {
            let Some(item) = json.get(key).filter(|value| value.is_object()) else { continue };
            let Some(percent) = item.get("utilization").and_then(Value::as_f64) else { continue };
            limits.push(ClaudeLimit { kind: key.into(), group: group.into(), label: label.into(), percent: percent.clamp(0.0, 100.0),
                severity: "normal".into(), resets_at: millis(item.get("resets_at")), window_minutes: window(group), active: false });
        }
    }
    if limits.is_empty() { return Err("A resposta não trouxe limites.".into()); }
    Ok(limits)
}

#[derive(Deserialize)]
struct TokenResponse { access_token: String, refresh_token: Option<String>, expires_in: i64, refresh_token_expires_in: Option<i64>, scope: Option<String> }

/// Aplica a resposta da renovação ao JSON do arquivo, mexendo só nos campos do token.
fn apply_refresh(credentials: &mut Value, response: &TokenResponse, now_ms: i64) -> Option<()> {
    let oauth = credentials.get_mut("claudeAiOauth")?.as_object_mut()?;
    oauth.insert("accessToken".into(), Value::from(response.access_token.clone()));
    if let Some(refresh) = &response.refresh_token { oauth.insert("refreshToken".into(), Value::from(refresh.clone())); }
    oauth.insert("expiresAt".into(), Value::from(now_ms + response.expires_in * 1000));
    if let Some(seconds) = response.refresh_token_expires_in { oauth.insert("refreshTokenExpiresAt".into(), Value::from(now_ms + seconds * 1000)); }
    if let Some(scope) = response.scope.as_deref().filter(|scope| !scope.trim().is_empty()) {
        oauth.insert("scopes".into(), Value::from(scope.split_whitespace().map(String::from).collect::<Vec<_>>()));
    }
    Some(())
}

enum Refresh { Done, Limited, Failed(String) }

fn refresh(path: &std::path::Path, client: &reqwest::blocking::Client, used: &str, scopes: &[String], now_ms: i64) -> Refresh {
    let Ok(_guard) = REFRESHING.lock() else { return Refresh::Failed("Renovação indisponível.".into()) };
    // Outro processo (o CLI ou outra consulta) pode ter renovado enquanto esperávamos.
    let read = || std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let Some(current) = read() else { return Refresh::Failed("Credenciais do Claude Code ilegíveis.".into()) };
    let token = |json: &Value, key: &str| json.pointer(&format!("/claudeAiOauth/{key}")).and_then(Value::as_str).map(String::from);
    if token(&current, "refreshToken").as_deref() != Some(used) { return Refresh::Done; }
    let mut body = serde_json::json!({ "grant_type": "refresh_token", "refresh_token": used, "client_id": CLIENT_ID });
    if !scopes.is_empty() { body["scope"] = Value::from(scopes.join(" ")); }
    let response = match client.post(TOKEN_URL).json(&body).send() {
        Ok(response) if response.status().as_u16() == 429 => return Refresh::Limited,
        Ok(response) if response.status().is_success() => response,
        Ok(_) => return Refresh::Failed("O login do Claude Code não pôde ser renovado; rode claude no terminal.".into()),
        Err(_) => return Refresh::Failed("Sem conexão com a Anthropic.".into()),
    };
    let Ok(tokens) = response.json::<TokenResponse>() else { return Refresh::Failed("Resposta de renovação inválida.".into()) };
    // Relê antes de gravar: se o arquivo mudou no meio, o dele prevalece.
    let Some(mut latest) = read() else { return Refresh::Failed("Credenciais do Claude Code ilegíveis.".into()) };
    if token(&latest, "refreshToken").as_deref() != Some(used) { return Refresh::Done; }
    if apply_refresh(&mut latest, &tokens, now_ms).is_none() { return Refresh::Failed("Credenciais do Claude Code sem login.".into()) }
    let Ok(bytes) = serde_json::to_vec(&latest) else { return Refresh::Failed("Não foi possível gravar o login renovado.".into()) };
    match crate::settings::atomic_write(path, &bytes) {
        Ok(()) => Refresh::Done,
        Err(_) => Refresh::Failed("Não foi possível gravar o login renovado.".into()),
    }
}

enum Fetch { Ok(Vec<ClaudeLimit>, Option<String>), Failed(String, bool) }

fn read_oauth(path: &std::path::Path) -> Result<OAuth, String> {
    let bytes = std::fs::read(path).map_err(|_| "Faça login no Claude Code para ver a cota.".to_string())?;
    serde_json::from_slice::<Credentials>(&bytes).ok().and_then(|value| value.claude_ai_oauth).ok_or_else(|| "Login do Claude Code não encontrado.".to_string())
}

fn fetch(now_ms: i64) -> Fetch {
    let Some(path) = credentials_path() else { return Fetch::Failed("Pasta do Claude Code não encontrada.".into(), false) };
    let client = match reqwest::blocking::Client::builder().https_only(true).redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(15)).build() {
        Ok(client) => client, Err(_) => return Fetch::Failed("Não foi possível consultar a cota.".into(), false),
    };
    let mut oauth = match read_oauth(&path) { Ok(oauth) => oauth, Err(reason) => return Fetch::Failed(reason, false) };
    let plan = plan_label(oauth.subscription_type.as_deref(), oauth.rate_limit_tier.as_deref());
    // Vencido (ou perto) renova primeiro; 401 numa consulta renova uma vez e repete.
    let mut refreshed = false;
    for attempt in 0..2 {
        let expired = oauth.expires_at.is_some_and(|expires| expires <= now_ms + REFRESH_MARGIN_MS);
        if expired || attempt == 1 {
            let Some(used) = oauth.refresh_token.clone() else { return Fetch::Failed("Login do Claude Code expirou; rode claude no terminal.".into(), false) };
            match refresh(&path, &client, &used, &oauth.scopes, now_ms) {
                Refresh::Done => {}
                Refresh::Limited => return Fetch::Failed("Renovação do login limitada; tentando mais tarde.".into(), true),
                Refresh::Failed(reason) => return Fetch::Failed(reason, false),
            }
            refreshed = true;
            oauth = match read_oauth(&path) { Ok(oauth) => oauth, Err(reason) => return Fetch::Failed(reason, false) };
        }
        let response = client.get(ENDPOINT).bearer_auth(&oauth.access_token).header("anthropic-beta", "oauth-2025-04-20").header("User-Agent", "heydesk").send();
        match response {
            Ok(response) if response.status().is_success() => return match response.text().map_err(|_| "Resposta de uso inválida.".to_string()).and_then(|body| parse_usage(&body)) {
                Ok(limits) => Fetch::Ok(limits, plan),
                Err(reason) => Fetch::Failed(reason, false),
            },
            Ok(response) if response.status().as_u16() == 401 && !refreshed => continue,
            Ok(response) if response.status().as_u16() == 401 => return Fetch::Failed("O login do Claude Code não pôde ser renovado; rode claude no terminal.".into(), false),
            Ok(response) if response.status().as_u16() == 429 => return Fetch::Failed("Consulta de cota limitada; tentando mais tarde.".into(), true),
            Ok(_) | Err(_) => return Fetch::Failed("Sem conexão com a Anthropic.".into(), false),
        }
    }
    Fetch::Failed("Não foi possível consultar a cota.".into(), false)
}

struct State { enabled: bool, stopped: bool, wake: u64, snapshot: ClaudeQuotaSnapshot }
pub struct ClaudeMonitor { shared: Arc<(Mutex<State>, Condvar)> }

impl ClaudeMonitor {
    pub fn start(enabled: bool) -> Self {
        let shared = Arc::new((Mutex::new(State { enabled, stopped: false, wake: 0, snapshot: ClaudeQuotaSnapshot::empty(enabled) }), Condvar::new()));
        let worker = shared.clone();
        thread::spawn(move || run(worker));
        Self { shared }
    }
    pub fn snapshot(&self) -> ClaudeQuotaSnapshot { self.shared.0.lock().map(|state| state.snapshot.clone()).unwrap_or_else(|_| ClaudeQuotaSnapshot::empty(false)) }
    pub fn set_enabled(&self, enabled: bool) {
        if let Ok(mut state) = self.shared.0.lock() {
            if state.enabled == enabled { return; }
            state.enabled = enabled; state.wake += 1;
            state.snapshot = ClaudeQuotaSnapshot::empty(enabled);
        }
        self.shared.1.notify_all();
    }
}
impl Drop for ClaudeMonitor {
    fn drop(&mut self) { if let Ok(mut state) = self.shared.0.lock() { state.stopped = true; } self.shared.1.notify_all(); }
}

fn run(shared: Arc<(Mutex<State>, Condvar)>) {
    loop {
        let (enabled, wake) = match shared.0.lock() { Ok(state) if !state.stopped => (state.enabled, state.wake), _ => return };
        let mut delay = POLL;
        if enabled {
            let now = chrono::Utc::now().timestamp_millis();
            let result = fetch(now);
            let Ok(mut state) = shared.0.lock() else { return };
            if state.wake != wake || !state.enabled { continue; }
            match result {
                Fetch::Ok(limits, plan) => state.snapshot = ClaudeQuotaSnapshot { enabled: true, state: "available".into(), plan, observed_at: Some(now), limits, reason: None },
                Fetch::Failed(reason, limited) => {
                    if limited { delay = BACKOFF; }
                    let previous = &state.snapshot;
                    state.snapshot = ClaudeQuotaSnapshot { enabled: true, state: if previous.limits.is_empty() { "unavailable" } else { "stale" }.into(),
                        plan: previous.plan.clone(), observed_at: previous.observed_at, limits: previous.limits.clone(), reason: Some(reason) };
                }
            }
        }
        let deadline = Instant::now() + delay;
        let Ok(mut state) = shared.0.lock() else { return };
        while !state.stopped && state.wake == wake {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() { break; }
            state = match shared.1.wait_timeout(state, left) { Ok((guard, _)) => guard, Err(_) => return };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const SAMPLE: &str = r#"{"five_hour":{"utilization":10.0,"resets_at":"2026-10-29T10:59:59.882588+00:00"},"seven_day":null,
      "limits":[{"kind":"session","group":"session","percent":10,"severity":"normal","resets_at":"2026-10-29T10:59:59.882588+00:00","scope":null,"is_active":false},
      {"kind":"weekly_scoped","group":"weekly","percent":93,"severity":"critical","resets_at":"2026-10-31T02:59:59.882814+00:00","scope":{"model":{"id":null,"display_name":"Fable"},"surface":null},"is_active":true}]}"#;

    #[test]
    fn parses_limits_with_labels_windows_and_reset() {
        let limits = parse_usage(SAMPLE).unwrap();
        assert_eq!(limits.len(), 2);
        assert_eq!((limits[0].label.as_str(), limits[0].percent, limits[0].window_minutes), ("Sessão", 10.0, Some(300)));
        assert_eq!((limits[1].label.as_str(), limits[1].severity.as_str(), limits[1].active), ("Semana · Fable", "critical", true));
        assert_eq!(limits[0].resets_at, Some(DateTime::parse_from_rfc3339("2026-10-29T10:59:59.882588+00:00").unwrap().timestamp_millis()));
    }

    #[test]
    fn falls_back_to_legacy_fields_and_rejects_empty() {
        let limits = parse_usage(r#"{"five_hour":{"utilization":42.5,"resets_at":null},"seven_day":{"utilization":120,"resets_at":"2026-11-01T00:00:00Z"}}"#).unwrap();
        assert_eq!(limits.iter().map(|limit| (limit.label.as_str(), limit.percent)).collect::<Vec<_>>(), [("Sessão", 42.5), ("Semana", 100.0)]);
        assert!(parse_usage(r#"{"five_hour":null,"limits":[]}"#).is_err());
        assert!(parse_usage("not json").is_err());
    }

    #[test]
    fn refresh_updates_only_token_fields() {
        let mut credentials = serde_json::json!({ "mcpOAuth": { "x": 1 }, "trustedDeviceToken": "keep",
            "claudeAiOauth": { "accessToken": "old", "refreshToken": "r1", "expiresAt": 1, "scopes": ["a"], "subscriptionType": "team", "rateLimitTier": "t" } });
        let response = TokenResponse { access_token: "new".into(), refresh_token: Some("r2".into()), expires_in: 3600, refresh_token_expires_in: Some(60), scope: Some("user:inference user:profile".into()) };
        apply_refresh(&mut credentials, &response, 1_000).unwrap();
        let oauth = &credentials["claudeAiOauth"];
        assert_eq!((oauth["accessToken"].as_str(), oauth["refreshToken"].as_str(), oauth["expiresAt"].as_i64(), oauth["refreshTokenExpiresAt"].as_i64()), (Some("new"), Some("r2"), Some(3_601_000), Some(61_000)));
        assert_eq!(oauth["scopes"], serde_json::json!(["user:inference", "user:profile"]));
        assert_eq!((oauth["subscriptionType"].as_str(), credentials["trustedDeviceToken"].as_str(), credentials["mcpOAuth"]["x"].as_i64()), (Some("team"), Some("keep"), Some(1)));
        let keep = TokenResponse { access_token: "n2".into(), refresh_token: None, expires_in: 10, refresh_token_expires_in: None, scope: None };
        apply_refresh(&mut credentials, &keep, 0).unwrap();
        assert_eq!(credentials["claudeAiOauth"]["refreshToken"].as_str(), Some("r2"), "sem refresh_token novo, mantém o atual");
    }

    #[test]
    fn plan_prefers_rate_tier() {
        assert_eq!(plan_label(Some("team"), Some("default_claude_max_5x")).as_deref(), Some("Max 5x"));
        assert_eq!(plan_label(Some("pro"), None).as_deref(), Some("Pro"));
        assert_eq!(plan_label(None, None), None);
    }
}
