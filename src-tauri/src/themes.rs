// Pacotes de tema: uma pasta com `theme.json`, imagens do mascote por humor e,
// opcionalmente, fonte, sons, cores e textos. O app embute só mascotes originais
// (src-tauri/themes); o usuário importa os dele para %APPDATA%\dev.heydesk.app\themes\<id>.
// Tudo chega ao webview inline (data: URL e base64): sem protocolo de arquivos nem CSP nova.
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf, sync::Mutex, time::{Duration, Instant}};

const MAX_MANIFEST: usize = 64 * 1024;
const MAX_IMAGE: usize = 2 * 1024 * 1024;
const MAX_FONT: usize = 4 * 1024 * 1024;
const MAX_SOUND: usize = 1024 * 1024;
const MAX_PACK: u64 = 20 * 1024 * 1024;
const MAX_FILES: usize = 80;
const IMPORT_TTL: Duration = Duration::from_secs(10 * 60);
const SOUND_KINDS: [&str; 13] = ["notification", "reminder", "goal", "kickoff", "charger", "unplug", "warn", "open", "close", "tap", "giggle", "track", "confirm"];

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThemeImages {
    pub calm: String, pub happy: String, pub angry: String, pub sleepy: String,
    #[serde(default)] pub worried: Option<String>, #[serde(default)] pub wide: Option<String>, #[serde(default)] pub sleep: Option<String>,
    #[serde(default)] pub wink: Option<String>, #[serde(default)] pub laugh: Option<String>,
    #[serde(default = "yes")] pub pixelated: bool,
}
fn yes() -> bool { true }
impl ThemeImages {
    fn files(&self) -> Vec<(&'static str, &str)> {
        let mut list = vec![("calm", self.calm.as_str()), ("happy", self.happy.as_str()), ("angry", self.angry.as_str()), ("sleepy", self.sleepy.as_str())];
        for (mood, file) in [("worried", &self.worried), ("wide", &self.wide), ("sleep", &self.sleep), ("wink", &self.wink), ("laugh", &self.laugh)] {
            if let Some(file) = file { list.push((mood, file.as_str())); }
        }
        list
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThemeColors { #[serde(default)] pub ground: Option<String>, #[serde(default)] pub accent: Option<String>, #[serde(default)] pub text: Option<String>, #[serde(default)] pub glow: Option<[String; 3]> }

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThemeCopy { #[serde(default)] pub water: Option<Vec<String>>, #[serde(default)] pub map_for: Option<String> }

/// Visual do próprio notch: cores da superfície e do texto, borda, moldura do painel
/// aberto (9 fatias) e imagem de fundo do painel.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThemeHud {
    #[serde(default)] pub surface: Option<String>, #[serde(default)] pub text: Option<String>, #[serde(default)] pub muted: Option<String>,
    #[serde(default)] pub accent: Option<String>, #[serde(default)] pub border: Option<String>,
    #[serde(default)] pub frame: Option<String>, #[serde(default)] pub frame_slice: Option<u32>, #[serde(default)] pub panel: Option<String>,
    /// Textura repetida na superfície do notch (pedra, couro, metal).
    #[serde(default)] pub texture: Option<String>, #[serde(default)] pub texture_opacity: Option<f64>,
    /// Ornamento do canto superior esquerdo (espelhado nos outros três) e peça do centro do topo.
    #[serde(default)] pub corner: Option<String>, #[serde(default)] pub crest: Option<String>,
    /// Relevo (luz em cima, sombra embaixo) e um brilho que corre pela borda.
    #[serde(default)] pub bevel: Option<bool>, #[serde(default)] pub shimmer: Option<bool>,
    /// Quanto a imagem de fundo do painel aparece (0 a 1).
    #[serde(default)] pub panel_opacity: Option<f64>,
    /// Filetes internos que seguem o formato do notch (até 3), de fora para dentro.
    #[serde(default)] pub lines: Vec<ThemeLine>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThemeLine { pub color: String, pub inset: f64, pub width: f64, #[serde(default)] pub glow: bool }

/// `theme.json`. Chaves desconhecidas são ignoradas (arquivo escrito pelo usuário).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThemeManifest {
    pub schema: u32, pub name: String,
    #[serde(default)] pub author: Option<String>, #[serde(default)] pub version: Option<String>,
    #[serde(default)] pub images: Option<ThemeImages>, #[serde(default)] pub font: Option<String>,
    #[serde(default)] pub sounds: BTreeMap<String, String>, #[serde(default)] pub colors: Option<ThemeColors>, #[serde(default)] pub copy: Option<ThemeCopy>,
    #[serde(default)] pub hud: Option<ThemeHud>,
}

/// O que a lista de Aparência mostra.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThemeSummary {
    pub id: String, pub name: String, pub built_in: bool, pub has_images: bool, pub has_hud: bool, pub has_font: bool, pub sound_kinds: Vec<String>, pub glow: Option<[String; 3]>, pub preview: Option<String>, pub error: Option<String>,
    /// Cor e borda do HUD, para o cartão do tema em Aparência.
    pub surface: Option<String>, pub border: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThemeBlob { pub mime: String, pub base64: String }

/// Tema inteiro, pronto para o webview.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThemeBundle { pub id: String, pub name: String, pub built_in: bool, pub manifest: ThemeManifest, pub images: BTreeMap<String, String>, pub font: Option<ThemeBlob>, pub sounds: BTreeMap<String, ThemeBlob>, pub hud: BTreeMap<String, String> }

/// Temas embutidos: arte original do Heydesk, compilada no executável.
macro_rules! built_in {
    ($id:literal, [$($file:literal),*]) => {
        ($id, &[("theme.json", include_bytes!(concat!("../themes/", $id, "/theme.json")) as &[u8]) $(, ($file, include_bytes!(concat!("../themes/", $id, "/", $file)) as &[u8]))*] as &[(&str, &[u8])])
    };
}
macro_rules! sprite_theme { ($id:literal) => { built_in!($id, ["calm.svg", "happy.svg", "angry.svg", "sleepy.svg", "wide.svg"]) }; }
macro_rules! hud_theme { ($id:literal) => { built_in!($id, ["texture.svg", "corner.svg", "crest.svg", "panel.svg"]) }; }
const BUILT_IN: [(&str, &[(&str, &[u8])]); 9] = [
    built_in!("eyes", []),
    sprite_theme!("geleu"), sprite_theme!("lunito"), sprite_theme!("taturi"), sprite_theme!("zunzum"),
    hud_theme!("reliquia"), hud_theme!("arcano"), hud_theme!("neon"), hud_theme!("major"),
];
pub fn is_built_in(id: &str) -> bool { BUILT_IN.iter().any(|(name, _)| *name == id) }

/// Embutidos que só trazem visual do notch, sem mascote.
pub const HUD_ONLY: [&str; 3] = ["reliquia", "arcano", "neon"];
/// Id de tema: nome de pasta curto, minúsculo, sem espaços.
pub fn is_valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty() && bytes.len() <= 40 && bytes[0].is_ascii_alphanumeric() && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}
pub(crate) fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().chars().flat_map(|c| c.to_lowercase()) {
        if c.is_ascii_alphanumeric() { out.push(c); } else if !out.ends_with('-') && !out.is_empty() { out.push('-'); }
    }
    out.trim_matches('-').chars().take(40).collect::<String>().trim_matches('-').to_string()
}

/// Nome de arquivo do pacote: nunca sai da pasta do tema.
pub(crate) fn safe_name(name: &str) -> Result<&str, String> {
    let ok = !name.is_empty() && name.len() <= 64 && !name.starts_with('.')
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.');
    if ok { Ok(name) } else { Err(format!("Nome de arquivo inválido no tema: {name}")) }
}

enum Source { Embedded(&'static [(&'static str, &'static [u8])]), Dir(PathBuf) }
impl Source {
    fn file(&self, name: &str) -> Result<Vec<u8>, String> {
        let name = safe_name(name)?;
        match self {
            Source::Embedded(files) => files.iter().find(|(file, _)| *file == name).map(|(_, bytes)| bytes.to_vec()).ok_or_else(|| format!("Arquivo {name} não existe no tema.")),
            Source::Dir(dir) => {
                let path = dir.join(name);
                if path.parent() != Some(dir.as_path()) { return Err(format!("Nome de arquivo inválido no tema: {name}")); }
                std::fs::read(&path).map_err(|_| format!("Arquivo {name} não existe no tema."))
            }
        }
    }
    /// Tamanho sem ler o arquivo (pasta do usuário: metadados).
    fn size(&self, name: &str) -> Result<u64, String> {
        let name = safe_name(name)?;
        let missing = || format!("Arquivo {name} não existe no tema.");
        match self {
            Source::Embedded(files) => files.iter().find(|(file, _)| *file == name).map(|(_, bytes)| bytes.len() as u64).ok_or_else(missing),
            Source::Dir(dir) => std::fs::metadata(dir.join(name)).ok().filter(|meta| meta.is_file()).map(|meta| meta.len()).ok_or_else(missing),
        }
    }
}

fn is_hex(value: &str) -> bool { let b = value.as_bytes(); b.len() == 7 && b[0] == b'#' && b[1..].iter().all(u8::is_ascii_hexdigit) }

/// Tipo MIME pelo conteúdo (a extensão do usuário não é confiável).
fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG") { return Some("image/png"); }
    // SVG: aceita BOM, declaração XML, comentários e DOCTYPE antes de <svg.
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).to_ascii_lowercase();
    let head = head.trim_start_matches('\u{feff}').trim_start();
    if head.starts_with("<svg") || ((head.starts_with("<?xml") || head.starts_with("<!--") || head.starts_with("<!doctype")) && head.contains("<svg")) { return Some("image/svg+xml"); }
    if bytes.starts_with(b"\0\x01\0\0") || bytes.starts_with(b"true") { return Some("font/ttf"); }
    if bytes.starts_with(b"OTTO") { return Some("font/otf"); }
    if bytes.starts_with(b"wOF2") { return Some("font/woff2"); }
    if bytes.starts_with(b"wOFF") { return Some("font/woff"); }
    if bytes.starts_with(b"RIFF") { return Some("audio/wav"); }
    if bytes.starts_with(b"OggS") { return Some("audio/ogg"); }
    if bytes.starts_with(b"ID3") || bytes.starts_with(b"\xFF\xFB") || bytes.starts_with(b"\xFF\xF3") { return Some("audio/mpeg"); }
    None
}

fn read_manifest(source: &Source) -> Result<ThemeManifest, String> {
    let bytes = source.file("theme.json").map_err(|_| "Falta o theme.json.".to_string())?;
    if bytes.len() > MAX_MANIFEST { return Err("theme.json grande demais.".into()); }
    serde_json::from_slice(&bytes).map_err(|error| format!("theme.json inválido: {error}"))
}

/// Confere manifesto e arquivos; devolve os bytes lidos (para montar o pacote sem ler duas vezes).
fn validate(manifest: &ThemeManifest, source: &Source) -> Result<Loaded, String> {
    if manifest.schema != 1 { return Err("Versão do tema não suportada.".into()); }
    let name_len = manifest.name.trim().chars().count();
    if name_len == 0 || name_len > 40 { return Err("O nome do tema deve ter de 1 a 40 caracteres.".into()); }
    let mut loaded = Loaded::default();
    let mut total = 0usize;
    let mut check = |file: &str, max: usize, kinds: &[&str], what: &str| -> Result<(String, Vec<u8>), String> {
        let bytes = source.file(file)?;
        if bytes.len() > max { return Err(format!("{what} {file} passa de {} MB.", max / 1024 / 1024)); }
        let mime = sniff(&bytes).filter(|mime| kinds.iter().any(|kind| mime.starts_with(kind))).ok_or_else(|| format!("{what} {file} não é um arquivo válido."))?;
        total += bytes.len();
        if total as u64 > MAX_PACK { return Err("O tema passa de 20 MB.".into()); }
        Ok((mime.to_string(), bytes))
    };
    if let Some(images) = &manifest.images {
        for (mood, file) in images.files() {
            let (mime, bytes) = check(file, MAX_IMAGE, &["image/"], "A imagem")?;
            loaded.images.insert(mood.to_string(), format!("data:{mime};base64,{}", base64_of(&bytes)));
        }
    }
    if let Some(font) = &manifest.font {
        let (mime, bytes) = check(font, MAX_FONT, &["font/"], "A fonte")?;
        loaded.font = Some(ThemeBlob { mime, base64: base64_of(&bytes) });
    }
    for (kind, file) in &manifest.sounds {
        if !SOUND_KINDS.contains(&kind.as_str()) { return Err(format!("Som desconhecido no tema: {kind}.")); }
        let (mime, bytes) = check(file, MAX_SOUND, &["audio/"], "O som")?;
        loaded.sounds.insert(kind.clone(), ThemeBlob { mime, base64: base64_of(&bytes) });
    }
    if let Some(colors) = &manifest.colors {
        let all = [&colors.ground, &colors.accent, &colors.text].into_iter().flatten().chain(colors.glow.iter().flatten());
        for color in all { if !is_hex(color) { return Err(format!("Cor inválida no tema: {color}.")); } }
    }
    if let Some(hud) = &manifest.hud {
        for color in [&hud.surface, &hud.text, &hud.muted, &hud.accent, &hud.border].into_iter().flatten() {
            if !is_hex(color) { return Err(format!("Cor inválida no HUD do tema: {color}.")); }
        }
        if hud.frame_slice.is_some_and(|slice| !(1..=200).contains(&slice)) { return Err("Fatia da moldura inválida (1 a 200).".into()); }
        if [hud.texture_opacity, hud.panel_opacity].into_iter().flatten().any(|value| !value.is_finite() || !(0.0..=1.0).contains(&value)) { return Err("Opacidade do HUD inválida (0 a 1).".into()); }
        if hud.lines.len() > 3 || hud.lines.iter().any(|line| !is_hex(&line.color) || !line.inset.is_finite() || !(0.0..=30.0).contains(&line.inset) || !line.width.is_finite() || !(0.3..=6.0).contains(&line.width)) {
            return Err("Filetes do HUD inválidos (até 3; recuo 0 a 30, espessura 0,3 a 6).".into());
        }
        for (key, file) in [("frame", &hud.frame), ("panel", &hud.panel), ("texture", &hud.texture), ("corner", &hud.corner), ("crest", &hud.crest)] {
            if let Some(file) = file {
                let (mime, bytes) = check(file, MAX_IMAGE, &["image/"], "A imagem")?;
                loaded.hud.insert(key.to_string(), format!("data:{mime};base64,{}", base64_of(&bytes)));
            }
        }
    }
    if let Some(copy) = &manifest.copy {
        if copy.water.as_ref().is_some_and(|lines| lines.len() > 3 || lines.iter().any(|line| line.chars().count() > 120)) { return Err("Textos de água inválidos no tema.".into()); }
        if copy.map_for.as_ref().is_some_and(|text| text.chars().count() > 120) { return Err("Texto de mapa inválido no tema.".into()); }
    }
    Ok(loaded)
}

/// Conferência sem ler o conteúdo: esquema, nome, arquivos existentes e dentro do limite.
fn quick_check(manifest: &ThemeManifest, source: &Source) -> Result<(), String> {
    if manifest.schema != 1 { return Err("Versão do tema não suportada.".into()); }
    let name_len = manifest.name.trim().chars().count();
    if name_len == 0 || name_len > 40 { return Err("O nome do tema deve ter de 1 a 40 caracteres.".into()); }
    let mut files: Vec<(&str, usize)> = Vec::new();
    if let Some(images) = &manifest.images { files.extend(images.files().into_iter().map(|(_, file)| (file, MAX_IMAGE))); }
    if let Some(font) = &manifest.font { files.push((font, MAX_FONT)); }
    files.extend(manifest.sounds.values().map(|file| (file.as_str(), MAX_SOUND)));
    if let Some(hud) = &manifest.hud { files.extend([&hud.frame, &hud.panel, &hud.texture, &hud.corner, &hud.crest].into_iter().flatten().map(|file| (file.as_str(), MAX_IMAGE))); }
    let mut total = 0u64;
    for (file, max) in files {
        let size = source.size(file)?;
        if size > max as u64 { return Err(format!("O arquivo {file} passa de {} MB.", max / 1024 / 1024)); }
        total += size;
    }
    if total > MAX_PACK { return Err("O tema passa de 20 MB.".into()); }
    Ok(())
}

#[derive(Default)]
struct Loaded { images: BTreeMap<String, String>, font: Option<ThemeBlob>, sounds: BTreeMap<String, ThemeBlob>, hud: BTreeMap<String, String> }

#[cfg(windows)]
fn base64_of(bytes: &[u8]) -> String { crate::desktop_context::base64(bytes) }
#[cfg(not(windows))]
fn base64_of(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |acc, (i, b)| acc | (*b as u32) << (16 - 8 * i));
        for i in 0..4 { if i <= chunk.len() { out.push(TABLE[((n >> (18 - 6 * i)) & 63) as usize] as char); } else { out.push('='); } }
    }
    out
}

