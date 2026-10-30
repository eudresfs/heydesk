mod settings;
mod shell;
mod sports;
mod calendar;
mod shelf;
mod recorder;
mod cursor;
mod system_events;
mod ask;
mod awake;
mod claude_usage;
mod codex_usage;
mod desktop_context;
mod interaction;
mod lyrics;
mod notes;
mod pointer;
mod updater;
mod hltv;

use settings::{AppSettings, SettingsStore};
use tauri::{Emitter, Manager, State, WebviewWindow};

#[tauri::command]
fn load_settings(store: State<'_, SettingsStore>) -> Result<AppSettings, String> {
    store.load()
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, settings: AppSettings, store: State<'_, SettingsStore>, monitor: State<'_, codex_usage::CodexMonitor>, claude: State<'_, claude_usage::ClaudeMonitor>, desktop: State<'_, desktop_context::DesktopMonitor>) -> Result<AppSettings, String> {
    let saved = store.save(settings)?;
    monitor.set_enabled(saved.modules.codex_usage);
    claude.set_enabled(saved.modules.claude_usage);
    shell::HIDE_IN_FULLSCREEN.store(saved.modules.hide_in_fullscreen, std::sync::atomic::Ordering::Relaxed);
    desktop.set_config(saved.desktop_config());
    // A janela de configurações e o notch se mantêm em dia um com o outro.
    let _ = app.emit("settings:changed", &saved);
    Ok(saved)
}

/// Configurações numa janela própria (como um modal), centralizada na tela principal.
/// Já aberta: só traz para frente e troca de seção.
#[tauri::command]
async fn open_settings(app: tauri::AppHandle, section: String) -> Result<(), String> {
    if !section.chars().all(|c| c.is_ascii_alphanumeric()) || section.len() > 20 { return Err("Seção inválida.".into()); }
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.unminimize();
        window.set_focus().map_err(|error| error.to_string())?;
        return window.emit("settings:section", &section).map_err(|error| error.to_string());
    }
    let window = tauri::WebviewWindowBuilder::new(&app, "settings", tauri::WebviewUrl::App(format!("index.html?view=settings&section={section}").into()))
        .title("Configurações do Heydesk").background_color(tauri::window::Color(14, 14, 16, 255)).inner_size(820.0, 620.0).min_inner_size(640.0, 460.0).center().resizable(true).focused(true)
        .build().map_err(|error| error.to_string())?;
    let _ = window.set_focus();
    Ok(())
}

#[tauri::command]
fn get_codex_limits(monitor: State<'_, codex_usage::CodexMonitor>) -> codex_usage::CodexQuotaSnapshot { monitor.quota_snapshot() }

#[tauri::command]
fn get_claude_limits(monitor: State<'_, claude_usage::ClaudeMonitor>) -> claude_usage::ClaudeQuotaSnapshot { monitor.snapshot() }

// Rede bloqueante fora da thread principal: a ilha continua respondendo.
#[tauri::command]
async fn get_lyrics(app: tauri::AppHandle, title: String, artist: String, duration_ms: Option<u64>) -> Result<lyrics::Lyrics, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<lyrics::LyricsCache>().get(&title, &artist, duration_ms))
        .await.map_err(|error| error.to_string())
}

