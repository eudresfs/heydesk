// Ask: perguntas ao Claude pelo próprio CLI (`claude -p`), com o login do usuário.
// Sem ferramentas, sem MCP, sem configurações do usuário e sem salvar sessão: o
// assistente só responde texto. A resposta chega em pedaços por eventos.
use serde::Serialize;
use std::{io::{BufRead, BufReader, Write}, path::PathBuf, process::{Child, Command, Stdio}, sync::{Arc, Mutex}};
use tauri::{AppHandle, Emitter};

pub const ASK_DELTA_EVENT: &str = "ask:delta";
pub const ASK_DONE_EVENT: &str = "ask:done";
const MAX_PROMPT: usize = 8_000;
const SYSTEM: &str = "Você é o assistente do Heydesk, uma ilha no topo da tela do Windows. Responda em português do Brasil, direto e curto (até 6 linhas, salvo pedido). Sem markdown pesado: no máximo listas simples.";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Delta { id: u64, text: String }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Done { id: u64, error: Option<String> }

#[derive(Default)]
pub struct Ask { running: Arc<Mutex<Option<(u64, Child)>>> }

fn claude_path() -> PathBuf {
    let local = std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join(".local").join("bin").join("claude.exe"));
    local.filter(|path| path.exists()).unwrap_or_else(|| PathBuf::from("claude"))
}

/// Texto novo de uma linha do stream-json (só deltas de texto).
pub(crate) fn delta_text(line: &str) -> Option<String> {
    let json: serde_json::Value = serde_json::from_str(line).ok()?;
    if json.get("type")?.as_str()? != "stream_event" { return None; }
    let delta = json.pointer("/event/delta")?;
    (delta.get("type")?.as_str()? == "text_delta").then(|| delta.get("text")?.as_str().map(String::from))?
}

/// Erro final reportado pelo CLI (`result` com `is_error`).
pub(crate) fn result_error(line: &str) -> Option<String> {
    let json: serde_json::Value = serde_json::from_str(line).ok()?;
    if json.get("type")?.as_str()? != "result" || !json.get("is_error")?.as_bool()? { return None; }
    Some(json.get("result").and_then(|value| value.as_str()).unwrap_or("O Claude não respondeu.").chars().take(200).collect())
}

impl Ask {
    pub fn start(&self, app: AppHandle, id: u64, prompt: String, workdir: PathBuf) -> Result<(), String> {
        let prompt: String = prompt.trim().chars().take(MAX_PROMPT).collect();
        if prompt.is_empty() { return Err("Escreva uma pergunta.".into()); }
        self.cancel();
        std::fs::create_dir_all(&workdir).map_err(|error| error.to_string())?;
        let mut command = Command::new(claude_path());
        command.args(["-p", "--model", "claude-haiku-5-5", "--effort", "medium", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--permission-mode", "dontAsk",
            "--setting-sources", "", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--system-prompt", SYSTEM])
            .current_dir(&workdir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)]
        { use std::os::windows::process::CommandExt; command.creation_flags(0x0800_0000); } // CREATE_NO_WINDOW
        let mut child = command.spawn().map_err(|_| "Não encontrei o claude. Instale o Claude Code e faça login.".to_string())?;
        if let Some(mut stdin) = child.stdin.take() { let _ = stdin.write_all(prompt.as_bytes()); }
        let stdout = child.stdout.take().ok_or("Sem saída do claude.")?;
        *self.running.lock().map_err(|_| "Ask indisponível.")? = Some((id, child));
        let running = self.running.clone();
        std::thread::Builder::new().name("heydesk-ask".into()).spawn(move || {
            let mut error = None;
            let mut any = false;
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(text) = delta_text(&line) { any = true; let _ = app.emit(ASK_DELTA_EVENT, Delta { id, text }); }
                else if let Some(message) = result_error(&line) { error = Some(message); }
            }
            let mut slot = running.lock().ok();
            let mine = slot.as_ref().and_then(|guard| guard.as_ref()).is_some_and(|(current, _)| *current == id);
            if !mine { return; } // cancelada ou substituída: quem cancelou já avisou
            let status = slot.as_mut().and_then(|guard| guard.take()).and_then(|(_, mut child)| child.wait().ok());
            if error.is_none() && !any && !status.is_some_and(|status| status.success()) {
                error = Some("O claude não respondeu. Rode claude no terminal para conferir o login.".into());
            }
            let _ = app.emit(ASK_DONE_EVENT, Done { id, error });
        }).map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn cancel(&self) {
        if let Ok(mut slot) = self.running.lock() {
            if let Some((_, mut child)) = slot.take() { let _ = child.kill(); let _ = child.wait(); }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_text_deltas_and_errors_from_stream_json() {
        assert_eq!(delta_text(r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}}"#).as_deref(), Some("ok"));
        assert_eq!(delta_text(r#"{"type":"stream_event","event":{"type":"message_start"}}"#), None);
        assert_eq!(delta_text(r#"{"type":"assistant","message":{}}"#), None);
        assert_eq!(result_error(r#"{"type":"result","is_error":true,"result":"Not logged in"}"#).as_deref(), Some("Not logged in"));
        assert_eq!(result_error(r#"{"type":"result","is_error":false,"result":"ok"}"#), None);
    }
}