struct Import { dir: PathBuf, bytes: u64, files: usize, started: Instant }

pub struct Themes { user_dir: PathBuf, imports: Mutex<BTreeMap<u64, Import>>, next_token: Mutex<u64> }

impl Themes {
    pub fn new(user_dir: PathBuf) -> Self { Self { user_dir, imports: Mutex::new(BTreeMap::new()), next_token: Mutex::new(1) } }

    fn source(&self, id: &str) -> Option<(Source, bool)> {
        if let Some((_, files)) = BUILT_IN.iter().find(|(name, _)| *name == id) { return Some((Source::Embedded(files), true)); }
        if !is_valid_id(id) { return None; }
        let dir = self.user_dir.join(id);
        dir.join("theme.json").is_file().then_some((Source::Dir(dir), false))
    }

    /// Resumo leve para a lista: lê só o manifesto e a imagem de prévia; os outros arquivos
    /// têm existência e tamanho conferidos pelos metadados (a validação completa fica para
    /// a leitura e a importação). Antes isto lia e codificava o tema inteiro só para a prévia.
    fn summary(&self, id: &str, source: &Source, built_in: bool) -> ThemeSummary {
        let manifest = match read_manifest(source) { Ok(manifest) => manifest, Err(error) => return ThemeSummary { id: id.into(), name: id.into(), built_in, error: Some(error), ..Default::default() } };
        let error = quick_check(&manifest, source).err();
        // Prévia: o mascote calmo; tema só de HUD mostra o brasão.
        let preview_file = manifest.images.as_ref().map(|images| images.calm.clone()).or_else(|| manifest.hud.as_ref().and_then(|hud| hud.crest.clone()));
        let preview = if error.is_some() { None } else {
            preview_file.and_then(|file| source.file(&file).ok()).filter(|bytes| bytes.len() <= MAX_IMAGE)
                .and_then(|bytes| sniff(&bytes).filter(|mime| mime.starts_with("image/")).map(|mime| format!("data:{mime};base64,{}", base64_of(&bytes))))
        };
        ThemeSummary {
            id: id.into(), name: manifest.name.trim().to_string(), built_in, has_images: manifest.images.is_some(), has_hud: manifest.hud.is_some(), has_font: manifest.font.is_some(),
            sound_kinds: manifest.sounds.keys().cloned().collect(), glow: manifest.colors.and_then(|colors| colors.glow), preview, error,
            surface: manifest.hud.as_ref().and_then(|hud| hud.surface.clone()), border: manifest.hud.as_ref().and_then(|hud| hud.border.clone()),
        }
    }

