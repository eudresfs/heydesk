// CS2 pelo HLTV (o usuário liberou a fonte em 2026-10-30): agenda, placar ao vivo e,
// no jogo acompanhado, lado TR/CT e como cada round acabou — nenhuma API gratuita dá isso.
// Duas janelas ocultas, só com "Counter-Strike 2" escolhido em Esportes:
// - "hltv": a lista de partidas (ao vivo e próximas). Recarrega a cada 10 min; entre uma
//   carga e outra só lê o que a própria página recebe ao vivo.
// - "hltv-match": a página da partida de time seguido (ou acompanhada) ao vivo, para os rounds.
// Nenhum desafio do Cloudflare é resolvido: apareceu, as janelas fecham e o HLTV fica
// de lado por 30 min.
use crate::sports::{Game, MapInfo, Side, TeamOption};
use serde::{Deserialize, Serialize};
use std::{sync::Mutex, time::{Duration, Instant}};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LEAGUE: &str = "hltv:cs2";
const LIST: &str = "hltv";
const MATCH: &str = "hltv-match";
pub const LIVE_EVENT: &str = "hltv:live";
/// Situação do jogo acompanhado: "searching" | "live" | "blocked".
pub const STATUS_EVENT: &str = "hltv:status";
const LIST_URL: &str = "https://www.hltv.org/matches";
const RELOAD: Duration = Duration::from_secs(10 * 60);
const BACKOFF: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoundResult { pub round: u32, pub winner: String, pub reason: String, #[serde(default)] pub team: String }

/// Placar ao vivo de um mapa: quem está de CT/TR, placar e os rounds já jogados.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveRounds {
    #[serde(default)] pub game_id: String,
    pub map: String, pub round: u32,
    pub ct_team: String, pub t_team: String, pub ct_score: u32, pub t_score: u32,
    #[serde(default)] pub phase: String,
    #[serde(default)] pub history: Vec<RoundResult>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListedTeam { pub id: String, pub name: String, #[serde(default)] pub logo: Option<String>, #[serde(default)] pub score: Option<u32>, #[serde(default)] pub maps: Option<u32> }

/// Uma partida da lista do HLTV.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListedMatch {
    pub id: String, #[serde(default)] pub event: String, #[serde(default)] pub start: Option<i64>,
    #[serde(default)] pub live: bool, #[serde(default)] pub format: String, pub team1: ListedTeam, pub team2: ListedTeam,
}

/// O que as páginas do HLTV mandam pelas janelas ocultas.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Report { Schedule { matches: Vec<ListedMatch> }, Score { score: LiveRounds }, Blocked, Over }

#[derive(Default)]
struct State { schedule: Vec<Game>, loaded_at: Option<Instant>, game: Option<String>, last: Option<LiveRounds>, blocked_until: Option<Instant> }

#[derive(Default)]
pub struct Hltv { state: Mutex<State>, pinned: Mutex<Option<String>>, status: Mutex<Option<serde_json::Value>> }

/// Agenda do HLTV como jogos do módulo de esportes (lido pela thread de esportes).
static SCHEDULE: Mutex<Option<Vec<Game>>> = Mutex::new(None);
pub fn schedule() -> Result<Vec<Game>, String> {
    SCHEDULE.lock().ok().and_then(|games| games.clone()).ok_or_else(|| "Carregando partidas do HLTV…".to_string())
}
/// Times que aparecem na agenda (para seguir).
pub fn teams() -> Result<Vec<TeamOption>, String> {
    let games = schedule()?;
    let mut teams: Vec<TeamOption> = Vec::new();
    for side in games.iter().flat_map(|game| [&game.home, &game.away]) {
        if !side.id.is_empty() && !teams.iter().any(|team| team.id == side.id) { teams.push(TeamOption { id: side.id.clone(), name: side.name.clone(), logo: side.logo.clone() }); }
    }
    teams.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(teams)
}

