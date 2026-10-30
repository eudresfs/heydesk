use super::{WeatherLocation, WeatherState, WeatherStatus};
use chrono::{DateTime, NaiveDateTime, Utc};
use serde::Deserialize;
use std::{io::Read, time::Duration};

pub(super) const POLL_INTERVAL: Duration = Duration::from_secs(15 * 60);
pub(super) const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_AGE_SECONDS: i64 = 90 * 60;
const MAX_BODY_BYTES: u64 = 64 * 1024;
const ENDPOINT: &str = "https://api.open-meteo.com/v1/forecast";
const SOURCE: &str = "Open-Meteo";

#[derive(Deserialize)]
struct Forecast { current: Current }
#[derive(Deserialize)]
struct Current {
    time: String,
    temperature_2m: f64,
    weather_code: u32,
    is_day: u8,
}

pub(super) fn empty(location: Option<&WeatherLocation>) -> WeatherStatus {
    let valid = location.filter(|location| location.is_valid());
    WeatherStatus {
        state: if valid.is_some() { WeatherState::Unavailable } else { WeatherState::Unconfigured },
        city: valid.map(|location| location.city.clone()),
        temperature_c: None, weather_code: None, is_day: None, observed_at: None,
        source: SOURCE.into(),
    }
}

pub(super) fn expire(status: &mut WeatherStatus, now: DateTime<Utc>) {
    if status.state == WeatherState::Unconfigured { return; }
    let valid_time = status.observed_at.as_ref()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|observed| now.signed_duration_since(observed).num_seconds());
    if let Some(age) = valid_time.filter(|age| *age >= 0) {
        // A validade do payload recebido não limita a retenção de uma observação
        // já aceita. Um dado antigo continua histórico e nunca vira clima atual.
        if age > MAX_AGE_SECONDS { status.state = WeatherState::Stale; }
        return;
    }
    status.state = WeatherState::Unavailable;
    status.temperature_c = None;
    status.weather_code = None;
    status.is_day = None;
}

fn parse(body: &[u8], location: &WeatherLocation, now: DateTime<Utc>) -> Result<WeatherStatus, ()> {
    if !location.is_valid() { return Err(()); }
    let current = serde_json::from_slice::<Forecast>(body).map_err(|_| ())?.current;
    if !current.temperature_2m.is_finite() || !(-100.0..=70.0).contains(&current.temperature_2m)
        || !matches!(current.weather_code, 0..=3 | 45 | 48 | 51 | 53 | 55 | 56 | 57 | 61 | 63 | 65 | 66 | 67 | 71 | 73 | 75 | 77 | 80..=82 | 85 | 86 | 95 | 96 | 99)
        || current.is_day > 1 { return Err(()); }
    let time = NaiveDateTime::parse_from_str(&current.time, "%Y-%m-%dT%H:%M")
        .or_else(|_| NaiveDateTime::parse_from_str(&current.time, "%Y-%m-%dT%H:%M:%S"))
        .map_err(|_| ())?.and_utc();
    let age = now.signed_duration_since(time).num_seconds();
    if !(0..=MAX_AGE_SECONDS).contains(&age) { return Err(()); }
    Ok(WeatherStatus { state: WeatherState::Ready, city: Some(location.city.clone()),
        temperature_c: Some(current.temperature_2m), weather_code: Some(current.weather_code),
        is_day: Some(current.is_day == 1), observed_at: Some(time.to_rfc3339()), source: SOURCE.into() })
}

pub(super) fn fetch(location: &WeatherLocation) -> Result<WeatherStatus, ()> {
    if !location.is_valid() { return Err(()); }
    let client = reqwest::blocking::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(REQUEST_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build().map_err(|_| ())?;
    // Apenas coordenadas explícitas; nenhum dado de mídia, máquina ou usuário sai daqui.
    let response = client.get(ENDPOINT).query(&[
        ("latitude", location.latitude.to_string()),
        ("longitude", location.longitude.to_string()),
        ("current", "temperature_2m,weather_code,is_day".into()),
        ("timezone", "UTC".into()),
        ("temperature_unit", "celsius".into()),
    ]).send().and_then(|response| response.error_for_status()).map_err(|_| ())?;
    let mut body = Vec::new();
    response.take(MAX_BODY_BYTES + 1).read_to_end(&mut body).map_err(|_| ())?;
    if body.len() as u64 > MAX_BODY_BYTES { return Err(()); }
    parse(&body, location, Utc::now())
}

pub(super) fn failed(previous: Option<WeatherStatus>, location: &WeatherLocation, now: DateTime<Utc>) -> WeatherStatus {
    let mut status = previous.unwrap_or_else(|| empty(Some(location)));
    if status.temperature_c.is_some() { status.state = WeatherState::Stale; }
    expire(&mut status, now);
    status
}

#[cfg(test)]
mod tests {
    use super::*;
    fn location() -> WeatherLocation { WeatherLocation { city: "Natal/RN".into(), latitude: -5.795, longitude: -35.20944 } }
    fn now() -> DateTime<Utc> { "2026-10-28T16:00:00Z".parse().unwrap() }
    fn valid() -> &'static [u8] { br#"{"current":{"time":"2026-10-28T16:00","temperature_2m":29.5,"weather_code":2,"is_day":1}}"# }
    #[test]
    fn parses_valid_weather_without_inventing_missing_data() {
        let status = parse(valid(), &location(), now()).unwrap();
        assert_eq!(status.temperature_c, Some(29.5));
        assert_eq!(status.is_day, Some(true));
        for body in [br#"{"current":{"time":"2026-10-28T16:00","temperature_2m":100,"weather_code":2,"is_day":1}}"#.as_slice(),
            br#"{"current":{"time":"2026-10-28T16:00","temperature_2m":29,"weather_code":400,"is_day":1}}"#,
            br#"{"current":{"time":"2026-10-28T16:00","temperature_2m":29,"weather_code":2,"is_day":2}}"#,
            br#"{"current":{"time":"2026-10-28T16:00","temperature_2m":null,"weather_code":2,"is_day":1}}"#] {
            assert!(parse(body, &location(), now()).is_err());
        }
    }
    #[test]
    fn failure_retains_original_stale_value_beyond_ninety_minutes() {
        let status = parse(valid(), &location(), now()).unwrap();
        let stale = failed(Some(status), &location(), now() + chrono::Duration::minutes(20));
        assert_eq!(stale.state, WeatherState::Stale);
        assert_eq!(stale.temperature_c, Some(29.5));
        let expired = failed(Some(stale), &location(), now() + chrono::Duration::minutes(91));
        assert_eq!(expired.state, WeatherState::Stale);
        assert_eq!(expired.temperature_c, Some(29.5));
        assert_eq!(expired.observed_at, Some(now().to_rfc3339()));
        assert!(parse(valid(), &location(), now() + chrono::Duration::minutes(91)).is_err());
    }
    #[test]
    fn no_location_is_unconfigured_and_first_failure_is_unavailable() {
        assert_eq!(empty(None).state, WeatherState::Unconfigured);
        assert_eq!(failed(None, &location(), now()).state, WeatherState::Unavailable);
    }
    #[test]
    fn network_policy_has_bounded_timeout_and_fifteen_minute_poll() {
        assert_eq!(REQUEST_TIMEOUT.as_secs(), 5);
        assert_eq!(POLL_INTERVAL.as_secs(), 900);
        assert_eq!(ENDPOINT, "https://api.open-meteo.com/v1/forecast");
    }
}