    /// Embutidos primeiro, depois as pastas do usuário em ordem alfabética.
    pub fn list(&self) -> Vec<ThemeSummary> {
        let mut list: Vec<ThemeSummary> = BUILT_IN.iter().map(|(id, files)| self.summary(id, &Source::Embedded(files), true)).collect();
        let mut ids: Vec<String> = std::fs::read_dir(&self.user_dir).ok().into_iter().flatten().flatten()
            .filter(|entry| entry.path().is_dir()).filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|id| is_valid_id(id) && !is_built_in(id)).collect();
        ids.sort();
        for id in ids {
            let dir = self.user_dir.join(&id);
            if !dir.join("theme.json").is_file() { continue; }
            list.push(self.summary(&id, &Source::Dir(dir), false));
        }
        list
    }

    pub fn read(&self, id: &str) -> Result<ThemeBundle, String> {
        let (source, built_in) = self.source(id).ok_or_else(|| "Tema não encontrado.".to_string())?;
        let manifest = read_manifest(&source)?;
        let loaded = validate(&manifest, &source)?;
        Ok(ThemeBundle { id: id.into(), name: manifest.name.trim().to_string(), built_in, manifest, images: loaded.images, font: loaded.font, sounds: loaded.sounds, hud: loaded.hud })
    }

    /// Começa uma importação: pasta de preparo própria, apagada se não for concluída.
    pub fn import_begin(&self) -> Result<u64, String> {
        self.sweep();
        std::fs::create_dir_all(&self.user_dir).map_err(|error| error.to_string())?;
        let token = { let mut next = self.next_token.lock().map_err(|_| "Importação indisponível.".to_string())?; *next += 1; *next };
        let dir = self.user_dir.join(format!(".import-{}-{token}", std::process::id()));
        std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        self.imports.lock().map_err(|_| "Importação indisponível.".to_string())?.insert(token, Import { dir, bytes: 0, files: 0, started: Instant::now() });
        Ok(token)
    }

    /// Um arquivo da pasta escolhida. Só o nome base conta; o que não é do tema é ignorado.
    pub fn import_file(&self, token: u64, name: &str, bytes: &[u8]) -> Result<u64, String> {
        let mut imports = self.imports.lock().map_err(|_| "Importação indisponível.".to_string())?;
        let import = imports.get_mut(&token).ok_or_else(|| "Importação expirada.".to_string())?;
        let base = name.rsplit(['/', '\\']).next().unwrap_or_default();
        let lower = base.to_ascii_lowercase();
        let wanted = lower == "theme.json" || [".png", ".svg", ".ttf", ".otf", ".woff2", ".woff", ".wav", ".ogg", ".mp3"].iter().any(|ext| lower.ends_with(ext));
        if !wanted || safe_name(base).is_err() { return Ok(import.bytes); }
        // Aqui só um teto geral: o limite de cada tipo vale para os arquivos que o
        // theme.json usa (conferidos ao concluir). Arquivos sobrando na pasta não barram.
        let max = if lower == "theme.json" { MAX_MANIFEST } else { MAX_FONT };
        if bytes.len() > max { return Ok(import.bytes); }
        if import.files + 1 > MAX_FILES { return Err(format!("A pasta tem arquivos demais para um tema (máximo {MAX_FILES}).")); }
        if import.bytes + bytes.len() as u64 > MAX_PACK { return Err("O tema passa de 20 MB.".into()); }
        let path = import.dir.join(base);
        if path.parent() != Some(import.dir.as_path()) { return Err(format!("Nome de arquivo inválido no tema: {base}")); }
        std::fs::write(&path, bytes).map_err(|error| error.to_string())?;
        import.files += 1; import.bytes += bytes.len() as u64;
        Ok(import.bytes)
    }

    /// Confere o pacote preparado e o coloca em `themes/<id>` (substitui um tema igual).
    pub fn import_commit(&self, token: u64, folder: &str) -> Result<String, String> {
        let import = self.imports.lock().map_err(|_| "Importação indisponível.".to_string())?.remove(&token).ok_or_else(|| "Importação expirada.".to_string())?;
        let result = (|| {
            let id = slug(folder);
            if !is_valid_id(&id) { return Err("Nome de pasta inválido para um tema.".to_string()); }
            if is_built_in(&id) { return Err(format!("\"{id}\" é um tema embutido; renomeie a pasta.")); }
            let source = Source::Dir(import.dir.clone());
            let manifest = read_manifest(&source)?;
            validate(&manifest, &source)?;
            // Troca segura: o tema antigo vira ".old-*" e só sai depois que o novo entrou;
            // se a troca falhar no meio, o antigo volta para o lugar.
            let target = self.user_dir.join(&id);
            let old = self.user_dir.join(format!(".old-{id}-{}", std::process::id()));
            let replacing = target.exists();
            if replacing { std::fs::rename(&target, &old).map_err(|error| error.to_string())?; }
            if let Err(error) = std::fs::rename(&import.dir, &target) {
                if replacing { let _ = std::fs::rename(&old, &target); }
                return Err(error.to_string());
            }
            if replacing { let _ = std::fs::remove_dir_all(&old); }
            Ok(id)
        })();
        if result.is_err() { let _ = std::fs::remove_dir_all(&import.dir); }
        result
    }

    pub fn import_cancel(&self, token: u64) {
        if let Ok(mut imports) = self.imports.lock() { if let Some(import) = imports.remove(&token) { let _ = std::fs::remove_dir_all(import.dir); } }
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        if is_built_in(id) { return Err("Temas embutidos não podem ser removidos.".into()); }
        if !is_valid_id(id) { return Err("Tema não encontrado.".into()); }
        let dir = self.user_dir.join(id);
        if !dir.is_dir() { return Err("Tema não encontrado.".into()); }
        std::fs::remove_dir_all(dir).map_err(|error| error.to_string())
    }

    /// Importações abandonadas (janela fechada no meio) somem depois de 10 min.
    fn sweep(&self) {
        if let Ok(mut imports) = self.imports.lock() {
            let stale: Vec<u64> = imports.iter().filter(|(_, import)| import.started.elapsed() > IMPORT_TTL).map(|(token, _)| *token).collect();
            for token in stale { if let Some(import) = imports.remove(&token) { let _ = std::fs::remove_dir_all(import.dir); } }
        }
    }
}

