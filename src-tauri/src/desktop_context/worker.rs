use super::{hardware::{self, CpuTimes}, weather, DesktopConfig, DesktopSnapshot, MediaAction, MediaStatus, WeatherLocation, WeatherStatus};
use chrono::Utc;
use std::{sync::{Arc, Condvar, Mutex, MutexGuard}, thread::{self, JoinHandle}, time::{Duration, Instant}};

// O cache fica privado quando o módulo está desligado. O prazo é global e não
// reinicia por toggle ou mudança de cidade, evitando consultas em sequência.
struct WeatherCache { observations: Vec<(WeatherLocation, WeatherStatus)>, next_poll: Instant }
impl WeatherCache {
    fn new(now: Instant) -> Self { Self { observations: Vec::new(), next_poll: now } }
    fn begin_poll(&mut self, now: Instant) -> bool {
        if now < self.next_poll { return false; }
        self.next_poll = now + weather::POLL_INTERVAL;
        true
    }
    fn snapshot(&self, location: &WeatherLocation, now: chrono::DateTime<Utc>) -> WeatherStatus {
        let mut status = self.observations.iter().find(|(cached, _)| cached == location)
            .map(|(_, status)| status.clone()).unwrap_or_else(|| weather::empty(Some(location)));
        weather::expire(&mut status, now);
        status
    }
    fn record(&mut self, location: &WeatherLocation, result: Result<WeatherStatus, ()>, now: chrono::DateTime<Utc>) {
        let status = result.unwrap_or_else(|()| weather::failed(Some(self.snapshot(location, now)), location, now));
        if let Some((_, cached)) = self.observations.iter_mut().find(|(cached, _)| cached == location) { *cached = status; }
        else { self.observations.push((location.clone(), status)); }
    }
}

struct State { config: DesktopConfig, generation: u64, stopped: bool, snapshot: DesktopSnapshot, weather_cache: WeatherCache }
struct Shared { state: Mutex<State>, wake: Condvar }
impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> { self.state.lock().unwrap_or_else(|error| error.into_inner()) }
    fn cancelled(&self, generation: u64) -> bool {
        let state = self.lock();
        state.stopped || state.generation != generation
    }
    fn wait(&self, generation: u64, timeout: Duration) {
        let state = self.lock();
        let _ = self.wake.wait_timeout_while(state, timeout, |state| !state.stopped && state.generation == generation);
    }
    fn publish(&self, generation: u64, update: impl FnOnce(&mut DesktopSnapshot)) {
        let mut state = self.lock();
        if state.stopped || state.generation != generation { return; }
        update(&mut state.snapshot);
        state.snapshot.observed_at = Some(Utc::now().to_rfc3339());
    }
}

pub struct DesktopMonitor { shared: Arc<Shared>, workers: Vec<JoinHandle<()>> }

impl DesktopMonitor {
    pub fn new(config: DesktopConfig) -> Self {
        let snapshot = initial_snapshot(&config);
        let shared = Arc::new(Shared { state: Mutex::new(State { config, generation: 0, stopped: false, snapshot,
            weather_cache: WeatherCache::new(Instant::now()) }), wake: Condvar::new() });
        let mut workers = Vec::new();
        for (name, run) in [("desktop-hardware", hardware_worker as fn(Arc<Shared>)), ("desktop-media", media_worker), ("desktop-weather", weather_worker)] {
            let shared = Arc::clone(&shared);
            if let Ok(worker) = thread::Builder::new().name(name.into()).spawn(move || run(shared)) { workers.push(worker); }
        }
        Self { shared, workers }
    }
    pub fn snapshot(&self) -> DesktopSnapshot {
        let mut snapshot = self.shared.lock().snapshot.clone();
        if let Some(weather) = &mut snapshot.weather { weather::expire(weather, Utc::now()); }
        snapshot
    }
    /// Executa o comando na sessão atual e publica a leitura seguinte sem esperar o poll.
    pub fn media_control(&self, action: MediaAction) -> Result<(), String> {
        let (enabled, generation) = { let state = self.shared.lock(); (state.config.media, state.generation) };
        if !enabled { return Err("Mídia desativada.".into()); }
        #[cfg(windows)]
        {
            if !super::windows::control(action, || self.shared.cancelled(generation)) {
                return Err("O app de mídia não aceitou o comando.".into());
            }
            thread::sleep(Duration::from_millis(180));
            let media = super::windows::media(|| self.shared.cancelled(generation));
            self.shared.publish(generation, |snapshot| snapshot.media = Some(media));
            Ok(())
        }
        #[cfg(not(windows))]
        { let _ = (action, generation); Err("Controle de mídia indisponível.".into()) }
    }

