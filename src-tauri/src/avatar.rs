// Corpo do mascote no formato do open-bot-avatar (MIT, github.com/DominikScholz/open-bot-avatar):
// uma silhueta SVG numa caixa 0 0 100 100 e onde ficam os olhos. Os olhos animados continuam
// sendo os do Heydesk. Aqui: validação (o JSON vem de arquivo, colagem ou do Claude) e geração
// pelo próprio CLI do Claude, com o login do usuário.
use serde::{Deserialize, Serialize};
use std::{io::Write, path::PathBuf, process::{Command, Stdio}, time::{Duration, Instant}};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AvatarBody { pub path: String }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AvatarEyes { pub x: f64, pub y: f64, pub spacing: f64, pub scale: f64 }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AvatarDefinition { pub version: u32, pub id: String, pub name: String, pub body: AvatarBody, pub eyes: AvatarEyes }

/// Mesmas regras de forma do contrato v1, folgadas onde só a lib precisa ser estrita
/// (a interface ainda passa o JSON pelo `validateAvatar` da própria lib).
pub fn is_valid(avatar: &AvatarDefinition) -> bool {
    let id = &avatar.id;
    let slug = !id.is_empty() && id.len() <= 40 && !id.starts_with('-') && !id.ends_with('-') && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    let name = !avatar.name.trim().is_empty() && avatar.name.chars().count() <= 40 && !avatar.name.chars().any(char::is_control);
    let path = &avatar.body.path;
    let path_ok = !path.trim().is_empty() && path.len() <= 6000 && path.trim_start().starts_with(['M', 'm'])
        && path.chars().all(|c| "MLHVCSQTAZmlhvcsqtaz0123456789.,-+eE ".contains(c) || c.is_ascii_whitespace());
    let eyes = &avatar.eyes;
    let eyes_ok = [eyes.x, eyes.y, eyes.spacing, eyes.scale].iter().all(|value| value.is_finite())
        && (0.0..=100.0).contains(&eyes.x) && (0.0..=100.0).contains(&eyes.y) && (2.0..=60.0).contains(&eyes.spacing) && (0.3..=2.5).contains(&eyes.scale);
    avatar.version == 1 && slug && name && path_ok && eyes_ok
}

/// Instruções de geração da própria lib (skills/generate-avatar/references/system-prompt.md, MIT).
const SYSTEM: &str = include_str!("../avatars/system-prompt.md");
const MAX_DESCRIPTION: usize = 400;
const TIMEOUT: Duration = Duration::from_secs(150);

fn claude_path() -> PathBuf {
    let local = std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join(".local").join("bin").join("claude.exe"));
    local.filter(|path| path.exists()).unwrap_or_else(|| PathBuf::from("claude"))
}

/// Primeiro objeto JSON da resposta (o modelo às vezes cerca com ``` mesmo instruído a não).
pub(crate) fn extract_json(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    (end > start).then(|| &text[start..=end])
}

/// Descreve o mascote em texto e devolve a definição pronta (validada aqui; a interface valida de novo com a lib).
pub fn generate(description: &str, workdir: PathBuf) -> Result<AvatarDefinition, String> {
    let description: String = description.trim().chars().take(MAX_DESCRIPTION).collect();
    if description.is_empty() { return Err("Descreva o mascote.".into()); }
    std::fs::create_dir_all(&workdir).map_err(|error| error.to_string())?;
    let mut command = Command::new(claude_path());
    command.args(["-p", "--model", "claude-sonnet-5-5", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--permission-mode", "dontAsk",
        "--setting-sources", "", "--output-format", "json", "--system-prompt", SYSTEM])
        .current_dir(&workdir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x0800_0000); } // CREATE_NO_WINDOW
    let mut child = command.spawn().map_err(|_| "Não encontrei o claude. Instale o Claude Code e faça login.".to_string())?;
    if let Some(mut stdin) = child.stdin.take() { let _ = stdin.write_all(description.as_bytes()); }
    // Espera com limite: um CLI travado não pode prender a geração para sempre.
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > TIMEOUT => { let _ = child.kill(); return Err("O Claude demorou demais. Tente de novo.".into()); }
            Ok(None) => std::thread::sleep(Duration::from_millis(200)),
            Err(error) => return Err(error.to_string()),
        }
    }
    let output = child.wait_with_output().map_err(|error| error.to_string())?;
    let envelope: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|_| "O Claude não respondeu.".to_string())?;
    if envelope.get("is_error").and_then(|value| value.as_bool()) == Some(true) {
        return Err(envelope.get("result").and_then(|value| value.as_str()).unwrap_or("O Claude não respondeu.").chars().take(200).collect());
    }
    let text = envelope.get("result").and_then(|value| value.as_str()).unwrap_or_default();
    let avatar: AvatarDefinition = extract_json(text).and_then(|json| serde_json::from_str(json).ok()).ok_or("O Claude não devolveu um mascote válido. Tente descrever de outro jeito.")?;
    if !is_valid(&avatar) { return Err("O mascote gerado saiu fora das regras. Tente de novo.".into()); }
    Ok(avatar)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn mug() -> AvatarDefinition {
        serde_json::from_str(r#"{"version":1,"id":"mug","name":"Mug","body":{"path":"M22 20H62C67 20 70 23 70 28V72C70 80 64 86 56 86H28C20 86 14 80 14 72V28C14 23 17 20 22 20Z"},"eyes":{"x":42,"y":49,"spacing":16,"scale":1.15}}"#).unwrap()
    }
    #[test]
    fn accepts_contract_and_rejects_markup_or_bad_eyes() {
        assert!(is_valid(&mug()));
        let mut bad = mug(); bad.body.path = "M0 0<script>".into(); assert!(!is_valid(&bad));
        let mut bad = mug(); bad.id = "Mug Cup".into(); assert!(!is_valid(&bad));
        let mut bad = mug(); bad.eyes.scale = f64::NAN; assert!(!is_valid(&bad));
        let mut bad = mug(); bad.version = 2; assert!(!is_valid(&bad));
        assert!(serde_json::from_str::<AvatarDefinition>(r#"{"version":1,"id":"a","name":"A","body":{"path":"M0 0Z","fill":"red"},"eyes":{"x":1,"y":1,"spacing":9,"scale":1}}"#).is_err());
    }
    #[test]
    fn extracts_json_from_fenced_answer() {
        assert_eq!(extract_json("```json\n{\"a\":1}\n```"), Some("{\"a\":1}"));
        assert_eq!(extract_json("sem json"), None);
    }
}