/// Sigla curta para o notch: o nome se couber, senão as iniciais ou as 4 primeiras letras.
fn short(name: &str) -> String {
    if name.chars().count() <= 5 { return name.to_uppercase(); }
    let words: Vec<&str> = name.split_whitespace().collect();
    if words.len() > 1 { words.iter().filter_map(|word| word.chars().next()).take(4).collect::<String>().to_uppercase() } else { name.chars().take(4).collect::<String>().to_uppercase() }
}

/// Partida da lista do HLTV → jogo do Heydesk. Mapas: os já decididos, o ao vivo e os que faltam.
pub(crate) fn to_game(item: &ListedMatch) -> Game {
    let side = |team: &ListedTeam| Side { id: team.id.clone(), name: team.name.clone(), short: short(&team.name), logo: team.logo.clone(), score: if item.live { Some(team.maps.unwrap_or(0).to_string()) } else { None } };
    let total: u32 = item.format.trim_start_matches("bo").parse().unwrap_or(1);
    let decided = item.team1.maps.unwrap_or(0) + item.team2.maps.unwrap_or(0);
    let maps = if !item.live || total < 2 { Vec::new() } else {
        (0..total).map(|index| if index < decided { MapInfo { name: None, result: "done".into(), home_rounds: None, away_rounds: None } }
            else if index == decided { MapInfo { name: None, result: "live".into(), home_rounds: item.team1.score.map(i64::from), away_rounds: item.team2.score.map(i64::from) } }
            else { MapInfo { name: None, result: "pending".into(), home_rounds: None, away_rounds: None } }).collect()
    };
    Game {
        id: format!("{LEAGUE}|{}", item.id), league: LEAGUE.into(), league_name: if item.event.is_empty() { "Counter-Strike 2".into() } else { item.event.clone() },
        start: item.start.unwrap_or_else(|| chrono::Utc::now().timestamp_millis()), state: if item.live { "in".into() } else { "pre".into() },
        detail: item.format.to_uppercase().replace("BO", "MD"), clock: item.live.then(|| match (item.team1.score, item.team2.score) { (Some(a), Some(b)) => format!("{a}–{b}"), _ => "ao vivo".into() }),
        home: side(&item.team1), away: side(&item.team2), followed: false, maps,
    }
}

impl Hltv {
    pub fn pin(&self, id: Option<String>) { if let Ok(mut pinned) = self.pinned.lock() { *pinned = id; } }
    fn pinned(&self) -> Option<String> { self.pinned.lock().ok().and_then(|pinned| pinned.clone()) }
    pub fn status(&self) -> Option<serde_json::Value> { self.status.lock().ok().and_then(|status| status.clone()) }
    pub fn current(&self) -> Option<LiveRounds> { self.state.lock().ok().and_then(|state| state.last.clone()) }

    /// A cada 20 s: mantém a lista aberta se CS2 estiver escolhido e a página da partida
    /// acompanhada ao vivo aberta enquanto ela durar.
    fn tick(&self, app: &AppHandle, enabled: bool, live: Option<String>) {
        let Ok(mut state) = self.state.lock() else { return };
        if state.blocked_until.is_some_and(|until| Instant::now() < until) { return; }
        if !enabled {
            close(app, LIST); close(app, MATCH);
            state.loaded_at = None; state.game = None; state.last = None;
            if let Ok(mut schedule) = SCHEDULE.lock() { *schedule = None; }
            return;
        }
        // Lista: abre ou recarrega a cada 10 min (jogos novos, horários).
        let stale = state.loaded_at.is_none_or(|at| at.elapsed() >= RELOAD);
        if app.get_webview_window(LIST).is_none() || stale {
            state.loaded_at = Some(Instant::now());
            match app.get_webview_window(LIST) { Some(window) => { if let Ok(url) = LIST_URL.parse() { let _ = window.navigate(url); } } None => open(app, LIST, LIST_URL) }
        }
        // Partida acompanhada: página própria para os rounds.
        match live {
            None => if state.game.take().is_some() { close(app, MATCH); state.last = None; let _ = app.emit(LIVE_EVENT, Option::<LiveRounds>::None); },
            Some(game) => {
                if state.game.as_deref() == Some(game.as_str()) && app.get_webview_window(MATCH).is_some() { return; }
                let id = game.rsplit('|').next().unwrap_or_default().to_string();
                status(app, &game, "searching");
                state.game = Some(game); state.last = None;
                close(app, MATCH);
                open(app, MATCH, &format!("https://www.hltv.org/matches/{id}/-"));
            }
        }
    }