#[tauri::command]
fn set_keep_awake(on: bool, awake: State<'_, awake::KeepAwake>) -> Result<bool, String> { awake.set(on) }

#[tauri::command]
fn get_keep_awake(awake: State<'_, awake::KeepAwake>) -> bool { awake.active() }

#[tauri::command]
fn load_notes(store: State<'_, notes::NotesStore>) -> Result<notes::Notes, String> { store.load() }

#[tauri::command]
fn save_notes(app: tauri::AppHandle, notes: notes::Notes, store: State<'_, notes::NotesStore>) -> Result<notes::Notes, String> {
    let saved = store.save(notes)?;
    // Notch e janela de configurações (ajustes da água) leem o mesmo arquivo.
    let _ = app.emit("notes:changed", &saved);
    Ok(saved)
}

#[tauri::command]
fn ask_start(app: tauri::AppHandle, id: u64, prompt: String, ask: State<'_, ask::Ask>) -> Result<(), String> {
    let workdir = app.path().app_local_data_dir().map_err(|error| error.to_string())?.join("ask");
    ask.start(app, id, prompt, workdir)
}

#[tauri::command]
fn ask_cancel(ask: State<'_, ask::Ask>) { ask.cancel(); }

/// Relato da página do HLTV na janela oculta (única coisa que aquela página pode chamar).
#[tauri::command]
async fn hltv_report(app: tauri::AppHandle, report: hltv::Report) { app.state::<hltv::Hltv>().report(&app, report); }

/// Transmissão em PiP: janela pequena, sempre por cima, logo abaixo do notch, com o
/// player do canal (só YouTube, Twitch e Kick). `None` fecha.
#[tauri::command]
async fn stream_pip(app: tauri::AppHandle, url: Option<String>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("pip") { window.destroy().map_err(|error| error.to_string())?; }
    let Some(url) = url else { return Ok(()) };
    let parsed = tauri::Url::parse(&url).map_err(|_| "Link inválido.".to_string())?;
    if parsed.scheme() != "https" || !matches!(parsed.host_str(), Some("www.youtube.com" | "player.twitch.tv" | "player.kick.com")) { return Err("Transmissão não suportada.".into()); }
    let mut page = tauri::Url::parse("http://localhost/index.html").map_err(|error| error.to_string())?;
    page.query_pairs_mut().append_pair("view", "pip").append_pair("src", parsed.as_str());
    let (width, height) = (384.0, 216.0);
    let mut builder = tauri::WebviewWindowBuilder::new(&app, "pip", tauri::WebviewUrl::App(format!("index.html?{}", page.query().unwrap_or_default()).into()))
        .title("Transmissão").inner_size(width, height).decorations(false).always_on_top(true).skip_taskbar(true).resizable(false).focused(false)
        .background_color(tauri::window::Color(0, 0, 0, 255));
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let (scale, size) = (monitor.scale_factor(), monitor.size());
        builder = builder.position((size.width as f64 / scale - width) / 2.0, 44.0);
    }
    builder.build().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn set_cs_pinned(id: Option<String>, hltv: State<'_, hltv::Hltv>) { hltv.pin(id); }

#[tauri::command]
fn get_cs_live(hltv: State<'_, hltv::Hltv>) -> Option<hltv::LiveRounds> { hltv.current() }

#[tauri::command]
fn get_cs_status(hltv: State<'_, hltv::Hltv>) -> Option<serde_json::Value> { hltv.status() }

#[tauri::command]
fn get_sports(sports: State<'_, sports::Sports>) -> sports::SportsSnapshot { sports.snapshot() }

#[tauri::command]
fn get_sports_config(sports: State<'_, sports::Sports>) -> (sports::PublicConfig, Vec<(String, String, String)>) {
    (sports.config(), sports::CATALOG.iter().map(|(id, name, kind)| (id.to_string(), name.to_string(), kind.to_string())).collect())
}

#[tauri::command]
fn save_sports_config(leagues: Vec<String>, teams: Vec<String>, token: Option<String>, sports: State<'_, sports::Sports>) -> Result<sports::PublicConfig, String> {
    sports.save(leagues, teams, token)
}

#[tauri::command]
async fn get_league_teams(app: tauri::AppHandle, league: String) -> Result<Vec<sports::TeamOption>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let token = app.state::<sports::Sports>().token();
        sports::league_teams(&league, token.as_deref())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
fn get_media_art() -> Option<String> {
    #[cfg(windows)] { desktop_context::media_art() }
    #[cfg(not(windows))] { None }
}

#[tauri::command]
async fn configure_notifications(app: tauri::AppHandle, enabled: bool, apps: Vec<String>) -> Result<String, String> {
    // RequestAccessAsync pode abrir o pedido de permissão do Windows: fora da thread principal.
    tauri::async_runtime::spawn_blocking(move || app.state::<system_events::Notifications>().configure(app.clone(), enabled, apps))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
fn get_quiet() -> bool { system_events::quiet() }

/// Bolha de câmera: abre no canto inferior direito da tela principal, ou fecha.
#[tauri::command]
/// Assíncrono: criar janela num comando síncrono trava o Tauri no Windows.
async fn camera_bubble(app: tauri::AppHandle, show: bool) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window("camera") {
        if show { let _ = window.set_focus(); return Ok(true); }
        window.close().map_err(|error| error.to_string())?;
        return Ok(false);
    }
    if !show { return Ok(false); }
    let mut builder = tauri::WebviewWindowBuilder::new(&app, "camera", tauri::WebviewUrl::App("index.html?view=camera".into()))
        .title("Câmera").inner_size(220.0, 220.0).decorations(false).transparent(true).always_on_top(true)
        .skip_taskbar(true).resizable(false).shadow(false).focused(false);
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let (scale, size) = (monitor.scale_factor(), monitor.size());
        builder = builder.position(size.width as f64 / scale - 260.0, size.height as f64 / scale - 300.0);
    }
    builder.build().map_err(|error| error.to_string())?;
    Ok(true)
}

/// Contagem 3-2-1 no centro da tela (como Loom/Cap); fica fora do vídeo e não pega cliques.
#[tauri::command]
async fn countdown_overlay(app: tauri::AppHandle, show: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("countdown") { window.close().map_err(|error| error.to_string())?; }
    if !show { return Ok(()); }
    let monitor = app.primary_monitor().ok().flatten().ok_or("Monitor principal não encontrado.")?;
    let (scale, size, side) = (monitor.scale_factor(), monitor.size(), 240.0);
    let window = tauri::WebviewWindowBuilder::new(&app, "countdown", tauri::WebviewUrl::App("index.html?view=countdown".into()))
        .title("Contagem").inner_size(side, side).position((size.width as f64 / scale - side) / 2.0, (size.height as f64 / scale - side) / 2.0)
        .decorations(false).transparent(true).always_on_top(true).skip_taskbar(true).resizable(false).shadow(false).focused(false)
        .build().map_err(|error| error.to_string())?;
    window.set_ignore_cursor_events(true).map_err(|error| error.to_string())?;
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        use ::windows::Win32::{Foundation::HWND, UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE}};
        let _ = unsafe { SetWindowDisplayAffinity(HWND(hwnd.0), WDA_EXCLUDEFROMCAPTURE) };
    }
    Ok(())
}

#[tauri::command]
async fn cursor_overlay(app: tauri::AppHandle, show: bool) -> Result<(), String> { app.state::<cursor::CursorOverlay>().show(&app, show) }

#[tauri::command]
async fn recorder_capabilities() -> recorder::Capabilities { tauri::async_runtime::spawn_blocking(recorder::capabilities).await.unwrap_or_default() }

#[tauri::command]
fn recorder_state(recorder: State<'_, std::sync::Arc<recorder::Recorder>>) -> recorder::RecorderState { recorder.state() }

#[tauri::command]
async fn recorder_start(app: tauri::AppHandle, options: recorder::Options) -> Result<recorder::RecorderState, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<std::sync::Arc<recorder::Recorder>>().start(&app, options)).await.map_err(|error| error.to_string())?
}

/// action: "pause" | "resume" | "stop"
#[tauri::command]
async fn recorder_control(app: tauri::AppHandle, action: String) -> Result<recorder::RecorderState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let recorder = app.state::<std::sync::Arc<recorder::Recorder>>().inner().clone();
        match action.as_str() { "pause" => recorder.pause(&app), "resume" => recorder.resume(&app), "stop" => recorder.stop(&app), _ => Err("Ação inválida.".into()) }
    }).await.map_err(|error| error.to_string())?
}

/// Abre o vídeo ou mostra na pasta (só arquivos da pasta Vídeos\Heydesk).
#[tauri::command]
fn recorder_open(path: String, reveal: bool) -> Result<(), String> {
    let videos = std::env::var_os("USERPROFILE").map(|home| std::path::PathBuf::from(home).join("Videos").join("Heydesk")).ok_or("Pasta não encontrada.")?;
    let path = std::path::PathBuf::from(path);
    if !path.starts_with(&videos) || !path.is_file() { return Err("Arquivo não encontrado.".into()); }
    let mut command = std::process::Command::new("explorer");
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; if reveal { command.raw_arg(format!("/select,\"{}\"", path.display())); } else { command.arg(&path); } }
    #[cfg(not(windows))]
    { let _ = reveal; command.arg(&path); }
    command.spawn().map(|_| ()).map_err(|error| error.to_string())
}

