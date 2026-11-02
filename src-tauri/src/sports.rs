// Esportes: agenda e placar ao vivo das competições e times escolhidos.
// Fontes grátis: ESPN (pública, sem chave) para esportes; PandaScore (conta
// grátis, chave do usuário) para Valorant, LoL e Dota; bo3.gg (API pública, sem
// chave) para CS2, com nome dos mapas e placar de rounds. Configuração e chave ficam em
// sports.json, só nesta máquina.
use chrono::{Duration as Days, Local};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{path::PathBuf, sync::{Arc, Condvar, Mutex}, thread, time::Duration};

const ESPN: &str = "https://site.api.espn.com/apis/site/v2/sports";
const PANDA: &str = "https://api.pandascore.co";
const BO3: &str = "https://api.bo3.gg/api/v1/matches";
const AHEAD_DAYS: i64 = 3;

/// Competições oferecidas. `id` = "espn:<esporte>/<liga>" ou "panda:<jogo>".
pub const CATALOG: &[(&str, &str, &str)] = &[
    ("espn:soccer/bra.1", "Brasileirão Série A", "Futebol"),
    ("espn:soccer/bra.2", "Brasileirão Série B", "Futebol"),
    ("espn:soccer/bra.copa_do_brazil", "Copa do Brasil", "Futebol"),
    ("espn:soccer/conmebol.libertadores", "Libertadores", "Futebol"),
    ("espn:soccer/conmebol.sudamericana", "Sul-Americana", "Futebol"),
    ("espn:soccer/uefa.champions", "Champions League", "Futebol"),
    ("espn:soccer/eng.1", "Premier League", "Futebol"),
    ("espn:soccer/esp.1", "LaLiga", "Futebol"),
    ("espn:soccer/ita.1", "Serie A (Itália)", "Futebol"),
    ("espn:soccer/ger.1", "Bundesliga", "Futebol"),
    ("espn:basketball/nba", "NBA", "Basquete"),
    ("espn:football/nfl", "NFL", "Futebol americano"),
    ("espn:baseball/mlb", "MLB", "Beisebol"),
    ("espn:hockey/nhl", "NHL", "Hóquei"),
    ("hltv:cs2", "Counter-Strike 2", "E-sports"),
    ("panda:valorant", "Valorant", "E-sports"),
    ("panda:lol", "League of Legends", "E-sports"),
    ("panda:dota2", "Dota 2", "E-sports"),
];

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SportsConfig {
    #[serde(default)]
    pub leagues: Vec<String>,
    /// "<liga>|<id do time>"; avisos e placar no notch só para estes.
    #[serde(default)]
    pub teams: Vec<String>,
    #[serde(default)]
    pub pandascore_token: Option<String>,
}