    /// Relato vindo das páginas (agenda, placar, desafio, fim).
    pub fn report(&self, app: &AppHandle, report: Report) {
        let Ok(mut state) = self.state.lock() else { return };
        match report {
            Report::Schedule { matches } => {
                let games: Vec<Game> = matches.iter().filter(|item| !item.id.is_empty() && !item.team1.name.is_empty() && !item.team2.name.is_empty()).map(to_game).collect();
                state.schedule = games.clone();
                if let Ok(mut schedule) = SCHEDULE.lock() { *schedule = Some(games.clone()); }
                if let Some(sports) = app.try_state::<crate::sports::Sports>() { sports.merge(LEAGUE, games); }
            }
            Report::Score { mut score } => {
                let Some(game_id) = state.game.clone() else { return };
                if state.last.is_none() { status(app, &game_id, "live"); }
                score.game_id = game_id;
                if state.last.as_ref() != Some(&score) { state.last = Some(score.clone()); let _ = app.emit(LIVE_EVENT, Some(score)); }
            }
            Report::Blocked => {
                eprintln!("[Heydesk] HLTV pediu verificação; pausado por 30 min.");
                state.blocked_until = Some(Instant::now() + BACKOFF);
                if let Some(game) = state.game.take() { status(app, &game, "blocked"); }
                state.last = None; state.loaded_at = None;
                close(app, LIST); close(app, MATCH);
                let _ = app.emit(LIVE_EVENT, Option::<LiveRounds>::None);
            }
            Report::Over => { close(app, MATCH); }
        }
    }
}

/// Segue, a cada 20 s, a escolha de CS2 em Esportes e o jogo acompanhado ao vivo.
pub fn watch(app: AppHandle) {
    let _ = std::thread::Builder::new().name("heydesk-hltv".into()).spawn(move || loop {
        // Esportes pode ainda não estar registrado no início: espera a próxima volta.
        let (Some(hltv), Some(sports)) = (app.try_state::<Hltv>(), app.try_state::<crate::sports::Sports>()) else { std::thread::sleep(Duration::from_secs(2)); continue; };
        let enabled = sports.config().leagues.iter().any(|league| league == LEAGUE);
        let pinned = hltv.pinned();
        let live = sports.snapshot().games.into_iter()
            .find(|game| game.league == LEAGUE && game.state == "in" && (game.followed || pinned.as_deref() == Some(game.id.as_str())))
            .map(|game| game.id);
        hltv.tick(&app, enabled, live);
        std::thread::sleep(Duration::from_secs(20));
    });
}

/// Avisa a interface e guarda o último estado (quem abrir depois também vê).
fn status(app: &AppHandle, game_id: &str, state: &str) {
    let value = serde_json::json!({ "gameId": game_id, "state": state });
    if let Some(hltv) = app.try_state::<Hltv>() { if let Ok(mut last) = hltv.status.lock() { *last = Some(value.clone()); } }
    let _ = app.emit(STATUS_EVENT, value);
}

fn close(app: &AppHandle, label: &str) { if let Some(window) = app.get_webview_window(label) { let _ = window.destroy(); } }