#[tauri::command]
fn shelf_list(shelf: State<'_, shelf::Shelf>) -> Vec<shelf::Item> { shelf.items() }

#[tauri::command]
fn shelf_receive_start(app: tauri::AppHandle, shelf: State<'_, shelf::Shelf>) -> Result<shelf::ReceiveInfo, String> { shelf.start(app) }

#[tauri::command]
fn shelf_receive_stop(shelf: State<'_, shelf::Shelf>) { shelf.stop() }

#[tauri::command]
fn shelf_receive_status(shelf: State<'_, shelf::Shelf>) -> Option<shelf::ReceiveInfo> { shelf.receiving() }

/// Abre com o app padrão do Windows.
#[tauri::command]
fn shelf_open(id: String, shelf: State<'_, shelf::Shelf>) -> Result<(), String> {
    let path = shelf.path_of(&id).ok_or("Arquivo não encontrado.")?;
    std::process::Command::new("explorer").arg(path).spawn().map(|_| ()).map_err(|error| error.to_string())
}

/// Mostra o arquivo selecionado no Explorador.
#[tauri::command]
fn shelf_reveal(id: String, shelf: State<'_, shelf::Shelf>) -> Result<(), String> {
    let path = shelf.path_of(&id).ok_or("Arquivo não encontrado.")?;
    let mut command = std::process::Command::new("explorer");
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.raw_arg(format!("/select,\"{}\"", path.display())); }
    #[cfg(not(windows))]
    { command.arg(path); }
    command.spawn().map(|_| ()).map_err(|error| error.to_string())
}

/// Arquivo escolhido na interface: corpo bruto, nome no cabeçalho `x-name`.
#[tauri::command]
async fn shelf_add(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<shelf::Item, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Arquivo inválido.".into()) };
    let name = request.headers().get("x-name").and_then(|value| value.to_str().ok()).map(shelf::percent_decode).unwrap_or_default();
    // Gravar arquivos grandes fora da thread principal: o notch não congela.
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || app.state::<shelf::Shelf>().add_bytes(&app, &name, &bytes)).await.map_err(|error| error.to_string())?
}

/// Arquivos arrastados do Explorador para o notch.
#[tauri::command]
async fn shelf_add_paths(app: tauri::AppHandle, paths: Vec<String>) -> Result<Vec<shelf::Item>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shelf = app.state::<shelf::Shelf>();
        let mut added = Vec::new();
        let mut last_error = None;
        for path in paths.iter().take(50) { match shelf.add_path(&app, std::path::Path::new(path)) { Ok(item) => added.push(item), Err(error) => last_error = Some(error) } }
        if added.is_empty() { if let Some(error) = last_error { return Err(error); } }
        Ok(added)
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn shelf_thumbnail(app: tauri::AppHandle, id: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<shelf::Shelf>().thumbnail(&id)).await.ok().flatten()
}

/// Caminho do arquivo e da imagem de arrasto (o arrasto em si é do plugin `drag`).
#[tauri::command]
async fn shelf_drag_info(app: tauri::AppHandle, id: String) -> Result<(String, String), String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<shelf::Shelf>().drag_info(&id)).await.ok().flatten()
        .map(|(path, icon)| (path.to_string_lossy().to_string(), icon.to_string_lossy().to_string())).ok_or_else(|| "Arquivo não encontrado.".to_string())
}

