// Atualização: confere o latest.json das Releases do GitHub (versões assinadas com a
// chave do projeto). Logo depois de abrir (login, reinício) instala sozinho o que achar
// e reabre o Heydesk. Com o app aberto, procura a cada 30 min e só avisa no notch:
// "Atualizar" instala agora, "Depois" cala o aviso dessa versão por 24 h; de todo jeito
// ela entra no próximo reinício. Em Configurações dá para procurar na hora.
// Não instala no meio de uma gravação de tela.
use serde::Serialize;
use std::{sync::{Arc, Mutex}, time::{Duration, Instant}};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

pub const UPDATE_EVENT: &str = "app:update";
pub const PROGRESS_EVENT: &str = "app:update-progress";
const FIRST_CHECK: Duration = Duration::from_secs(15);
const EVERY: Duration = Duration::from_secs(30 * 60);
const SNOOZE: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo { pub current: String, pub version: Option<String>, pub notes: Option<String> }

#[derive(Default)]
pub struct Updater { pending: Mutex<Option<Update>>, dismissed: Mutex<Option<(String, Instant)>>, installing: Mutex<bool> }

fn info(app: &AppHandle, update: Option<&Update>) -> UpdateInfo {
    UpdateInfo { current: app.package_info().version.to_string(), version: update.map(|update| update.version.clone()), notes: update.and_then(|update| update.body.clone()) }
}

impl Updater {
    /// Procura agora. `announce`: avisa no notch (a busca automática respeita o "Depois").
    pub async fn check(app: &AppHandle, announce: bool) -> Result<UpdateInfo, String> {
        let found = app.updater().map_err(|error| error.to_string())?.check().await.map_err(|error| error.to_string())?;
        let updater = app.state::<Updater>();
        let result = info(app, found.as_ref());
        if let Ok(mut pending) = updater.pending.lock() { *pending = found; }
        if let Some(version) = &result.version {
            let snoozed = updater.dismissed.lock().ok().and_then(|value| value.clone()).is_some_and(|(dismissed, at)| &dismissed == version && at.elapsed() < SNOOZE);
            if announce && !snoozed { let _ = app.emit(UPDATE_EVENT, &result); }
        }
        Ok(result)
    }

    pub fn dismiss(&self, version: String) { if let Ok(mut dismissed) = self.dismissed.lock() { *dismissed = Some((version, Instant::now())); } }
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio_sleep(FIRST_CHECK).await;
        // Abertura: versão nova entra direto (o usuário acabou de abrir, nada a perder).
        match Updater::check(&app, false).await {
            Ok(found) if found.version.is_some() => if let Err(error) = install(&app).await { eprintln!("[Heydesk] Atualização: {error}"); let _ = Updater::check(&app, true).await; },
            Ok(_) => {}
            Err(error) => eprintln!("[Heydesk] Atualização: {error}"),
        }
        loop {
            tokio_sleep(EVERY).await;
            if let Err(error) = Updater::check(&app, true).await { eprintln!("[Heydesk] Atualização: {error}"); }
        }
    });
}

/// Baixa e instala a versão encontrada; o progresso vai para o notch e as configurações.
async fn install(app: &AppHandle) -> Result<(), String> {
    if recording(app) { return Err("Termine a gravação de tela antes de atualizar.".into()); }
    let updater = app.state::<Updater>();
    let update = updater.pending.lock().map_err(|_| "Atualização indisponível.".to_string())?.clone().ok_or("Nenhuma atualização encontrada. Procure de novo.")?;
    {
        let mut installing = updater.installing.lock().map_err(|_| "Atualização indisponível.".to_string())?;
        if *installing { return Ok(()); }
        *installing = true;
    }
    let (handle, mut done, mut total, mut last) = (app.clone(), 0u64, 0u64, u64::MAX);
    let result = update.download_and_install(move |chunk, length| {
        done += chunk as u64;
        if let Some(length) = length { total = length; }
        let percent = if total > 0 { (done * 100 / total).min(100) } else { 0 };
        // Só quando o número muda: milhares de pedaços não viram milhares de eventos.
        if percent != last { last = percent; let _ = handle.emit(PROGRESS_EVENT, percent); }
    }, || {}).await;
    if let Ok(mut installing) = updater.installing.lock() { *installing = false; }
    result.map_err(|error| error.to_string())?;
    app.restart();
}

fn recording(app: &AppHandle) -> bool {
    app.try_state::<Arc<crate::recorder::Recorder>>().is_some_and(|recorder| matches!(recorder.state().state.as_str(), "recording" | "paused" | "saving"))
}

async fn tokio_sleep(duration: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(duration)).await;
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateInfo, String> { Updater::check(&app, false).await }

#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> { install(&app).await }

#[tauri::command]
pub fn update_dismiss(updater: tauri::State<'_, Updater>, version: String) { updater.dismiss(version) }

#[tauri::command]
pub fn app_version(app: AppHandle) -> String { app.package_info().version.to_string() }