fn open(app: &AppHandle, label: &'static str, url: &str) {
    let Ok(parsed) = url.parse() else { return };
    let app = app.clone();
    // Criar janela fora da thread de quem chamou (evita travar a thread principal no Windows).
    tauri::async_runtime::spawn(async move {
        let built = WebviewWindowBuilder::new(&app, label, WebviewUrl::External(parsed))
            .title("HLTV").visible(false).skip_taskbar(true).focused(false).inner_size(1100.0, 900.0)
            .initialization_script(SCRIPT)
            .build();
        if let Err(error) = built { eprintln!("[Heydesk] Janela do HLTV: {error}"); }
    });
}

/// Roda em cada página do HLTV nas janelas ocultas. Só lê o DOM e relata; não clica,
/// não navega e não toca em desafios.
const SCRIPT: &str = r##"
(() => {
  if (location.hostname !== "www.hltv.org") return;
  const report = data => { try { window.__TAURI_INTERNALS__.invoke("hltv_report", { report: data }); } catch (e) {} };
  const challenged = () => /just a moment|attention required|verify you are human/i.test(document.title) || !!document.querySelector("#challenge-form, #cf-challenge-running, .cf-turnstile");
  // O ícone diz o lado vencedor (desarme e tempo só CT; explosão só TR) e o motivo.
  const icons = { bomb_exploded: ["T", "bomb"], bomb_defused: ["CT", "defuse"], ct_win: ["CT", "elimination"], t_win: ["T", "elimination"], stopwatch: ["CT", "time"], time: ["CT", "time"] };
  const iconOf = src => icons[(src || "").split("/").pop().replace(/\.(svg|png)$/, "")] || null;
  const absolute = src => !src ? null : src.startsWith("http") ? src : "https://www.hltv.org" + src;
  const team = (wrapper, index) => {
    const node = wrapper.querySelectorAll(".match-teams .match-team")[index];
    const logos = node ? [...node.querySelectorAll(".match-team-logo")] : [];
    const logo = (logos.find(img => img.classList.contains("night-only")) || logos[0])?.getAttribute("src");
    const scores = wrapper.querySelectorAll(".match-team-score")[index];
    const number = sel => { const text = scores?.querySelector(sel)?.textContent.replace(/[()]/g, "").trim(); return text ? parseInt(text) : null; };
    return { id: wrapper.getAttribute(index ? "team2" : "team1") || "", name: node?.querySelector(".match-teamname")?.textContent.trim() || "", logo: absolute(logo), score: number(".current-map-score"), maps: number(".map-score") };
  };
  const schedule = () => {
    const matches = [...document.querySelectorAll(".match-wrapper[data-match-id]")].map(w => ({
      id: w.dataset.matchId, live: w.getAttribute("live") === "true",
      event: w.querySelector(".match-event")?.dataset.eventHeadline || w.closest(".matches-event-wrapper")?.querySelector(".event-headline-wrapper")?.dataset.eventHeadline || "",
      start: parseInt(w.querySelector(".match-time[data-unix]")?.dataset.unix) || null,
      format: [...w.querySelectorAll(".match-meta")].map(e => e.textContent.trim().toLowerCase()).find(text => /^bo\d$/.test(text)) || "bo1",
      team1: team(w, 0), team2: team(w, 1),
    }));
    const seen = new Set();
    report({ kind: "schedule", matches: matches.filter(m => !seen.has(m.id) && seen.add(m.id)) });
  };
  const score = () => {
    const root = document.querySelector("#scoreboardElement");
    if (!root) { if (/match over/i.test(document.body.innerText.slice(0, 4000))) report({ kind: "over" }); return; }
    const text = sel => root.querySelector(sel)?.textContent.trim() || "";
    const roundText = text(".currentRoundText");
    const history = [];
    // Cada linha é de um time (o que está de CT/TR agora); depois do intervalo os lados trocam.
    const ctNow = text(".ctTeamHeaderBg .teamName"), tNow = text(".tTeamHeaderBg .teamName");
    root.querySelectorAll(".roundHistory .roundHistoryLine").forEach(line => {
      const team = line.classList.contains("roundHistoryLineSideCT") ? ctNow : tNow;
      const half = line.closest(".secondHalf") ? 1 : 0;
      [...line.children].forEach((cell, index) => {
        const src = (cell.tagName === "IMG" ? cell : cell.querySelector("img"))?.getAttribute("src") || "";
        const icon = !src || /emptyHistory/i.test(src) ? null : iconOf(src);
        if (!icon) return;
        history.push({ round: half * 12 + index + 1, winner: icon[0], reason: icon[1], team });
      });
    });
    history.sort((a, b) => a.round - b.round);
    report({ kind: "score", score: {
      map: (roundText.split("-")[1] || "").trim(), round: parseInt(roundText) || 0,
      ctTeam: text(".ctTeamHeaderBg .teamName"), tTeam: text(".tTeamHeaderBg .teamName"),
      ctScore: parseInt(text(".ctScore")) || 0, tScore: parseInt(text(".tScore")) || 0,
      phase: text(".timeText"), history,
    } });
  };
  const tick = () => {
    if (challenged()) { report({ kind: "blocked" }); return; }
    if (location.pathname === "/matches") schedule();
    else if (/^\/matches\/\d+/.test(location.pathname)) score();
  };
  // Lista: relê a cada 30 s (placares ao vivo chegam pela própria página); partida: a cada 4 s.
  window.addEventListener("load", () => { setTimeout(tick, 2500); setInterval(tick, location.pathname === "/matches" ? 30000 : 4000); });
})();
"##;