/// Fora da thread principal: ler pastas de temas não pode travar o notch.
#[tauri::command]
pub async fn theme_list(app: tauri::AppHandle) -> Result<Vec<ThemeSummary>, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || app.state::<Themes>().list()).await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn theme_read(app: tauri::AppHandle, id: String) -> Result<ThemeBundle, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || app.state::<Themes>().read(&id)).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn theme_import_begin(themes: tauri::State<'_, Themes>) -> Result<u64, String> { themes.import_begin() }

#[tauri::command]
pub fn theme_import_file(themes: tauri::State<'_, Themes>, request: tauri::ipc::Request<'_>) -> Result<u64, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Arquivo inválido.".into()) };
    let header = |key: &str| request.headers().get(key).and_then(|value| value.to_str().ok()).map(|value| value.to_string()).unwrap_or_default();
    let token: u64 = header("x-token").parse().map_err(|_| "Importação expirada.".to_string())?;
    themes.import_file(token, &crate::shelf::percent_decode(&header("x-name")), bytes)
}

#[tauri::command]
pub fn theme_import_commit(app: tauri::AppHandle, themes: tauri::State<'_, Themes>, token: u64, folder: String) -> Result<String, String> {
    use tauri::Emitter;
    let id = themes.import_commit(token, &folder)?;
    // Todas as janelas esquecem a versão antiga (notch e configurações têm caches próprios).
    let _ = app.emit("theme:changed", &id);
    Ok(id)
}