/// O que o frontend vê: a chave nunca volta, só se existe.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicConfig { pub leagues: Vec<String>, pub teams: Vec<String>, pub has_token: bool }

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Side { pub id: String, pub name: String, pub short: String, pub logo: Option<String>, pub score: Option<String> }

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Game {
    pub id: String,
    pub league: String,
    pub league_name: String,
    /// Época Unix em ms.
    pub start: i64,
    /// "pre" | "in" | "post"
    pub state: String,
    pub detail: String,
    pub clock: Option<String>,
    pub home: Side,
    pub away: Side,
    pub followed: bool,
    /// Série de e-sports: um item por mapa, na ordem jogada.
    #[serde(default)]
    pub maps: Vec<MapInfo>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MapInfo {
    pub name: Option<String>,
    /// "home" | "away" (venceu), "done" (encerrado sem vencedor informado), "live" ou "pending".
    pub result: String,
    pub home_rounds: Option<i64>,
    pub away_rounds: Option<i64>,
}

/// "de_dust2" → "Dust II"; nomes desconhecidos só perdem o prefixo.
pub(crate) fn map_label(raw: &str) -> String {
    let base = raw.trim_start_matches("de_").trim_start_matches("cs_");
    match base {
        "dust2" => "Dust II".into(),
        other => { let mut chars = other.chars(); chars.next().map(|first| first.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default() }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SportsSnapshot { pub games: Vec<Game>, pub observed_at: Option<i64>, pub errors: Vec<String> }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamOption { pub id: String, pub name: String, pub logo: Option<String> }

fn str_at<'a>(value: &'a Value, pointer: &str) -> Option<&'a str> { value.pointer(pointer).and_then(Value::as_str) }
fn millis(text: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(text).ok().map(|time| time.timestamp_millis())
        .or_else(|| chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%MZ").ok().map(|time| time.and_utc().timestamp_millis()))
}

pub(crate) fn parse_espn(league: &str, body: &str) -> Vec<Game> {
    let Ok(json) = serde_json::from_str::<Value>(body) else { return Vec::new() };
    let league_name = str_at(&json, "/leagues/0/name").unwrap_or(league).to_string();
    let mut games = Vec::new();
    for event in json.get("events").and_then(Value::as_array).into_iter().flatten() {
        let Some(competitors) = event.pointer("/competitions/0/competitors").and_then(Value::as_array) else { continue };
        let side = |home: bool| competitors.iter().find(|item| (str_at(item, "/homeAway") == Some("home")) == home).map(|item| Side {
            id: str_at(item, "/team/id").unwrap_or_default().to_string(),
            name: str_at(item, "/team/displayName").unwrap_or("?").to_string(),
            short: str_at(item, "/team/abbreviation").or_else(|| str_at(item, "/team/shortDisplayName")).unwrap_or("?").to_string(),
            logo: str_at(item, "/team/logo").map(String::from),
            score: str_at(item, "/score").map(String::from),
        });
        let (Some(home), Some(away)) = (side(true), side(false)) else { continue };
        let state = str_at(event, "/status/type/state").unwrap_or("pre").to_string();
        games.push(Game {
            id: format!("{league}|{}", str_at(event, "/id").unwrap_or_default()),
            league: league.to_string(), league_name: league_name.clone(),
            start: str_at(event, "/date").and_then(millis).unwrap_or_default(),
            detail: str_at(event, "/status/type/shortDetail").unwrap_or_default().to_string(),
            clock: (state == "in").then(|| str_at(event, "/status/displayClock").map(String::from)).flatten(),
            state, home, away, followed: false, maps: Vec::new(),
        });
    }
    games
}

pub(crate) fn parse_panda(league: &str, body: &str) -> Vec<Game> {
    let Ok(Value::Array(matches)) = serde_json::from_str::<Value>(body) else { return Vec::new() };
    matches.iter().filter_map(|item| {
        let opponents = item.get("opponents")?.as_array()?;
        if opponents.len() < 2 { return None; }
        let score = |team: &str| item.get("results")?.as_array()?.iter()
            .find(|result| result.get("team_id").and_then(Value::as_i64).map(|id| id.to_string()).as_deref() == Some(team))
            .and_then(|result| result.get("score")).and_then(Value::as_i64).map(|score| score.to_string());
        let side = |index: usize| {
            let team = opponents.get(index)?.get("opponent")?;
            let id = team.get("id")?.as_i64()?.to_string();
            Some(Side { score: score(&id), name: str_at(team, "/name").unwrap_or("?").to_string(),
                short: str_at(team, "/acronym").or_else(|| str_at(team, "/name")).unwrap_or("?").to_string(),
                logo: str_at(team, "/image_url").map(String::from), id })
        };
        let status = str_at(item, "/status").unwrap_or("not_started");
        let state = match status { "running" => "in", "finished" | "canceled" => "post", _ => "pre" };
        let total = item.get("number_of_games").and_then(Value::as_i64).unwrap_or(0).max(0) as usize;
        let series = if total > 0 { format!("MD{total}") } else { String::new() };
        let home_id = opponents.first().and_then(|entry| entry.pointer("/opponent/id")).and_then(Value::as_i64);
        let mut maps: Vec<MapInfo> = item.get("games").and_then(Value::as_array).into_iter().flatten().map(|game| {
            let result = match (str_at(game, "/status"), game.pointer("/winner/id").and_then(Value::as_i64)) {
                (Some("running"), _) => "live".to_string(),
                (_, Some(winner)) => if Some(winner) == home_id { "home".into() } else { "away".into() },
                _ => "pending".into(),
            };
            MapInfo { name: None, result, home_rounds: None, away_rounds: None }
        }).collect();
        maps.truncate(total.max(maps.len()));
        // Mapas que não serão jogados (série decidida) saem da sequência.
        let needed = total / 2 + 1;
        let won = |side: &str| maps.iter().filter(|map| map.result == side).count();
        if total > 0 && (won("home") >= needed || won("away") >= needed) { maps.retain(|map| map.result != "pending"); }
        Some(Game {
            id: format!("{league}|{}", item.get("id")?.as_i64()?), league: league.to_string(),
            league_name: [str_at(item, "/league/name"), str_at(item, "/serie/full_name")].into_iter().flatten().collect::<Vec<_>>().join(" · "),
            start: str_at(item, "/begin_at").or_else(|| str_at(item, "/scheduled_at")).and_then(millis).unwrap_or_default(),
            state: state.into(), detail: series,
            // O plano grátis não traz o nome do mapa; a sequência de mapas já mostra qual está em jogo.
            clock: None, home: side(0)?, away: side(1)?, followed: false, maps,
        })
    }).collect()
}

/// Partidas do bo3.gg (CS2): nome do mapa, rounds por mapa, série e logos.
pub(crate) fn parse_bo3(league: &str, body: &str) -> Vec<Game> {
    let Ok(json) = serde_json::from_str::<Value>(body) else { return Vec::new() };
    json.get("results").and_then(Value::as_array).into_iter().flatten().filter_map(|item| {
        let team = |key: &str, score: &str| {
            let data = item.get(key)?;
            let name = str_at(data, "/name")?.to_string();
            Some(Side { id: data.get("id")?.as_i64()?.to_string(), short: str_at(data, "/acronym").filter(|value| !value.is_empty()).map(String::from).unwrap_or_else(|| name.clone()),
                logo: str_at(data, "/image_url").map(String::from), score: item.get(score).and_then(Value::as_i64).map(|value| value.to_string()), name })
        };
        let (home, away) = (team("team1", "team1_score")?, team("team2", "team2_score")?);
        let state = match str_at(item, "/status") { Some("current") => "in", Some("finished") | Some("defwin") => "post", _ => "pre" };
        let mut games: Vec<&Value> = item.get("games").and_then(Value::as_array).into_iter().flatten().collect();
        games.sort_by_key(|game| game.get("number").and_then(Value::as_i64).unwrap_or(0));
        let maps: Vec<MapInfo> = games.iter().map(|game| {
            let name = str_at(game, "/map_name").filter(|value| !value.is_empty() && *value != "tba").map(map_label);
            match str_at(game, "/status") {
                Some("finished") => {
                    let winner = game.pointer("/winner_team_clan/team_id").and_then(Value::as_i64).map(|id| id.to_string());
                    let (high, low) = (game.get("winner_clan_score").and_then(Value::as_i64), game.get("loser_clan_score").and_then(Value::as_i64));
                    // Alguns torneios vêm sem o id do vencedor; o nome do clã resolve.
                    let clan = str_at(game, "/winner_clan_name").map(str::to_lowercase);
                    let home_won = match (winner, clan) {
                        (Some(id), _) => Some(id == home.id),
                        (None, Some(clan)) => Some(clan == home.name.to_lowercase() || clan == home.short.to_lowercase()),
                        // Torneios menores vêm sem vencedor: encerrado, sem chutar o lado.
                        (None, None) => None,
                    };
                    match home_won {
                        Some(home_won) => MapInfo { name, result: if home_won { "home" } else { "away" }.into(), home_rounds: if home_won { high } else { low }, away_rounds: if home_won { low } else { high } },
                        None => MapInfo { name, result: "done".into(), home_rounds: None, away_rounds: None },
                    }
                }
                Some("current") => MapInfo { name, result: "live".into(), home_rounds: None, away_rounds: None },
                _ => MapInfo { name, result: "pending".into(), home_rounds: None, away_rounds: None },
            }
        }).collect();
        let total = item.get("bo_type").and_then(Value::as_i64).unwrap_or(0);
        Some(Game {
            id: format!("{league}|{}", item.get("id")?.as_i64()?), league: league.to_string(),
            league_name: str_at(item, "/tournament/name").unwrap_or("Counter-Strike 2").to_string(),
            start: str_at(item, "/start_date").and_then(millis).unwrap_or_default(),
            detail: if total > 0 { format!("MD{total}") } else { String::new() },
            // No compacto e no selo: o nome do mapa em jogo, não o número.
            clock: maps.iter().find(|map| map.result == "live").and_then(|map| map.name.clone()),
            state: state.into(), home, away, followed: false, maps,
        })
    }).collect()
}

fn client() -> Option<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder().https_only(true).timeout(Duration::from_secs(12)).user_agent("Heydesk").build().ok()
}

fn fetch_league(client: &reqwest::blocking::Client, league: &str, token: Option<&str>, live_only: bool) -> Result<Vec<Game>, String> {
    // CS2: agenda lida da lista do HLTV pela janela oculta (ver hltv.rs).
    if league == crate::hltv::LEAGUE { return crate::hltv::schedule(); }
    if let Some(path) = league.strip_prefix("espn:") {
        let today = Local::now().date_naive();
        let days = if live_only { 0 } else { AHEAD_DAYS };
        let mut games = Vec::new();
        for offset in 0..=days {
            let date = (today + Days::days(offset)).format("%Y%m%d").to_string();
            let body = client.get(format!("{ESPN}/{path}/scoreboard")).query(&[("dates", date.as_str())]).send()
                .and_then(|response| response.error_for_status()).and_then(read_limited)
                .map_err(|_| "ESPN indisponível.".to_string())?;
            games.extend(parse_espn(league, &body));
        }
        // Nome em português do catálogo no lugar do nome em inglês da ESPN.
        if let Some((_, name, _)) = CATALOG.iter().find(|(id, _, _)| *id == league) { for game in &mut games { game.league_name = name.to_string(); } }
        return Ok(games);
    }
    if league.starts_with("bo3:") {
        let mut games = Vec::new();
        let until = (Local::now().date_naive() + Days::days(AHEAD_DAYS)).format("%Y-%m-%d").to_string();
        let mut queries: Vec<Vec<(&str, String)>> = vec![vec![("filter[matches.status][in]", "current".into())]];
        if !live_only { queries.push(vec![("filter[matches.status][in]", "upcoming".into()), ("filter[matches.start_date][lte]", until), ("sort", "start_date".into())]); }
        for mut query in queries {
            query.extend([("filter[matches.discipline_id][eq]", "1".to_string()), ("page[limit]", "50".to_string()), ("with", "teams,games,tournament".to_string())]);
            let body = client.get(BO3).query(&query).send().and_then(|response| response.error_for_status()).and_then(read_limited)
                .map_err(|_| "bo3.gg indisponível.".to_string())?;
            games.extend(parse_bo3(league, &body));
        }
        return Ok(games);
    }
    if let Some(game) = league.strip_prefix("panda:") {
        let token = token.ok_or("Cole a chave do PandaScore em Preferências → Esportes.")?;
        let mut games = Vec::new();
        for kind in if live_only { &["running"][..] } else { &["running", "upcoming"][..] } {
            let response = client.get(format!("{PANDA}/{game}/matches/{kind}")).bearer_auth(token).query(&[("per_page", "30")]).send()
                .map_err(|_| "PandaScore indisponível.".to_string())?;
            if response.status().as_u16() == 401 { return Err("Chave do PandaScore recusada.".into()); }
            if response.status().as_u16() == 429 { return Err("Limite grátis do PandaScore atingido por agora.".into()); }
            games.extend(parse_panda(league, &read_limited(response).map_err(|_| "Resposta do PandaScore inválida.".to_string())?));
        }
        return Ok(games);
    }
    Err("Competição desconhecida.".into())
}

pub fn league_teams(league: &str, token: Option<&str>) -> Result<Vec<TeamOption>, String> {
    // Só competições do catálogo (o id entra na URL das APIs, junto com a chave).
    if !CATALOG.iter().any(|(id, _, _)| *id == league) { return Err("Competição desconhecida.".into()); }
    if league == crate::hltv::LEAGUE { return crate::hltv::teams(); }
    let client = client().ok_or("Sem rede.")?;
    if let Some(path) = league.strip_prefix("espn:") {
        let body = client.get(format!("{ESPN}/{path}/teams")).send().and_then(read_limited).map_err(|_| "ESPN indisponível.".to_string())?;
        let json: Value = serde_json::from_str(&body).map_err(|_| "Resposta da ESPN inválida.".to_string())?;
        let mut teams: Vec<TeamOption> = json.pointer("/sports/0/leagues/0/teams").and_then(Value::as_array).into_iter().flatten().filter_map(|item| Some(TeamOption {
            id: str_at(item, "/team/id")?.to_string(), name: str_at(item, "/team/displayName")?.to_string(), logo: str_at(item, "/team/logos/0/href").map(String::from),
        })).collect();
        teams.sort_by(|a, b| a.name.cmp(&b.name));
        return Ok(teams);
    }
    // E-sports têm milhares de times: oferece os que jogam agora e nos próximos dias.
    let games = fetch_league(&client, league, token, false)?;
    let mut teams: Vec<TeamOption> = Vec::new();
    for side in games.iter().flat_map(|game| [&game.home, &game.away]) {
        if !teams.iter().any(|team| team.id == side.id) { teams.push(TeamOption { id: side.id.clone(), name: side.name.clone(), logo: side.logo.clone() }); }
    }
    teams.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(teams)
}

/// Marca jogos dos times seguidos e ordena: ao vivo, depois por horário.
pub(crate) fn arrange(mut games: Vec<Game>, teams: &[String]) -> Vec<Game> {
    for game in &mut games {
        game.followed = teams.iter().any(|team| *team == format!("{}|{}", game.league, game.home.id) || *team == format!("{}|{}", game.league, game.away.id));
    }
    games.sort_by_key(|game| (game.state != "in", game.state == "post", game.start));
    games.dedup_by(|a, b| a.id == b.id);
    games
}

struct State { config: SportsConfig, snapshot: SportsSnapshot, wake: u64, stopped: bool }
pub struct Sports { shared: Arc<(Mutex<State>, Condvar)>, path: PathBuf }

impl Sports {
    pub fn start(path: PathBuf) -> Self {
        let mut config: SportsConfig = std::fs::read(&path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
        // CS2 passou do PandaScore para o bo3.gg e depois para o HLTV: os ids de time mudam
        // (seguir de novo), a competição continua escolhida.
        if config.leagues.iter().any(|league| league == "panda:csgo" || league == "bo3:cs2") {
            config.leagues = config.leagues.iter().map(|league| if league == "panda:csgo" || league == "bo3:cs2" { crate::hltv::LEAGUE.to_string() } else { league.clone() }).collect();
            config.leagues.dedup();
            config.teams.retain(|team| !team.starts_with("panda:csgo|") && !team.starts_with("bo3:cs2|"));
            if let Ok(bytes) = serde_json::to_vec_pretty(&config) { let _ = crate::settings::atomic_write(&path, &bytes); }
        }
        let shared = Arc::new((Mutex::new(State { config, snapshot: SportsSnapshot::default(), wake: 0, stopped: false }), Condvar::new()));
        let worker = shared.clone();
        let _ = thread::Builder::new().name("heydesk-sports".into()).spawn(move || run(worker));
        Self { shared, path }
    }
    /// Troca os jogos de uma competição sem esperar a próxima busca (agenda do HLTV
    /// chega pela janela oculta, a qualquer momento).
    pub fn merge(&self, league: &str, fresh: Vec<Game>) {
        let Ok(mut state) = self.shared.0.lock() else { return };
        if !state.config.leagues.iter().any(|item| item == league) { return; }
        let mut games: Vec<Game> = state.snapshot.games.iter().filter(|game| game.league != league).cloned().collect();
        games.extend(fresh);
        let games = arrange(games, &state.config.teams);
        let errors = state.snapshot.errors.iter().filter(|error| !error.contains("HLTV")).cloned().collect();
        state.snapshot = SportsSnapshot { games, observed_at: Some(chrono::Utc::now().timestamp_millis()), errors };
    }
    pub fn snapshot(&self) -> SportsSnapshot { self.shared.0.lock().map(|state| state.snapshot.clone()).unwrap_or_default() }
    pub fn config(&self) -> PublicConfig {
        let config = self.shared.0.lock().map(|state| state.config.clone()).unwrap_or_default();
        PublicConfig { leagues: config.leagues, teams: config.teams, has_token: config.pandascore_token.is_some_and(|token| !token.is_empty()) }
    }
    pub fn token(&self) -> Option<String> { self.shared.0.lock().ok().and_then(|state| state.config.pandascore_token.clone()) }
    /// `token`: None mantém a atual; Some("") apaga.
    pub fn save(&self, leagues: Vec<String>, teams: Vec<String>, token: Option<String>) -> Result<PublicConfig, String> {
        if leagues.len() > 40 || teams.len() > 200 { return Err("Seleção grande demais.".into()); }
        if leagues.iter().any(|league| !CATALOG.iter().any(|(id, _, _)| id == league)) { return Err("Competição desconhecida.".into()); }
        if token.as_ref().is_some_and(|token| token.len() > 200 || token.chars().any(char::is_whitespace)) { return Err("Chave do PandaScore inválida.".into()); }
        let mut state = self.shared.0.lock().map_err(|_| "Esportes indisponíveis.".to_string())?;
        let mut config = SportsConfig { leagues, teams, pandascore_token: state.config.pandascore_token.clone() };
        if let Some(token) = token { config.pandascore_token = (!token.is_empty()).then_some(token); }
        let bytes = serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?;
        crate::settings::atomic_write(&self.path, &bytes).map_err(|error| format!("Não foi possível salvar: {error}"))?;
        state.config = config; state.wake += 1;
        drop(state);
        self.shared.1.notify_all();
        Ok(self.config())
    }
}
impl Drop for Sports {
    fn drop(&mut self) { if let Ok(mut state) = self.shared.0.lock() { state.stopped = true; } self.shared.1.notify_all(); }
}

// Agenda completa a cada 10 min; com jogo ao vivo, placar a cada 30 s.
fn run(shared: Arc<(Mutex<State>, Condvar)>) {
    let mut full_due = std::time::Instant::now();
    loop {
        let (config, wake) = match shared.0.lock() { Ok(state) if !state.stopped => (state.config.clone(), state.wake), _ => return };
        let full = std::time::Instant::now() >= full_due;
        let mut games = if full { Vec::new() } else { shared.0.lock().map(|state| state.snapshot.games.clone()).unwrap_or_default() };
        let mut errors = Vec::new();
        if let Some(client) = client() {
            let live_leagues: Vec<String> = games.iter().filter(|game| game.state == "in").map(|game| game.league.clone()).collect();
            for league in &config.leagues {
                if !full && !live_leagues.contains(league) { continue; }
                match fetch_league(&client, league, config.pandascore_token.as_deref(), !full) {
                    Ok(fresh) => {
                        if !full { games.retain(|game| !(game.league == *league && fresh.iter().any(|item| item.id == game.id)) && !(game.league == *league && game.state == "in")); }
                        games.extend(fresh);
                    }
                    Err(error) => if !errors.contains(&error) { errors.push(error) },
                }
            }
        }
        if full { full_due = std::time::Instant::now() + Duration::from_secs(600); }
        let games = arrange(games, &config.teams);
        let live = games.iter().any(|game| game.state == "in");
        let Ok(mut state) = shared.0.lock() else { return };
        if state.wake != wake { full_due = std::time::Instant::now(); continue; }
        state.snapshot = SportsSnapshot { games, observed_at: Some(chrono::Utc::now().timestamp_millis()), errors };
        let delay = if live { Duration::from_secs(30) } else { full_due.saturating_duration_since(std::time::Instant::now()).max(Duration::from_secs(30)) };
        let deadline = std::time::Instant::now() + delay;
        while !state.stopped && state.wake == wake {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() { break; }
            state = match shared.1.wait_timeout(state, left) { Ok((guard, _)) => guard, Err(_) => return };
        }
        if state.wake != wake { full_due = std::time::Instant::now(); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const ESPN_BODY: &str = r#"{"leagues":[{"name":"Brazilian Serie A"}],"events":[{"id":"77","date":"2026-10-30T23:00Z","status":{"displayClock":"67'","type":{"state":"in","shortDetail":"67'"}},
      "competitions":[{"competitors":[{"homeAway":"home","score":"2","team":{"id":"6154","displayName":"Atlético-MG","abbreviation":"CAM","logo":"https://a.espncdn.com/x.png"}},
      {"homeAway":"away","score":"1","team":{"id":"2022","displayName":"Cruzeiro","abbreviation":"CRU","logo":"https://a.espncdn.com/y.png"}}]}]}]}"#;
    const PANDA_BODY: &str = r#"[{"id":9,"status":"running","begin_at":"2026-10-29T18:00:00Z","number_of_games":3,"league":{"name":"BLAST"},"serie":{"full_name":"Fall 2026"},
      "opponents":[{"opponent":{"id":1,"name":"FURIA","acronym":"FUR","image_url":"https://cdn.pandascore.co/a.png"}},{"opponent":{"id":2,"name":"Team Vitality","acronym":"VIT","image_url":null}}],
      "results":[{"team_id":1,"score":1},{"team_id":2,"score":0}],
      "games":[{"position":1,"status":"finished","winner":{"id":1}},{"position":2,"status":"running","winner":{"id":null}},{"position":3,"status":"not_started","winner":{"id":null}}]}]"#;

    #[test]
    fn parses_espn_scoreboard_with_clock_and_logos() {
        let games = parse_espn("espn:soccer/bra.1", ESPN_BODY);
        assert_eq!(games.len(), 1);
        let game = &games[0];
        assert_eq!((game.state.as_str(), game.clock.as_deref(), game.home.short.as_str(), game.home.score.as_deref(), game.away.name.as_str()), ("in", Some("67'"), "CAM", Some("2"), "Cruzeiro"));
        assert_eq!(game.start, chrono::DateTime::parse_from_rfc3339("2026-10-30T23:00:00Z").unwrap().timestamp_millis());
    }

    #[test]
    fn parses_pandascore_series_score() {
        let games = parse_panda("panda:csgo", PANDA_BODY);
        assert_eq!(games.len(), 1);
        assert_eq!((games[0].state.as_str(), games[0].home.score.as_deref(), games[0].away.score.as_deref(), games[0].league_name.as_str(), games[0].detail.as_str()), ("in", Some("1"), Some("0"), "BLAST · Fall 2026", "MD3"));
        assert_eq!(games[0].maps.iter().map(|map| map.result.as_str()).collect::<Vec<_>>(), ["home", "live", "pending"]);
        assert_eq!(games[0].clock, None);
        assert_eq!(parse_panda("panda:csgo", "{\"error\":1}"), Vec::new());
    }

    const BO3_BODY: &str = r#"{"results":[{"id":5,"status":"current","start_date":"2026-10-29T16:00:00.000+00:00","bo_type":3,"team1_score":1,"team2_score":0,
      "team1":{"id":786,"name":"fnatic","acronym":null,"image_url":"https://files.bo3.gg/a.png"},"team2":{"id":755,"name":"MIBR","acronym":"MIBR","image_url":null},
      "tournament":{"name":"Stake Ranked"},
      "games":[{"number":2,"status":"current","map_name":"de_mirage"},{"number":1,"status":"finished","map_name":"de_dust2","winner_clan_score":13,"loser_clan_score":9,"winner_team_clan":{"team_id":786}},{"number":3,"status":"upcoming","map_name":"de_anubis"}]}]}"#;

    #[test]
    fn parses_bo3_maps_rounds_and_live_map_name() {
        let games = parse_bo3("bo3:cs2", BO3_BODY);
        let game = &games[0];
        assert_eq!((game.state.as_str(), game.league_name.as_str(), game.clock.as_deref(), game.home.short.as_str(), game.home.score.as_deref()), ("in", "Stake Ranked", Some("Mirage"), "fnatic", Some("1")));
        assert_eq!(game.maps[0], MapInfo { name: Some("Dust II".into()), result: "home".into(), home_rounds: Some(13), away_rounds: Some(9) });
        assert_eq!(game.maps.iter().map(|map| map.result.as_str()).collect::<Vec<_>>(), ["home", "live", "pending"]);
        assert_eq!(map_label("de_ancient"), "Ancient");
        let by_name = BO3_BODY.replace(r#""winner_team_clan":{"team_id":786}"#, r#""winner_clan_name":"MIBR""#);
        assert_eq!(parse_bo3("bo3:cs2", &by_name)[0].maps[0].result, "away", "sem id, o nome do clã decide");
        let unknown = BO3_BODY.replace(r#","winner_clan_score":13,"loser_clan_score":9,"winner_team_clan":{"team_id":786}"#, "");
        assert_eq!(parse_bo3("bo3:cs2", &unknown)[0].maps[0].result, "done");
    }

    #[test]
    fn arrange_marks_followed_teams_and_puts_live_first() {
        let mut games = parse_espn("espn:soccer/bra.1", ESPN_BODY);
        let mut later = games[0].clone(); later.id = "x|1".into(); later.state = "pre".into(); later.start += 1;
        games.insert(0, later);
        let arranged = arrange(games, &["espn:soccer/bra.1|2022".to_string()]);
        assert_eq!(arranged[0].state, "in");
        assert!(arranged.iter().all(|game| game.followed));
    }
}

/// Corpo da resposta com teto (5 MB): um servidor hostil ou quebrado não esgota a memória.
pub(crate) fn read_limited(response: reqwest::blocking::Response) -> reqwest::Result<String> {
    use std::io::Read;
    const MAX: u64 = 5 * 1024 * 1024;
    let mut bytes = Vec::new();
    let mut limited = response.take(MAX + 1);
    let _ = limited.read_to_end(&mut bytes);
    bytes.truncate(MAX as usize);
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