#[cfg(test)]
mod tests {
    use super::*;
    fn listed(live: bool) -> ListedMatch {
        ListedMatch { id: "2399717".into(), event: "Stake Ranked".into(), start: Some(1_793_372_400_000), live, format: "bo3".into(),
            team1: ListedTeam { id: "9215".into(), name: "MIBR".into(), logo: Some("https://img-cdn.hltv.org/a.png".into()), score: Some(4), maps: Some(0) },
            team2: ListedTeam { id: "11251".into(), name: "Eternal Fire".into(), logo: None, score: Some(8), maps: Some(1) } }
    }
    #[test]
    fn schedule_items_become_games() {
        let game = to_game(&listed(true));
        assert_eq!((game.id.as_str(), game.state.as_str(), game.detail.as_str()), ("hltv:cs2|2399717", "in", "MD3"));
        assert_eq!((game.home.short.as_str(), game.away.short.as_str()), ("MIBR", "EF"));
        assert_eq!(game.away.score.as_deref(), Some("1"), "placar da série = mapas vencidos");
        assert_eq!(game.maps.iter().map(|map| map.result.as_str()).collect::<Vec<_>>(), ["done", "live", "pending"]);
        assert_eq!((game.maps[1].home_rounds, game.maps[1].away_rounds), (Some(4), Some(8)));
        let upcoming = to_game(&listed(false));
        assert_eq!((upcoming.state.as_str(), upcoming.start, upcoming.maps.len()), ("pre", 1_793_372_400_000, 0));
    }
    #[test]
    fn reads_page_reports() {
        let report: Report = serde_json::from_str(r#"{"kind":"score","score":{"map":"Inferno","round":5,"ctTeam":"MIBR","tTeam":"Eternal Fire","ctScore":3,"tScore":1,"phase":"0:45","history":[{"round":1,"winner":"CT","reason":"defuse"}]}}"#).unwrap();
        assert!(matches!(report, Report::Score { ref score } if score.ct_score == 3 && score.history[0].reason == "defuse"));
        assert!(matches!(serde_json::from_str::<Report>(r#"{"kind":"blocked"}"#).unwrap(), Report::Blocked));
        let schedule: Report = serde_json::from_str(r#"{"kind":"schedule","matches":[{"id":"1","live":false,"event":"X","start":null,"format":"bo1","team1":{"id":"1","name":"A","logo":null,"score":null,"maps":null},"team2":{"id":"2","name":"B","logo":null,"score":null,"maps":null}}]}"#).unwrap();
        assert!(matches!(schedule, Report::Schedule { ref matches } if matches.len() == 1));
    }
}
