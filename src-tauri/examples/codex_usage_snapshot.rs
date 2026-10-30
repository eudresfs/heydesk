//! Verificação local do coletor. Imprime somente métricas, nunca conteúdo de conversas.
#[path = "../src/codex_usage/mod.rs"]
mod codex_usage;

use std::{path::PathBuf, time::{Duration, Instant}};

fn main() {
    let mut arguments = std::env::args_os().skip(1);
    let Some(home) = arguments.next() else {
        eprintln!("Uso: codex_usage_snapshot <codex_home> <banco_de_teste>");
        std::process::exit(2);
    };
    let Some(database) = arguments.next() else {
        eprintln!("Informe um banco de teste próprio, fora dos diretórios do Codex.");
        std::process::exit(2);
    };
    let monitor = codex_usage::CodexMonitor::new(PathBuf::from(home), PathBuf::from(database), true);
    let started = Instant::now();
    loop {
        std::thread::sleep(Duration::from_millis(200));
        let snapshot = monitor.snapshot();
        if !snapshot.scanning || started.elapsed() > Duration::from_secs(120) {
            println!("{}", serde_json::json!({"usage": snapshot, "quota": monitor.quota_snapshot()}));
            break;
        }
    }
}