    pub fn set_config(&self, config: DesktopConfig) {
        let mut state = self.shared.lock();
        if state.config == config { return; }
        let previous = state.config.clone();
        if !config.system_info { state.snapshot.cpu_percent = None; state.snapshot.memory = None; state.snapshot.battery = None; }
        if !config.media { state.snapshot.media = None; }
        else if !previous.media { state.snapshot.media = Some(MediaStatus::unavailable()); }
        if !config.weather { state.snapshot.weather = None; }
        else if !previous.weather || previous.location != config.location {
            state.snapshot.weather = Some(config.location.as_ref().filter(|location| location.is_valid())
                .map(|location| state.weather_cache.snapshot(location, Utc::now()))
                .unwrap_or_else(|| weather::empty(config.location.as_ref())));
        }
        state.config = config;
        state.generation = state.generation.wrapping_add(1);
        self.shared.wake.notify_all();
    }
}

impl Drop for DesktopMonitor {
    fn drop(&mut self) {
        self.shared.lock().stopped = true;
        self.shared.wake.notify_all();
        for worker in self.workers.drain(..) { let _ = worker.join(); }
    }
}

fn initial_snapshot(config: &DesktopConfig) -> DesktopSnapshot {
    DesktopSnapshot { media: config.media.then(MediaStatus::unavailable), weather: config.weather.then(|| weather::empty(config.location.as_ref())), ..Default::default() }
}

fn hardware_worker(shared: Arc<Shared>) {
    let mut previous: Option<CpuTimes> = None;
    let mut previous_net: Option<((u64, u64), f64)> = None;
    let started = Instant::now();
    loop {
        let (config, generation) = { let state = shared.lock(); if state.stopped { break; } (state.config.clone(), state.generation) };
        if config.system_info {
            #[cfg(windows)]
            {
                let current = super::windows::cpu_times();
                let cpu = current.and_then(|current| hardware::cpu_percent(previous, current));
                previous = current;
                let memory = super::windows::memory();
                // Leitura barata; a cada volta (1 s) para o carregador aparecer rápido.
                let battery = super::windows::battery();
                let disk = super::windows::disk();
                let net = super::windows::network_octets().map(|octets| (octets, started.elapsed().as_secs_f64()));
                let network = net.and_then(|current| hardware::network_rate(previous_net, current));
                previous_net = net;
                shared.publish(generation, |snapshot| { snapshot.cpu_percent = cpu; snapshot.memory = memory; snapshot.battery = battery; snapshot.disk = disk; snapshot.network = network; });
            }
        } else { previous = None; previous_net = None; }
        shared.wait(generation, Duration::from_secs(1));
    }
}

fn media_worker(shared: Arc<Shared>) {
    loop {
        let (enabled, generation) = { let state = shared.lock(); if state.stopped { break; } (state.config.media, state.generation) };
        if enabled {
            #[cfg(windows)]
            let media = super::windows::media(|| shared.cancelled(generation));
            #[cfg(not(windows))]
            let media = MediaStatus::unavailable();
            shared.publish(generation, |snapshot| snapshot.media = Some(media));
        }
        // Troca de faixa e pausa precisam aparecer rápido no notch.
        shared.wait(generation, Duration::from_millis(1500));
    }
}

