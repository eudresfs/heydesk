// Atualização automática: confere o latest.json das Releases do GitHub pouco depois
// de abrir e a cada 6 h. Achou versão nova (assinada com a chave do projeto), baixa e
// instala em modo passivo; o instalador fecha e reabre o Heydesk sozinho.
// Não atualiza no meio de uma gravação de tela: espera ela terminar.
use std::{sync::Arc, time::Duration};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

pub const UPDATE_EVENT: &str = "app:update";
const FIRST_CHECK: Duration = Duration::from_secs(45);
const EVERY: Duration = Duration::from_secs(6 * 60 * 60);

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio_sleep(FIRST_CHECK).await;
        loop {
            if let Err(error) = check(&app).await { eprintln!("[Heydesk] Atualização: {error}"); }
            tokio_sleep(EVERY).await;
        }
    });
}

async fn check(app: &AppHandle) -> Result<(), String> {
    let Some(update) = app.updater().map_err(|error| error.to_string())?.check().await.map_err(|error| error.to_string())? else { return Ok(()) };
    // Gravando? Tenta de novo a cada minuto até a gravação acabar.
    while recording(app) { tokio_sleep(Duration::from_secs(60)).await; }
    let _ = app.emit(UPDATE_EVENT, &update.version);
    update.download_and_install(|_, _| {}, || {}).await.map_err(|error| error.to_string())?;
    app.restart();
}

fn recording(app: &AppHandle) -> bool {
    app.try_state::<Arc<crate::recorder::Recorder>>().is_some_and(|recorder| matches!(recorder.state().state.as_str(), "recording" | "paused" | "saving"))
}

async fn tokio_sleep(duration: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(duration)).await;
}
