mod hardware;
mod weather;
mod worker;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub fn media_art() -> Option<String> { windows::media_art() }
#[cfg(windows)]
pub(crate) use windows::base64;

use serde::{Deserialize, Serialize};
pub use worker::DesktopMonitor;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WeatherLocation {
    pub city: String,
    pub latitude: f64,
    pub longitude: f64,
}

impl WeatherLocation {
    pub fn is_valid(&self) -> bool {
        !self.city.trim().is_empty()
            && self.city.chars().count() <= 80
            && self.latitude.is_finite()
            && self.longitude.is_finite()
            && (-90.0..=90.0).contains(&self.latitude)
            && (-180.0..=180.0).contains(&self.longitude)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DesktopConfig {
    pub system_info: bool,
    pub media: bool,
    pub weather: bool,
    pub location: Option<WeatherLocation>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSnapshot {
    pub observed_at: Option<String>,
    pub cpu_percent: Option<f64>,
    pub memory: Option<MemoryStatus>,
    pub battery: Option<BatteryStatus>,
    pub disk: Option<MemoryStatus>,
    pub network: Option<NetworkStatus>,
    pub media: Option<MediaStatus>,
    pub weather: Option<WeatherStatus>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStatus {
    pub used_bytes: u64,
    pub total_bytes: u64,
}

/// Taxa somada das interfaces físicas ativas, em bytes por segundo.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkStatus {
    pub down_bps: f64,
    pub up_bps: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatteryStatus {
    pub percent: Option<f64>,
    pub charging: bool,
    pub plugged: bool,
    pub has_battery: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaStatus {
    pub state: MediaState,
    pub title: Option<String>,
    pub artist: Option<String>,
    /// Muda quando há capa nova; a imagem vem por `get_media_art`, fora do poll.
    pub art_key: Option<String>,
    /// Nome curto do app de origem (Spotify, Chrome…), sem caminho.
    pub source: Option<String>,
    /// Posição na faixa no instante `position_at_ms` (época Unix); o frontend extrapola.
    pub position_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    pub position_at_ms: Option<i64>,
    pub can_previous: bool,
    pub can_next: bool,
    pub can_toggle: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum MediaAction { Toggle, Next, Previous }

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaState { Playing, Paused, Empty, Unavailable }

impl MediaStatus {
    fn unavailable() -> Self { Self::bare(MediaState::Unavailable) }
    #[cfg_attr(not(windows), allow(dead_code))]
    fn bare(state: MediaState) -> Self {
        Self { state, title: None, artist: None, art_key: None, source: None, position_ms: None, duration_ms: None, position_at_ms: None,
            can_previous: false, can_next: false, can_toggle: false }
    }
}

/// `SourceAppUserModelId` vira um nome legível: "Spotify.exe" → "Spotify",
/// "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic" → "ZuneMusic".
#[cfg_attr(not(windows), allow(dead_code))]
pub fn source_name(id: &str) -> Option<String> {
    let base = id.rsplit('!').next().unwrap_or(id);
    let base = base.split('_').next().unwrap_or(base);
    let base = base.strip_suffix(".exe").or_else(|| base.strip_suffix(".EXE")).unwrap_or(base);
    let base = base.rsplit(['.', '\\', '/']).next().unwrap_or(base).trim();
    if base.is_empty() || base.chars().all(|c| c.is_ascii_hexdigit()) { return None; }
    Some(base.chars().take(40).collect())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeatherStatus {
    pub state: WeatherState,
    pub city: Option<String>,
    pub temperature_c: Option<f64>,
    pub weather_code: Option<u32>,
    pub is_day: Option<bool>,
    pub observed_at: Option<String>,
    pub source: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WeatherState { Ready, Stale, Unavailable, Unconfigured }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dto_uses_camel_case_and_preserves_unknown_values() {
        let value = serde_json::to_value(DesktopSnapshot::default()).unwrap();
        assert!(value["cpuPercent"].is_null());
        assert!(value["observedAt"].is_null());
        let media = MediaStatus::unavailable();
        assert_eq!(serde_json::to_value(media).unwrap()["state"], "unavailable");
        assert_eq!(source_name("Spotify.exe").as_deref(), Some("Spotify"));
        assert_eq!(source_name("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic").as_deref(), Some("ZuneMusic"));
        assert_eq!(source_name("Chrome").as_deref(), Some("Chrome"));
        assert_eq!(source_name("308046B0AF4A39CB"), None);
        assert_eq!(serde_json::from_str::<MediaAction>("\"toggle\"").unwrap(), MediaAction::Toggle);
    }
    #[test]
    fn location_requires_explicit_bounded_coordinates() {
        let mut location = WeatherLocation { city: "Natal/RN".into(), latitude: -5.795, longitude: -35.20944 };
        assert!(location.is_valid());
        location.latitude = f64::NAN;
        assert!(!location.is_valid());
        location.latitude = 91.0;
        assert!(!location.is_valid());
    }
}