fn weather_worker(shared: Arc<Shared>) {
    loop {
        let (config, generation) = { let state = shared.lock(); if state.stopped { break; } (state.config.clone(), state.generation) };
        let location = config.location.as_ref().filter(|location| location.is_valid());
        let poll = if config.weather && location.is_some() {
            let mut state = shared.lock();
            !state.stopped && state.generation == generation && state.weather_cache.begin_poll(Instant::now())
        } else { false };
        if poll {
            let location = location.unwrap();
            let result = weather::fetch(location);
            // Uma alteração de outro módulo não invalida uma consulta já autorizada.
            // Resultados de cidade anterior e de módulos desativados ficam só no cache.
            let mut state = shared.lock();
            state.weather_cache.record(location, result, Utc::now());
            if !state.stopped && state.config.weather && state.config.location.as_ref() == Some(location) {
                state.snapshot.weather = Some(state.weather_cache.snapshot(location, Utc::now()));
                state.snapshot.observed_at = Some(Utc::now().to_rfc3339());
            }
        }
        let delay = if config.weather && location.is_some() {
            shared.lock().weather_cache.next_poll.saturating_duration_since(Instant::now()).max(Duration::from_secs(1))
        } else { weather::POLL_INTERVAL };
        shared.wait(generation, delay);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn weather_reactivation_restores_original_observation_without_new_request() {
        let start = Instant::now();
        let observed: chrono::DateTime<Utc> = "2026-10-28T16:00:00Z".parse().unwrap();
        let location = WeatherLocation { city: "Natal/RN".into(), latitude: -5.795, longitude: -35.20944 };
        let other = WeatherLocation { city: "Recife/PE".into(), latitude: -8.05, longitude: -34.9 };
        let mut cache = WeatherCache::new(start);
        assert!(cache.begin_poll(start));
        cache.record(&location, Ok(WeatherStatus { state: super::super::WeatherState::Ready, city: Some(location.city.clone()),
            temperature_c: Some(29.5), weather_code: Some(2), is_day: Some(true),
            observed_at: Some(observed.to_rfc3339()), source: "Open-Meteo".into() }), observed);
        // Desligar oculta o snapshot, sem apagar a política privada de consulta.
        // Reativar restaura o horário e o valor originais; não reserva outra chamada.
        let restored = cache.snapshot(&location, observed + chrono::Duration::minutes(2));
        assert_eq!(restored.temperature_c, Some(29.5));
        assert_eq!(restored.observed_at, Some(observed.to_rfc3339()));
        assert_eq!(restored.state, super::super::WeatherState::Ready);
        assert!(!cache.begin_poll(start + Duration::from_secs(120)));
        assert!(!cache.begin_poll(start + Duration::from_secs(899)));
        assert_eq!(cache.snapshot(&other, observed).temperature_c, None);
        assert!(cache.begin_poll(start + weather::POLL_INTERVAL));
        cache.record(&other, Err(()), observed + chrono::Duration::minutes(15));
        assert_eq!(cache.snapshot(&other, observed + chrono::Duration::minutes(15)).state, super::super::WeatherState::Unavailable);
        let historical = cache.snapshot(&location, observed + chrono::Duration::minutes(91));
        assert_eq!(historical.state, super::super::WeatherState::Stale);
        assert_eq!(historical.temperature_c, Some(29.5));
        assert_eq!(historical.observed_at, Some(observed.to_rfc3339()));
    }
    #[test]
    fn disabled_modules_have_no_readable_data_and_drop_wakes_workers() {
        let config = DesktopConfig { system_info: false, media: false, weather: false, location: Some(super::super::WeatherLocation { city: "Natal/RN".into(), latitude: -5.795, longitude: -35.20944 }) };
        let monitor = DesktopMonitor::new(DesktopConfig { weather: true, location: None, ..config.clone() });
        let snapshot = monitor.snapshot();
        assert!(snapshot.cpu_percent.is_none() && snapshot.media.is_none());
        assert_eq!(snapshot.weather.unwrap().state, super::super::WeatherState::Unconfigured);
        monitor.set_config(config);
        assert!(monitor.snapshot().media.is_none());
        assert!(monitor.snapshot().weather.is_none());
        let started = Instant::now();
        drop(monitor);
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
