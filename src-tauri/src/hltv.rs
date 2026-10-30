// CS2 ao vivo pelo HLTV (o usuário liberou a fonte em 2026-10-30). Nenhuma API
// gratuita dá lado TR/CT e como cada round acabou durante o jogo; a página da partida
// no HLTV dá. Uma janela oculta abre a lista ao vivo, acha a partida do time seguido
// e fica na página dela, lendo o placar que a própria página recebe (sem novos acessos).
// Limites combinados: só com jogo de CS2 de time seguido ao vivo, uma página por
// partida, e nenhum desafio do Cloudflare é resolvido: apareceu, a janela fecha e o
// HLTV fica de lado por 30 min (o placar segue pelo bo3.gg).
use serde::{Deserialize, Serialize};
use std::{sync::Mutex, time::{Duration, Instant}};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "hltv";
pub const LIVE_EVENT: &str = "hltv:live";
const LIST_URL: &str = "https://www.hltv.org/matches";
const BACKOFF: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoundResult { pub round: u32, pub winner: String, pub reason: String }

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

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedMatch { pub url: String, pub teams: Vec<String> }

/// O que a página do HLTV manda pela janela oculta.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Report { List { matches: Vec<ListedMatch> }, Score { score: LiveRounds }, Blocked, Over }

#[derive(Default)]
struct State { game: Option<(String, String, String)>, page: Option<String>, last: Option<LiveRounds>, blocked_until: Option<Instant> }

#[derive(Default)]
pub struct Hltv { state: Mutex<State>, pinned: Mutex<Option<String>> }

/// Nomes de time comparáveis entre bo3.gg e HLTV ("Natus Vincere" ~ "NAVI" não; "MIBR" ~ "mibr" sim).
pub(crate) fn same_team(a: &str, b: &str) -> bool {
    let clean = |text: &str| text.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect::<String>();
    let (a, b) = (clean(a), clean(b));
    !a.is_empty() && !b.is_empty() && (a == b || (a.len() >= 4 && b.contains(&a)) || (b.len() >= 4 && a.contains(&b)))
}

/// Partida da lista do HLTV com os dois times do jogo seguido.
pub(crate) fn find_match<'a>(matches: &'a [ListedMatch], home: &str, away: &str) -> Option<&'a ListedMatch> {
    matches.iter().find(|item| item.teams.len() >= 2
        && ((same_team(&item.teams[0], home) && same_team(&item.teams[1], away)) || (same_team(&item.teams[0], away) && same_team(&item.teams[1], home))))
}

impl Hltv {
    /// Chamado a cada atualização de esportes: abre/segue/fecha a janela conforme haja
    /// jogo de CS2 de time seguido ao vivo.
    pub fn follow(&self, app: &AppHandle, live: Option<(String, String, String)>) {
        let Ok(mut state) = self.state.lock() else { return };
        if state.blocked_until.is_some_and(|until| Instant::now() < until) { return; }
        match live {
            None => {
                if state.game.take().is_some() { close(app); state.page = None; state.last = None; let _ = app.emit(LIVE_EVENT, Option::<LiveRounds>::None); }
            }
            Some(game) => {
                if state.game.as_ref() == Some(&game) && app.get_webview_window(LABEL).is_some() { return; }
                state.game = Some(game); state.page = None; state.last = None;
                close(app);
                open(app, LIST_URL);
            }
        }
    }

    /// Relato vindo da página (lista ao vivo, placar, desafio ou fim).
    pub fn report(&self, app: &AppHandle, report: Report) {
        let Ok(mut state) = self.state.lock() else { return };
        let Some((game_id, home, away)) = state.game.clone() else { return };
        match report {
            Report::List { matches } => {
                if state.page.is_some() { return; }
                match find_match(&matches, &home, &away) {
                    Some(item) if item.url.starts_with("/matches/") => {
                        let url = format!("https://www.hltv.org{}", item.url);
                        state.page = Some(url.clone());
                        if let Some(window) = app.get_webview_window(LABEL) { if let Ok(parsed) = url.parse() { let _ = window.navigate(parsed); } }
                    }
                    // Partida não está no HLTV (ou nome diferente): não insiste até o próximo jogo.
                    _ => { close(app); }
                }
            }
            Report::Score { mut score } => {
                score.game_id = game_id;
                if state.last.as_ref() != Some(&score) { state.last = Some(score.clone()); let _ = app.emit(LIVE_EVENT, Some(score)); }
            }
            Report::Blocked => {
                eprintln!("[Heydesk] HLTV pediu verificação; pausado por 30 min.");
                state.blocked_until = Some(Instant::now() + BACKOFF);
                state.game = None; state.page = None; state.last = None;
                close(app);
                let _ = app.emit(LIVE_EVENT, Option::<LiveRounds>::None);
            }
            Report::Over => { close(app); state.page = None; }
        }
    }

    pub fn current(&self) -> Option<LiveRounds> { self.state.lock().ok().and_then(|state| state.last.clone()) }
    /// Jogo acompanhado no notch (alfinete): vale como time seguido para o HLTV.
    pub fn pin(&self, id: Option<String>) { if let Ok(mut pinned) = self.pinned.lock() { *pinned = id; } }
    fn pinned(&self) -> Option<String> { self.pinned.lock().ok().and_then(|pinned| pinned.clone()) }
}

