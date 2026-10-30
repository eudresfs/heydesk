use serde::{Deserialize, Serialize};
use crate::desktop_context::{DesktopConfig, WeatherLocation};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppSettings {
    pub schema_version: u32,
    pub appearance: AppearanceSettings,
    pub motion: MotionSettings,
    pub modules: ModuleSettings,
    pub weather_location: Option<WeatherLocation>,
    /// Aparência e comportamento do mascote (ausente em arquivos antigos: padrão).
    #[serde(default)]
    pub mascot: MascotSettings,
    #[serde(default)]
    pub sounds: SoundSettings,
    /// Páginas tiradas do ciclo do notch (ids da interface, como "sports").
    #[serde(default)]
    pub hidden_pages: Vec<String>,
    /// Ordem das páginas no dock e na rolagem (ids da interface); vazia = ordem padrão.
    #[serde(default)]
    pub page_order: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct MascotSettings {
    /// "oval" | "round" | "pixel" | "line" | "heart"
    pub eye_shape: String,
    pub eye_color: String,
    /// "aurora" | "amber" | "mint" | "rose" | "mono" | "custom"
    pub glow: String,
    pub glow_color: String,
    pub blink: bool,
    pub look: bool,
    pub reactions: bool,
    pub bounce: bool,
    /// "calm" | "lively"
    pub pace: String,
    /// Mascote também no painel aberto (desligado: só no notch fechado).
    pub in_panel: bool,
}
impl Default for MascotSettings {
    fn default() -> Self {
        Self { eye_shape: "oval".into(), eye_color: "#FFFFFF".into(), glow: "aurora".into(), glow_color: "#2D5BFF".into(),
            blink: true, look: true, reactions: true, bounce: true, pace: "calm".into(), in_panel: true }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct SoundSettings {
    pub enabled: bool,
    /// 0–100
    pub volume: u8,
    /// "soft" | "retro" | "minimal"
    pub pack: String,
    pub notifications: bool,
    pub reminders: bool,
    pub sports: bool,
    pub interactions: bool,
    pub respect_dnd: bool,
}
impl Default for SoundSettings {
    fn default() -> Self {
        Self { enabled: true, volume: 55, pack: "soft".into(), notifications: true, reminders: true, sports: true, interactions: false, respect_dnd: true }
    }
}

fn is_hex(color: &str) -> bool {
    let bytes = color.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(u8::is_ascii_hexdigit)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModuleSettings {
    pub codex_usage: bool,
    /// Ausente em arquivos v3 anteriores à página Claude: ligado por padrão.
    #[serde(default = "enabled")]
    pub claude_usage: bool,
    /// Esconde a ilha enquanto um app ocupa a tela principal inteira.
    #[serde(default = "enabled")]
    pub hide_in_fullscreen: bool,
    /// Notificações do WhatsApp no notch; o Windows pede permissão ao ligar.
    #[serde(default)]
    pub notifications: bool,
    pub system_info: bool,
    pub media: bool,
    pub weather: bool,
}

impl Default for ModuleSettings {
    fn default() -> Self { Self { codex_usage: true, claude_usage: true, hide_in_fullscreen: true, notifications: false, system_info: true, media: true, weather: false } }
}

fn enabled() -> bool { true }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyModulesV2 { codex_usage: bool }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacySettingsV2 {
    schema_version: u32,
    appearance: AppearanceSettings,
    motion: MotionSettings,
    modules: LegacyModulesV2,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacySettings {
    schema_version: u32,
    appearance: AppearanceSettings,
    motion: MotionSettings,
}

fn decode_settings(bytes: &[u8]) -> Result<AppSettings, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Version { schema_version: u32 }
    let version: Version = serde_json::from_slice(bytes)
        .map_err(|error| format!("Não foi possível interpretar as configurações: {error}"))?;
    let settings = match version.schema_version {
        1 => {
            let legacy: LegacySettings = serde_json::from_slice(bytes)
                .map_err(|error| format!("Não foi possível migrar as configurações: {error}"))?;
            if legacy.schema_version != 1 { return Err("Versão de configurações inválida.".into()); }
            AppSettings { schema_version: 3, appearance: legacy.appearance, motion: legacy.motion,
                modules: ModuleSettings::default(), weather_location: None, mascot: MascotSettings::default(), sounds: SoundSettings::default(), hidden_pages: Vec::new(), page_order: Vec::new() }
        }
        2 => {
            let legacy: LegacySettingsV2 = serde_json::from_slice(bytes)
                .map_err(|error| format!("Não foi possível migrar as configurações: {error}"))?;
            if legacy.schema_version != 2 { return Err("Versão de configurações inválida.".into()); }
            AppSettings { schema_version: 3, appearance: legacy.appearance, motion: legacy.motion,
                modules: ModuleSettings { codex_usage: legacy.modules.codex_usage, ..Default::default() }, weather_location: None, mascot: MascotSettings::default(), sounds: SoundSettings::default(), hidden_pages: Vec::new(), page_order: Vec::new() }
        }
        3 => serde_json::from_slice(bytes)
            .map_err(|error| format!("Não foi possível interpretar as configurações: {error}"))?,
        unsupported => return Err(format!("Versão de configurações não suportada: {unsupported}.")),
    };
    settings.validate()?;
    Ok(settings)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppearanceSettings {
    pub opacity: f64,
    pub accent_color: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MotionSettings {
    pub reduced_motion: ReducedMotion,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReducedMotion { System, On, Off }

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            schema_version: 3,
            appearance: AppearanceSettings { opacity: 94.0, accent_color: "#EB0028".into() },
            motion: MotionSettings { reduced_motion: ReducedMotion::System },
            modules: ModuleSettings::default(),
            weather_location: None, mascot: MascotSettings::default(), sounds: SoundSettings::default(), hidden_pages: Vec::new(), page_order: Vec::new(),
        }
    }
}

impl AppSettings {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 3 {
            return Err(format!("Versão de configurações não suportada: {}.", self.schema_version));
        }
        if !self.appearance.opacity.is_finite() || !(70.0..=100.0).contains(&self.appearance.opacity) {
            return Err("A opacidade deve estar entre 70 e 100.".into());
        }
        let color = self.appearance.accent_color.as_bytes();
        if color.len() != 7 || color[0] != b'#' || !color[1..].iter().all(u8::is_ascii_hexdigit) {
            return Err("A cor deve usar o formato hexadecimal #RRGGBB.".into());
        }
        let mascot = &self.mascot;
        if !["oval", "round", "pixel", "line", "heart"].contains(&mascot.eye_shape.as_str()) || !["aurora", "amber", "mint", "rose", "mono", "custom"].contains(&mascot.glow.as_str())
            || !["calm", "lively"].contains(&mascot.pace.as_str()) || !is_hex(&mascot.eye_color) || !is_hex(&mascot.glow_color) {
            return Err("Opções do mascote inválidas.".into());
        }
        if self.hidden_pages.len() > 20 || self.hidden_pages.iter().any(|page| page.is_empty() || page.len() > 20 || !page.chars().all(|c| c.is_ascii_alphanumeric())) {
            return Err("Páginas ocultas inválidas.".into());
        }
        if self.page_order.len() > 20 || self.page_order.iter().any(|page| page.is_empty() || page.len() > 20 || !page.chars().all(|c| c.is_ascii_alphanumeric())) {
            return Err("Ordem das páginas inválida.".into());
        }
        if self.sounds.volume > 100 || !["soft", "retro", "minimal"].contains(&self.sounds.pack.as_str()) {
            return Err("Opções de som inválidas.".into());
        }
        if self.weather_location.as_ref().is_some_and(|location| !location.is_valid()) {
            return Err("A cidade e as coordenadas do clima são inválidas.".into());
        }
        Ok(())
    }

    pub fn desktop_config(&self) -> DesktopConfig {
        DesktopConfig { system_info: self.modules.system_info, media: self.modules.media,
            weather: self.modules.weather, location: self.weather_location.clone() }
    }
}

pub struct SettingsStore {
    path: PathBuf,
    // O mesmo lock protege o estado de leitura e todas as gravações.
    loaded: Mutex<bool>,
}

impl SettingsStore {
    pub fn new(path: PathBuf) -> Self { Self { path, loaded: Mutex::new(false) } }

    pub fn load(&self) -> Result<AppSettings, String> {
        let mut loaded = self.loaded.lock().map_err(|_| "O estado das configurações está indisponível.")?;
        *loaded = false;
        let settings = match fs::read(&self.path) {
            Ok(bytes) => decode_settings(&bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => AppSettings::default(),
            Err(error) => return Err(format!("Não foi possível ler as configurações: {error}")),
        };
        settings.validate()?;
        *loaded = true;
        Ok(settings)
    }

    pub fn save(&self, settings: AppSettings) -> Result<AppSettings, String> {
        let loaded = self.loaded.lock().map_err(|_| "O estado das configurações está indisponível.")?;
        if !*loaded { return Err("Carregue as configurações com sucesso antes de salvar.".into()); }
        settings.validate()?;
        let bytes = serde_json::to_vec_pretty(&settings).map_err(|error| error.to_string())?;
        atomic_write(&self.path, &bytes).map_err(|error| format!("Não foi possível salvar as configurações: {error}"))?;
        Ok(settings)
    }
}

pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let parent = path.parent().ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "Diretório de configurações inválido."))?;
    fs::create_dir_all(parent)?;
    let staging = parent.join(format!(".settings-{}-{}-{}.tmp", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos(),
        NEXT.fetch_add(1, Ordering::Relaxed)));
    let result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&staging)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        // Mesmo diretório/volume: o replace atômico mantém o arquivo anterior se falhar.
        fs::rename(&staging, path)
    })();
    if result.is_err() { let _ = fs::remove_file(&staging); }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "heydesk-settings-test-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn settings_path(&self) -> PathBuf { self.0.join("settings.json") }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn defaults_serialize_to_the_frontend_contract() {
        let settings = AppSettings::default();
        assert_eq!(serde_json::to_value(&settings).unwrap(), serde_json::json!({
            "schemaVersion": 3,
            "appearance": { "opacity": 94.0, "accentColor": "#EB0028" },
            "motion": { "reducedMotion": "system" },
            "modules": { "codexUsage": true, "claudeUsage": true, "hideInFullscreen": true, "notifications": false, "systemInfo": true, "media": true, "weather": false },
            "weatherLocation": null,
            "mascot": { "eyeShape": "oval", "eyeColor": "#FFFFFF", "glow": "aurora", "glowColor": "#2D5BFF", "blink": true, "look": true, "reactions": true, "bounce": true, "pace": "calm", "inPanel": true },
            "sounds": { "enabled": true, "volume": 55, "pack": "soft", "notifications": true, "reminders": true, "sports": true, "interactions": false, "respectDnd": true },
            "hiddenPages": [],
            "pageOrder": []
        }));
        assert!(settings.validate().is_ok());
        let mut bad = settings.clone();
        bad.mascot.eye_shape = "triangle".into();
        assert!(bad.validate().is_err());
    }

    #[test]
    fn validates_opacity_and_hex_color() {
        let mut settings = AppSettings::default();
        for opacity in [70.0, 94.5, 100.0] {
            settings.appearance.opacity = opacity;
            assert!(settings.validate().is_ok());
        }
        for opacity in [69.0, 100.1, f64::NAN, f64::INFINITY] {
            settings.appearance.opacity = opacity;
            assert!(settings.validate().is_err());
        }
        settings.appearance.opacity = 94.0;
        for color in ["#123abc", "#ABCDEF"] {
            settings.appearance.accent_color = color.into();
            assert!(settings.validate().is_ok());
        }
        for color in ["red", "#abc", "123456", "#12345G", "#é1234"] {
            settings.appearance.accent_color = color.into();
            assert!(settings.validate().is_err());
        }
    }

    #[test]
    fn missing_settings_load_defaults_without_creating_a_file() {
        let directory = TestDirectory::new();
        let store = SettingsStore::new(directory.settings_path());
        assert_eq!(store.load().unwrap(), AppSettings::default());
        assert!(!directory.settings_path().exists());
    }

    #[test]
    fn migrates_v1_in_memory_preserving_appearance_without_rewriting() {
        let directory = TestDirectory::new();
        let path = directory.settings_path();
        let original = r##"{"schemaVersion":1,"appearance":{"opacity":81,"accentColor":"#98EB00"},"motion":{"reducedMotion":"on"}}"##;
        std::fs::write(&path, original).unwrap();
        let store = SettingsStore::new(path.clone());
        let mut migrated = store.load().unwrap();
        assert_eq!(migrated.schema_version, 3);
        assert_eq!(migrated.appearance.accent_color, "#98EB00");
        assert_eq!(migrated.appearance.opacity, 81.0);
        assert_eq!(migrated.motion.reduced_motion, ReducedMotion::On);
        assert!(migrated.modules.codex_usage);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        migrated.modules.codex_usage = false;
        store.save(migrated.clone()).unwrap();
        assert_eq!(SettingsStore::new(path).load().unwrap(), migrated);
    }

    #[test]
    fn migration_rejects_unknown_fields_without_overwriting() {
        let directory = TestDirectory::new();
        let path = directory.settings_path();
        let mut legacy = serde_json::json!({"schemaVersion":1,
            "appearance":{"opacity":94,"accentColor":"#98EB00"},
            "motion":{"reducedMotion":"system"}, "unexpected":true});
        let original = legacy.to_string();
        std::fs::write(&path, &original).unwrap();
        let store = SettingsStore::new(path.clone());
        assert!(store.load().is_err());
        assert!(store.save(AppSettings::default()).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        legacy.as_object_mut().unwrap().remove("unexpected");
        legacy["appearance"]["opacity"] = 200.into();
        std::fs::write(&path, legacy.to_string()).unwrap();
        assert!(store.load().is_err());
    }

    #[test]
    fn migrates_v2_preserving_disabled_codex_and_explicit_weather_only() {
        let directory = TestDirectory::new();
        let path = directory.settings_path();
        let original = r##"{"schemaVersion":2,"appearance":{"opacity":83,"accentColor":"#98EB00"},"motion":{"reducedMotion":"off"},"modules":{"codexUsage":false}}"##;
        std::fs::write(&path, original).unwrap();
        let store = SettingsStore::new(path.clone());
        let mut settings = store.load().unwrap();
        assert_eq!(settings.schema_version, 3);
        assert!(!settings.modules.codex_usage);
        assert!(!settings.modules.weather);
        assert!(settings.weather_location.is_none());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        settings.weather_location = Some(WeatherLocation { city: "Natal/RN".into(), latitude: -5.795, longitude: -35.20944 });
        settings.modules.weather = true;
        store.save(settings.clone()).unwrap();
        assert_eq!(store.load().unwrap(), settings);
        settings.weather_location.as_mut().unwrap().latitude = f64::NAN;
        assert!(store.save(settings).is_err());
    }

    #[test]
    fn saves_and_reloads_in_an_isolated_directory() {
        let directory = TestDirectory::new();
        let path = directory.settings_path();
        let store = SettingsStore::new(path.clone());
        let mut settings = store.load().unwrap();
        settings.appearance.opacity = 85.5;
        settings.motion.reduced_motion = ReducedMotion::On;
        assert_eq!(store.save(settings.clone()).unwrap(), settings);
        settings.motion.reduced_motion = ReducedMotion::Off;
        assert_eq!(store.save(settings.clone()).unwrap(), settings);
        assert_eq!(SettingsStore::new(path).load().unwrap(), settings);
    }

    #[test]
    fn saving_requires_a_successful_load() {
        let directory = TestDirectory::new();
        let store = SettingsStore::new(directory.settings_path());
        assert!(store.save(AppSettings::default()).is_err());
        assert!(!directory.settings_path().exists());
    }

    #[test]
    fn corrupt_or_unknown_settings_are_preserved_and_block_saves() {
        let directory = TestDirectory::new();
        let path = directory.settings_path();
        let mut unknown = serde_json::to_value(AppSettings::default()).unwrap();
        unknown["schemaVersion"] = 4.into();
        let invalid_motion = r##"{"schemaVersion":1,"appearance":{"opacity":94,"accentColor":"#EB0028"},"motion":{"reducedMotion":"invalid"}}"##;
        for content in ["{corrupt".to_string(), unknown.to_string(), invalid_motion.to_string()] {
            std::fs::write(&path, &content).unwrap();
            let store = SettingsStore::new(path.clone());
            assert!(store.load().is_err());
            assert!(store.save(AppSettings::default()).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
        }
    }

    #[test]
    fn validation_failure_preserves_the_last_saved_file() {
        let directory = TestDirectory::new();
        let path = directory.settings_path();
        let store = SettingsStore::new(path.clone());
        let mut settings = store.load().unwrap();
        store.save(settings.clone()).unwrap();
        let previous = std::fs::read(&path).unwrap();
        settings.appearance.opacity = 101.0;
        assert!(store.save(settings).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), previous);
        assert_eq!(store.load().unwrap(), AppSettings::default());
    }

    #[test]
    fn read_error_blocks_saving_and_preserves_the_target() {
        let directory = TestDirectory::new();
        let path = directory.settings_path();
        std::fs::create_dir(&path).unwrap();
        let store = SettingsStore::new(path.clone());
        assert!(store.load().is_err());
        assert!(store.save(AppSettings::default()).is_err());
        assert!(path.is_dir());
    }

    #[test]
    fn failed_reload_revokes_permission_to_save() {
        let directory = TestDirectory::new();
        let path = directory.settings_path();
        let store = SettingsStore::new(path.clone());
        store.load().unwrap();
        std::fs::write(&path, "invalid").unwrap();
        assert!(store.load().is_err());
        assert!(store.save(AppSettings::default()).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "invalid");
    }

    #[test]
    fn directory_creation_failure_is_reported_without_overwriting_the_blocker() {
        let directory = TestDirectory::new();
        let parent = directory.0.join("preferences");
        let store = SettingsStore::new(parent.join("settings.json"));
        store.load().unwrap();
        std::fs::write(&parent, "preserve").unwrap();
        assert!(store.save(AppSettings::default()).is_err());
        assert_eq!(std::fs::read_to_string(parent).unwrap(), "preserve");
    }

    #[test]
    fn concurrent_saves_leave_a_complete_valid_document() {
        let directory = TestDirectory::new();
        let store = std::sync::Arc::new(SettingsStore::new(directory.settings_path()));
        store.load().unwrap();
        let threads: Vec<_> = (70..=74).map(|opacity| {
            let store = store.clone();
            std::thread::spawn(move || {
                let mut settings = AppSettings::default();
                settings.appearance.opacity = f64::from(opacity);
                store.save(settings).unwrap();
            })
        }).collect();
        for thread in threads { thread.join().unwrap(); }
        let saved = store.load().unwrap();
        assert!((70.0..=74.0).contains(&saved.appearance.opacity));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn replacement_failure_keeps_the_previous_file_and_cleans_staging() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = TestDirectory::new();
        let path = directory.settings_path();
        let store = SettingsStore::new(path.clone());
        let mut settings = store.load().unwrap();
        store.save(settings.clone()).unwrap();
        let previous = std::fs::read(&path).unwrap();
        let guard = std::fs::OpenOptions::new().read(true).share_mode(0).open(&path).unwrap();
        settings.appearance.opacity = 80.0;
        assert!(store.save(settings).is_err());
        drop(guard);
        assert_eq!(std::fs::read(&path).unwrap(), previous);
        assert_eq!(std::fs::read_dir(&directory.0).unwrap().count(), 1);
    }
}