#[tauri::command]
pub fn theme_import_cancel(themes: tauri::State<'_, Themes>, token: u64) { themes.import_cancel(token) }

#[tauri::command]
pub fn theme_remove(app: tauri::AppHandle, themes: tauri::State<'_, Themes>, id: String) -> Result<(), String> {
    use tauri::Emitter;
    themes.remove(&id)?;
    let _ = app.emit("theme:changed", &id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDir(PathBuf);
    impl TestDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("heydesk-themes-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for TestDir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n0000";
    fn manifest(extra: &str) -> String { format!(r#"{{"schema":1,"name":"Teste","images":{{"calm":"a.png","happy":"a.png","angry":"a.png","sleepy":"a.png"}}{extra}}}"#) }
    fn pack(dir: &std::path::Path, json: &str) { std::fs::create_dir_all(dir).unwrap(); std::fs::write(dir.join("theme.json"), json).unwrap(); std::fs::write(dir.join("a.png"), PNG).unwrap(); }

    #[test]
    fn built_ins_are_listed_and_eyes_has_no_images() {
        let test = TestDir::new("builtin");
        let list = Themes::new(test.0.join("themes")).list();
        let ids: Vec<&str> = list.iter().map(|theme| theme.id.as_str()).collect();
        assert_eq!(ids, ["eyes", "geleu", "lunito", "taturi", "zunzum", "reliquia", "arcano", "neon", "major"]);
        let relic = Themes::new(test.0.clone()).read("reliquia").unwrap();
        assert_eq!(relic.hud.len(), 4);
        assert_eq!(relic.manifest.hud.as_ref().unwrap().lines.len(), 2);
        assert!(relic.manifest.hud.as_ref().unwrap().bevel == Some(true) && list[5].preview.is_some());
        assert!(list.iter().all(|theme| theme.built_in && theme.error.is_none()), "{list:?}");
        assert!(!list[0].has_images && list[1].has_images && list[1].preview.as_deref().unwrap().starts_with("data:image/svg+xml;base64,"));
        let bundle = Themes::new(test.0.clone()).read("geleu").unwrap();
        assert_eq!(bundle.images.len(), 5);
        assert!(bundle.manifest.images.unwrap().pixelated);
    }

    #[test]
    fn manifest_ignores_unknown_keys_and_requires_moods() {
        let ok: ThemeManifest = serde_json::from_str(&manifest(r##","banana":1,"colors":{"glow":["#111111","#222222","#333333"]}"##)).unwrap();
        assert_eq!(ok.colors.unwrap().glow.unwrap()[2], "#333333");
        assert!(serde_json::from_str::<ThemeManifest>(r#"{"schema":1,"name":"x","images":{"calm":"a.png"}}"#).is_err());
    }

    #[test]
    fn safe_names_never_leave_the_folder() {
        for bad in ["..\\x.png", "../x.png", "C:\\x.png", "/etc/x", ".hidden", "", "a b.png", "x/y.png"] { assert!(safe_name(bad).is_err(), "{bad}"); }
        assert_eq!(safe_name("calm-2_v1.png").unwrap(), "calm-2_v1.png");
        assert_eq!(slug("Meu Tema Ragnarök!"), "meu-tema-ragnar-k");
        assert!(is_valid_id("meu-tema") && !is_valid_id("Meu") && !is_valid_id("-x") && !is_valid_id(""));
    }

    #[test]
    fn user_pack_is_validated_on_list_and_read() {
        let test = TestDir::new("user");
        let themes = Themes::new(test.0.clone());
        pack(&test.0.join("bom"), &manifest(""));
        pack(&test.0.join("semimagem"), r#"{"schema":1,"name":"x","images":{"calm":"nope.png","happy":"a.png","angry":"a.png","sleepy":"a.png"}}"#);
        std::fs::create_dir_all(test.0.join("vazio")).unwrap();
        std::fs::create_dir_all(test.0.join("grande")).unwrap();
        std::fs::write(test.0.join("grande/theme.json"), manifest("")).unwrap();
        let mut big = PNG.to_vec(); big.resize(MAX_IMAGE + 1, 0); std::fs::write(test.0.join("grande/a.png"), big).unwrap();
        let list = themes.list();
        let user: Vec<(&str, bool)> = list.iter().filter(|theme| !theme.built_in).map(|theme| (theme.id.as_str(), theme.error.is_none())).collect();
        assert_eq!(user, [("bom", true), ("grande", false), ("semimagem", false)]);
        assert!(themes.read("bom").unwrap().images["calm"].starts_with("data:image/png;base64,"));
        assert!(themes.read("grande").unwrap_err().contains("passa de 2 MB"));
        assert!(themes.read("semimagem").unwrap_err().contains("não existe"));
        assert!(themes.read("../bom").is_err() && themes.read("vazio").is_err());
    }

    #[test]
    fn import_strips_paths_validates_and_replaces() {
        let test = TestDir::new("import");
        let themes = Themes::new(test.0.clone());
        let token = themes.import_begin().unwrap();
        themes.import_file(token, "Meu Tema/theme.json", manifest("").as_bytes()).unwrap();
        themes.import_file(token, "../../a.png", PNG).unwrap();
        themes.import_file(token, "Meu Tema/Thumbs.db", b"junk").unwrap();
        assert_eq!(themes.import_commit(token, "Meu Tema").unwrap(), "meu-tema");
        assert!(test.0.join("meu-tema/a.png").is_file() && !test.0.join("meu-tema/Thumbs.db").exists());
        assert!(std::fs::read_dir(&test.0).unwrap().flatten().all(|entry| !entry.file_name().to_string_lossy().starts_with(".import")));
        // Reimportar substitui; pacote inválido não toca no existente.
        let token = themes.import_begin().unwrap();
        themes.import_file(token, "theme.json", br#"{"schema":2,"name":"x"}"#).unwrap();
        assert!(themes.import_commit(token, "meu tema").unwrap_err().contains("Versão"));
        assert!(test.0.join("meu-tema/a.png").is_file());
        assert!(themes.import_commit(999, "x").unwrap_err().contains("expirada"));
        let token = themes.import_begin().unwrap();
        themes.import_file(token, "theme.json", manifest("").as_bytes()).unwrap();
        themes.import_file(token, "a.png", PNG).unwrap();
        assert!(themes.import_commit(token, "geleu").unwrap_err().contains("embutido"));
        assert!(themes.remove("geleu").is_err() && themes.remove("meu-tema").is_ok() && !test.0.join("meu-tema").exists());
    }

    #[test]
    fn hud_colors_and_images_are_validated_and_loaded() {
        let test = TestDir::new("hud");
        let themes = Themes::new(test.0.clone());
        pack(&test.0.join("hud"), &manifest(r##","hud":{"surface":"#101010","text":"#ffffff","border":"#c89b3c","frame":"a.png","frameSlice":24,"panel":"a.png"}"##));
        let bundle = themes.read("hud").unwrap();
        assert_eq!(bundle.manifest.hud.as_ref().unwrap().frame_slice, Some(24));
        assert!(bundle.hud["frame"].starts_with("data:image/png;base64,") && bundle.hud.contains_key("panel"));
        pack(&test.0.join("cor"), &manifest(r##","hud":{"surface":"preto"}"##));
        assert!(themes.read("cor").unwrap_err().contains("HUD"));
        pack(&test.0.join("fatia"), &manifest(r##","hud":{"frameSlice":0}"##));
        assert!(themes.read("fatia").unwrap_err().contains("Fatia"));
        pack(&test.0.join("falta"), &manifest(r##","hud":{"panel":"nada.png"}"##));
        assert!(themes.read("falta").unwrap_err().contains("não existe"));
        pack(&test.0.join("rico"), &manifest(r##","hud":{"texture":"a.png","textureOpacity":0.5,"corner":"a.png","crest":"a.png","bevel":true,"shimmer":true,"panelOpacity":0.4}"##));
        let rich = themes.read("rico").unwrap();
        assert_eq!(rich.hud.keys().collect::<Vec<_>>(), ["corner", "crest", "texture"]);
        assert_eq!(rich.manifest.hud.unwrap().shimmer, Some(true));
        pack(&test.0.join("opaco"), &manifest(r##","hud":{"panelOpacity":2}"##));
        assert!(themes.read("opaco").unwrap_err().contains("Opacidade"));
        pack(&test.0.join("filete"), &manifest(r##","hud":{"lines":[{"color":"#d9a845","inset":5,"width":1.6,"glow":true}]}"##));
        assert_eq!(themes.read("filete").unwrap().manifest.hud.unwrap().lines[0].inset, 5.0);
        pack(&test.0.join("filetes"), &manifest(r##","hud":{"lines":[{"color":"#d9a845","inset":50,"width":1}]}"##));
        assert!(themes.read("filetes").unwrap_err().contains("Filetes"));
    }

    #[test]
    fn import_rejects_oversized_files_only_when_used() {
        let test = TestDir::new("big");
        let themes = Themes::new(test.0.clone());
        // Arquivo grande que o tema não usa: ignorado, a importação segue.
        let token = themes.import_begin().unwrap();
        themes.import_file(token, "theme.json", manifest("").as_bytes()).unwrap();
        themes.import_file(token, "a.png", PNG).unwrap();
        let mut sobra = b"RIFF".to_vec(); sobra.resize(MAX_SOUND + 10, 0);
        themes.import_file(token, "sobra.wav", &sobra).unwrap();
        assert_eq!(themes.import_commit(token, "ok").unwrap(), "ok");
        // Som grande que o tema usa: barrado ao concluir, sem deixar nada.
        let token = themes.import_begin().unwrap();
        themes.import_file(token, "theme.json", manifest(r#","sounds":{"goal":"goal.wav"}"#).as_bytes()).unwrap();
        themes.import_file(token, "a.png", PNG).unwrap();
        themes.import_file(token, "goal.wav", &sobra).unwrap();
        assert!(themes.import_commit(token, "grande").unwrap_err().contains("passa de 1 MB"));
        assert!(!test.0.join("grande").exists());
    }

    #[test]
    fn svg_sniff_accepts_bom_comments_and_doctype() {
        assert_eq!(sniff("\u{feff}<svg xmlns=\"x\"/>".as_bytes()), Some("image/svg+xml"));
        assert_eq!(sniff(b"<!-- arte --><svg/>"), Some("image/svg+xml"));
        assert_eq!(sniff(b"<?xml version=\"1.0\"?>\n<!DOCTYPE svg PUBLIC \"x\" \"y\">\n<svg/>"), Some("image/svg+xml"));
    }

    #[test]
    fn sniff_knows_the_formats() {
        assert_eq!(sniff(PNG), Some("image/png"));
        assert_eq!(sniff(b"<?xml version=\"1.0\"?><svg xmlns=\"x\"/>"), Some("image/svg+xml"));
        assert_eq!(sniff(b"wOF2...."), Some("font/woff2"));
        assert_eq!(sniff(b"RIFF....WAVE"), Some("audio/wav"));
        assert_eq!(sniff(b"hello"), None);
    }
}