/// Segue, a cada 20 s, o jogo de CS2 de time seguido que estiver ao vivo.
pub fn watch(app: AppHandle) {
    let _ = std::thread::Builder::new().name("heydesk-hltv".into()).spawn(move || loop {
        let pinned = app.state::<Hltv>().pinned();
        let live = app.state::<crate::sports::Sports>().snapshot().games.into_iter()
            .find(|game| game.league == "bo3:cs2" && game.state == "in" && (game.followed || pinned.as_deref() == Some(game.id.as_str())))
            .map(|game| (game.id, game.home.name, game.away.name));
        app.state::<Hltv>().follow(&app, live);
        std::thread::sleep(Duration::from_secs(20));
    });
}

fn close(app: &AppHandle) { if let Some(window) = app.get_webview_window(LABEL) { let _ = window.destroy(); } }

fn open(app: &AppHandle, url: &str) {
    let Ok(parsed) = url.parse() else { return };
    let app = app.clone();
    // Criar janela fora da thread de quem chamou (evita travar a thread principal no Windows).
    tauri::async_runtime::spawn(async move {
        let built = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(parsed))
            .title("HLTV").visible(false).skip_taskbar(true).focused(false).inner_size(1100.0, 900.0)
            .initialization_script(SCRIPT)
            .build();
        if let Err(error) = built { eprintln!("[Heydesk] Janela do HLTV: {error}"); }
    });
}

/// Roda em cada página do HLTV na janela oculta. Só lê o DOM e relata; não clica,
/// não navega e não toca em desafios.
const SCRIPT: &str = r##"
(() => {
  if (location.hostname !== "www.hltv.org") return;
  const report = data => { try { window.__TAURI_INTERNALS__.invoke("hltv_report", { report: data }); } catch (e) {} };
  const challenged = () => /just a moment|attention required|verify you are human/i.test(document.title) || !!document.querySelector("#challenge-form, #cf-challenge-running, .cf-turnstile");
  const reasons = { bomb_exploded: "bomb", bomb_defused: "defuse", ct_win: "elimination", t_win: "elimination", stopwatch: "time", time: "time" };
  const reasonOf = src => { const name = (src || "").split("/").pop().replace(/\.(svg|png)$/, ""); return reasons[name] || name; };
  const list = () => {
    const matches = [...document.querySelectorAll(".match-wrapper[live=true]")].map(w => ({
      url: w.querySelector("a[href*='/matches/']")?.getAttribute("href") || "",
      teams: [...w.querySelectorAll(".match-teamname")].map(e => e.textContent.trim()),
    }));
    report({ kind: "list", matches });
  };
  const score = () => {
    const root = document.querySelector("#scoreboardElement");
    if (!root) { if (/match over/i.test(document.body.innerText.slice(0, 4000))) report({ kind: "over" }); return; }
    const text = sel => root.querySelector(sel)?.textContent.trim() || "";
    const roundText = text(".currentRoundText");
    const history = [];
    root.querySelectorAll(".roundHistory .roundHistoryLine").forEach(line => {
      const side = line.classList.contains("roundHistoryLineSideCT") ? "CT" : "T";
      const half = line.closest(".secondHalf") ? 1 : 0;
      [...line.children].forEach((cell, index) => {
        const img = cell.tagName === "IMG" ? cell : cell.querySelector("img");
        const src = img?.getAttribute("src") || "";
        if (!src || /emptyHistory|empty/i.test(src)) return;
        history.push({ round: half * 12 + index + 1, winner: side, reason: reasonOf(src) });
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
    if (location.pathname === "/matches") list();
    else if (/^\/matches\/\d+/.test(location.pathname)) score();
  };
  window.addEventListener("load", () => { setTimeout(tick, 2500); setInterval(() => { if (/^\/matches\/\d+/.test(location.pathname)) tick(); }, 4000); });
})();
"##;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_followed_game_by_team_names() {
        let list = vec![
            ListedMatch { url: "/matches/1/a".into(), teams: vec!["MIBR".into(), "Eternal Fire".into()] },
            ListedMatch { url: "/matches/2/b".into(), teams: vec!["BASEMENT BOYS".into(), "Toobisie".into()] },
        ];
        assert_eq!(find_match(&list, "Eternal Fire", "mibr").map(|item| item.url.as_str()), Some("/matches/1/a"));
        assert!(find_match(&list, "Basement Boys", "Teletubisie").is_none(), "nome diferente não chuta");
        assert!(same_team("FURIA Esports", "FURIA") && !same_team("", "x"));
    }
    #[test]
    fn reads_page_reports() {
        let report: Report = serde_json::from_str(r#"{"kind":"score","score":{"map":"Inferno","round":5,"ctTeam":"MIBR","tTeam":"Eternal Fire","ctScore":3,"tScore":1,"phase":"0:45","history":[{"round":1,"winner":"CT","reason":"defuse"}]}}"#).unwrap();
        assert!(matches!(report, Report::Score { ref score } if score.ct_score == 3 && score.history[0].reason == "defuse"));
        assert!(matches!(serde_json::from_str::<Report>(r#"{"kind":"blocked"}"#).unwrap(), Report::Blocked));
    }
}
