//! Ledger local de métricas. Nenhum conteúdo de conversa é persistido ou registrado.
mod importer;
mod parser;
mod quota;
pub use quota::{CodexQuotaSnapshot, QuotaWindow};

use chrono::Utc;
use serde::Serialize;
use std::{path::PathBuf, sync::{Arc, Condvar, Mutex}, thread::{self, JoinHandle}, time::Duration};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageStatus { Disabled, Loading, Ready, Empty, NotInstalled, InsufficientData, Error }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDay {
    pub date: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_input_tokens: u64,
    pub reasoning_output_tokens: u64,
    pub total_tokens: u64,
    pub response_count: u64,
    pub session_count: u64,
    pub cache_write_input_tokens: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsageSnapshot {
    pub enabled: bool,
    pub status: UsageStatus,
    pub last_updated: Option<String>,
    pub scanning: bool,
    pub scanned_files: u64,
    pub pending_files: u64,
    pub legacy_only_files: u64,
    pub invalid_records: u64,
    pub conflicts: u64,
    pub today: Option<UsageDay>,
    pub days: Vec<UsageDay>,
    pub error: Option<String>,
}

impl CodexUsageSnapshot {
    fn initial(enabled: bool) -> Self {
        Self { enabled, status: if enabled { UsageStatus::Loading } else { UsageStatus::Disabled }, last_updated: None,
            scanning: enabled, scanned_files: 0, pending_files: 0, legacy_only_files: 0, invalid_records: 0,
            conflicts: 0, today: None, days: Vec::new(), error: None }
    }
}

struct Control { enabled: bool, refresh: bool, stop: bool }
struct Shared { control: Mutex<Control>, wake: Condvar, snapshot: Mutex<CodexUsageSnapshot>, quota: Mutex<CodexQuotaSnapshot> }

pub struct CodexMonitor { shared: Arc<Shared>, worker: Option<JoinHandle<()>> }

impl CodexMonitor {
    pub fn new(codex_home: PathBuf, database_path: PathBuf, enabled: bool) -> Self {
        let shared = Arc::new(Shared { control: Mutex::new(Control { enabled, refresh: enabled, stop: false }),
            wake: Condvar::new(), snapshot: Mutex::new(CodexUsageSnapshot::initial(enabled)),
            quota: Mutex::new(CodexQuotaSnapshot::initial(enabled)) });
        let background = Arc::clone(&shared);
        let worker = thread::Builder::new().name("codex-usage".into()).spawn(move || worker_loop(background, codex_home, database_path)).ok();
        if worker.is_none() {
            let mut snapshot = shared.snapshot.lock().unwrap_or_else(|e| e.into_inner());
            snapshot.scanning = false;
            if enabled { snapshot.status = UsageStatus::Error; snapshot.error = Some("Não foi possível iniciar a coleta local.".into()); }
        }
        Self { shared, worker }
    }

    /// A consulta IPC copia apenas o snapshot em memória.
    pub fn snapshot(&self) -> CodexUsageSnapshot {
        self.shared.snapshot.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// A consulta de cota não abre arquivos, banco nem credenciais.
    pub fn quota_snapshot(&self) -> CodexQuotaSnapshot {
        let mut snapshot = self.shared.quota.lock().unwrap_or_else(|e| e.into_inner()).clone();
        // O relógio só invalida disponibilidade; não cria observações nem repõe saldo.
        snapshot.age(Utc::now().timestamp());
        snapshot
    }

    pub fn request_refresh(&self) -> CodexUsageSnapshot {
        let mut control = self.shared.control.lock().unwrap_or_else(|e| e.into_inner());
        if control.enabled { control.refresh = true; self.shared.wake.notify_one(); }
        drop(control);
        self.snapshot()
    }

    pub fn set_enabled(&self, enabled: bool) {
        let mut control = self.shared.control.lock().unwrap_or_else(|e| e.into_inner());
        if control.enabled == enabled { return; }
        control.enabled = enabled; control.refresh = enabled;
        let mut snapshot = self.shared.snapshot.lock().unwrap_or_else(|e| e.into_inner());
        snapshot.enabled = enabled; snapshot.scanning = enabled; snapshot.error = None;
        snapshot.status = if enabled { UsageStatus::Loading } else { UsageStatus::Disabled };
        *self.shared.quota.lock().unwrap_or_else(|e| e.into_inner()) = CodexQuotaSnapshot::initial(enabled);
        self.shared.wake.notify_one();
    }
}

impl Drop for CodexMonitor {
    fn drop(&mut self) {
        { let mut control = self.shared.control.lock().unwrap_or_else(|e| e.into_inner()); control.stop = true; self.shared.wake.notify_one(); }
        if let Some(worker) = self.worker.take() { let _ = worker.join(); }
    }
}

fn worker_loop(shared: Arc<Shared>, home: PathBuf, database: PathBuf) {
    // A conexão pertence exclusivamente a esta thread, e só é aberta ao habilitar.
    let mut importer: Option<importer::Importer> = None;
    let mut busy = false;
    loop {
        let mut control = shared.control.lock().unwrap_or_else(|e| e.into_inner());
        while !control.stop && !control.enabled {
            control = shared.wake.wait(control).unwrap_or_else(|e| e.into_inner());
        }
        if control.stop { return; }
        let refresh = control.refresh;
        control.refresh = false;
        drop(control);
        let result = (|| -> Result<CodexUsageSnapshot, &'static str> {
            if importer.is_none() { importer = Some(importer::Importer::open(home.clone(), &database)?); }
            let importer = importer.as_mut().unwrap();
            if refresh || !busy { importer.start_scan()?; }
            busy = importer.step()?;
            importer.snapshot(busy)
        })();
        // Cotas não dependem da presença/status do ledger de respostas.
        let quota = importer.as_ref().map(|importer| importer.quota_snapshot());
        // Não publicar um lote atrasado depois de uma desativação.
        let control = shared.control.lock().unwrap_or_else(|e| e.into_inner());
        if control.stop { return; }
        if control.enabled {
            if let Some(Ok(next)) = quota {
                *shared.quota.lock().unwrap_or_else(|e| e.into_inner()) = next;
            }
            let mut current = shared.snapshot.lock().unwrap_or_else(|e| e.into_inner());
            match result {
                Ok(next) => *current = next,
                Err(message) => {
                    busy = false; current.status = UsageStatus::Error; current.scanning = false;
                    current.error = Some(message.into());
                }
            }
        }
        let delay = if busy { Duration::from_millis(80) } else { Duration::from_secs(30) };
        if !control.refresh && control.enabled {
            let _ = shared.wake.wait_timeout(control, delay).unwrap_or_else(|e| e.into_inner());
        }
    }
}

fn updated_now() -> String { Utc::now().to_rfc3339() }

#[cfg(test)]
mod tests;