#[tauri::command]
fn shelf_remove(id: String, shelf: State<'_, shelf::Shelf>) -> Result<Vec<shelf::Item>, String> { shelf.remove(&id) }

#[tauri::command]
fn get_calendar_events(calendars: State<'_, calendar::Calendars>) -> calendar::CalendarSnapshot { calendars.snapshot() }

#[tauri::command]
fn get_calendar_feeds(calendars: State<'_, calendar::Calendars>) -> Vec<calendar::PublicFeed> { calendars.feeds() }

#[tauri::command]
fn save_calendar_feeds(feeds: Vec<calendar::FeedInput>, calendars: State<'_, calendar::Calendars>) -> Result<Vec<calendar::PublicFeed>, String> { calendars.save(feeds) }

#[tauri::command]
fn get_desktop_status(desktop: State<'_, desktop_context::DesktopMonitor>) -> desktop_context::DesktopSnapshot { desktop.snapshot() }

// Comando síncrono rodaria na thread principal, que é STA (WebView2): ali o
// CoInitializeEx multithread falha e o Player não responde. Executa à parte.
#[tauri::command]
async fn media_control(app: tauri::AppHandle, action: desktop_context::MediaAction) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<desktop_context::DesktopMonitor>().media_control(action))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn get_notch_interaction(window: WebviewWindow) -> interaction::InteractionSnapshot { interaction::snapshot(&window) }

#[tauri::command]
fn get_codex_usage(monitor: State<'_, codex_usage::CodexMonitor>) -> codex_usage::CodexUsageSnapshot {
    monitor.snapshot()
}

#[tauri::command]
fn refresh_codex_usage(monitor: State<'_, codex_usage::CodexMonitor>) -> codex_usage::CodexUsageSnapshot {
    monitor.request_refresh()
}

#[tauri::command]
fn set_hit_shape(shape: pointer::HitShape, state: State<'_, pointer::SharedShape>) -> Result<(), String> {
    state.set(shape.validated()?);
    Ok(())
}

#[tauri::command]
fn hide_island(window: WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|error| error.to_string())?;
    window.emit(shell::SHELL_HIDDEN_EVENT, ()).map_err(|error| error.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Atalhos da gravação: Ctrl+Alt+R grava/para (com contagem), Ctrl+Alt+P pausa.
        .plugin(tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, shortcut, event| {
                use tauri_plugin_global_shortcut::{Code, ShortcutState};
                if event.state() != ShortcutState::Pressed { return; }
                let action = if shortcut.key == Code::KeyR { "toggle" } else { "pause" };
                let _ = app.emit("recorder:hotkey", action);
            })
            .build())
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            set_hit_shape,
            hide_island,
            get_codex_usage,
            refresh_codex_usage,
            get_codex_limits,
            get_claude_limits,
            get_lyrics,
            set_keep_awake,
            load_notes,
            ask_start,
            get_sports,
            configure_notifications,
            get_quiet,
            get_calendar_events,
            shelf_list,
            recorder_capabilities,
            camera_bubble,
            cursor_overlay,
            hltv_report,
            get_cs_live,
            get_cs_status,
            set_cs_pinned,
            stream_pip,
            open_settings,
            countdown_overlay,
            recorder_state,
            recorder_start,
            recorder_control,
            recorder_open,
            shelf_receive_start,
            shelf_receive_stop,
            shelf_receive_status,
            shelf_open,
            shelf_reveal,
            shelf_remove,
            shelf_drag_info,
            shelf_thumbnail,
            shelf_add_paths,
            shelf_add,
            get_calendar_feeds,
            save_calendar_feeds,
            get_media_art,
            get_sports_config,
            save_sports_config,
            get_league_teams,
            ask_cancel,
            save_notes,
            get_keep_awake,
            get_desktop_status,
            get_notch_interaction,
            media_control,
        ])
        .setup(|app| {
            let settings_path = app.path().app_config_dir()?.join("settings.json");
            let store = SettingsStore::new(settings_path);
            // Preferência ilegível não autoriza iniciar uma coleta que pode estar desativada.
            let loaded = store.load().ok();
            let enabled = loaded.as_ref().map(|settings| settings.modules.codex_usage).unwrap_or(false);
            let desktop_config = loaded.as_ref().map(AppSettings::desktop_config).unwrap_or(desktop_context::DesktopConfig {
                system_info: false, media: false, weather: false, location: None,
            });
            let codex_home = match std::env::var_os("CODEX_HOME").filter(|value| !value.is_empty()) {
                Some(path) => std::path::PathBuf::from(path),
                None => app.path().home_dir()?.join(".codex"),
            };
            let database_path = app.path().app_local_data_dir()?.join("usage.sqlite3");
            app.manage(codex_usage::CodexMonitor::new(codex_home, database_path, enabled));
            app.manage(claude_usage::ClaudeMonitor::start(loaded.as_ref().map(|settings| settings.modules.claude_usage).unwrap_or(false)));
            app.manage(desktop_context::DesktopMonitor::new(desktop_config));
            app.manage(store);
            app.manage(lyrics::LyricsCache::default());
            app.manage(awake::KeepAwake::default());
            app.manage(ask::Ask::default());
            app.manage(system_events::Notifications::default());
            system_events::start(app.handle().clone());
            app.manage(hltv::Hltv::default());
            hltv::watch(app.handle().clone());
            app.manage(sports::Sports::start(app.path().app_config_dir()?.join("sports.json")));
            app.manage(std::sync::Arc::new(recorder::Recorder::default()));
            app.manage(cursor::CursorOverlay::default());
            app.manage(shelf::Shelf::new(app.path().app_local_data_dir()?.join("shelf")));
            app.manage(calendar::Calendars::start(app.path().app_config_dir()?.join("calendars.json")));
            app.manage(notes::NotesStore::new(app.path().app_config_dir()?.join("notes.json")));
            shell::HIDE_IN_FULLSCREEN.store(loaded.as_ref().map(|settings| settings.modules.hide_in_fullscreen).unwrap_or(true), std::sync::atomic::Ordering::Relaxed);
            // Atalhos da gravação: registrados um a um e sem derrubar o app quando outro
            // programa já usa a combinação (antes o Heydesk fechava ao abrir).
            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                for shortcut in ["ctrl+alt+r", "ctrl+alt+p"] {
                    if let Err(error) = app.global_shortcut().register(shortcut) { eprintln!("[Heydesk] Atalho {shortcut} indisponível: {error}"); }
                }
            }
            // Só o app instalado (release) procura versões novas.
            if !cfg!(debug_assertions) { updater::start(app.handle().clone()); }
            shell::setup(app)
        })
        .on_window_event(|window, event| {
            // Bolha fechada pelo próprio "×": o botão de câmera do notch desliga junto.
            if window.label() == "camera" && matches!(event, tauri::WindowEvent::Destroyed) { let _ = window.app_handle().emit("camera:closed", ()); }
            // Só a ilha recolhe em vez de fechar; bolha de câmera e realce fecham de verdade.
            if window.label() != "main" { return; }
            if let tauri::WindowEvent::ScaleFactorChanged { .. } = event {
                if let Some(webview) = window.app_handle().get_webview_window(window.label()) {
                    if let Err(error) = shell::place_island(&webview) { eprintln!("[Heydesk] Falha ao reposicionar a ilha: {error}"); }
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Err(error) = window.hide() {
                    eprintln!("[Heydesk] Falha ao ocultar a janela: {error}");
                }
                if let Err(error) = window.emit(shell::SHELL_HIDDEN_EVENT, ()) {
                    eprintln!("[Heydesk] Falha ao recolher a ilha: {error}");
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Não foi possível executar o Heydesk");
}
