use super::{hardware::{self, CpuTimes}, source_name, BatteryStatus, MediaAction, MediaState, MediaStatus, MemoryStatus};
use std::{thread, time::{Duration, Instant}};
use ::windows::{
    Media::Control::{GlobalSystemMediaTransportControlsSessionManager as SessionManager, GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus},
    Win32::{Foundation::FILETIME, System::{
        Com::{CoInitializeEx, COINIT_MULTITHREADED},
        Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS},
        SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX},
        Threading::GetSystemTimes,
    }, Storage::FileSystem::GetDiskFreeSpaceExW, NetworkManagement::{IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_TABLE2}, Ndis::IfOperStatusUp}},
};

fn filetime(value: FILETIME) -> u64 { ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64 }

pub(super) fn cpu_times() -> Option<CpuTimes> {
    let (mut idle, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
    unsafe { GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)) }.ok()?;
    Some(CpuTimes { idle: filetime(idle), kernel: filetime(kernel), user: filetime(user) })
}

pub(super) fn memory() -> Option<MemoryStatus> {
    let mut value = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    unsafe { GlobalMemoryStatusEx(&mut value) }.ok()?;
    hardware::memory_status(value.ullTotalPhys, value.ullAvailPhys)
}

/// Disco do sistema (geralmente C:). Total e usado, como a memória.
pub(super) fn disk() -> Option<MemoryStatus> {
    let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
    let path: Vec<u16> = format!("{drive}\\").encode_utf16().chain(Some(0)).collect();
    let (mut free, mut total) = (0u64, 0u64);
    unsafe { GetDiskFreeSpaceExW(::windows::core::PCWSTR(path.as_ptr()), None, Some(&mut total), Some(&mut free)) }.ok()?;
    hardware::memory_status(total, free)
}

/// Octetos recebidos e enviados nas interfaces físicas ligadas (sem loopback e túneis).
pub(super) fn network_octets() -> Option<(u64, u64)> {
    let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
    unsafe { GetIfTable2(&mut table) }.ok().ok()?;
    let mut totals = (0u64, 0u64);
    unsafe {
        let rows = std::slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize);
        for row in rows {
            let hardware = row.InterfaceAndOperStatusFlags._bitfield & 1 != 0;
            if hardware && row.OperStatus == IfOperStatusUp && row.Type != 24 {
                totals.0 += row.InOctets; totals.1 += row.OutOctets;
            }
        }
        FreeMibTable(table as *const _);
    }
    Some(totals)
}

pub(super) fn battery() -> Option<BatteryStatus> {
    let mut value = SYSTEM_POWER_STATUS::default();
    unsafe { GetSystemPowerStatus(&mut value) }.ok()?;
    hardware::battery_status(value.ACLineStatus, value.BatteryFlag, value.BatteryLifePercent)
}


// Cada operação WinRT tem prazo; desativação/saída interrompe a espera em até 50 ms.
macro_rules! bounded {
    ($operation:expr, $cancelled:expr) => {{
        let operation = $operation.ok()?;
        let deadline = Instant::now() + Duration::from_secs(2);
        while operation.Status().ok()?.0 == 0 {
            if $cancelled() || Instant::now() >= deadline {
                let _ = operation.Cancel();
                return None;
            }
            thread::sleep(Duration::from_millis(50));
        }
        operation.GetResults().ok()?
    }};
}

pub(super) fn media(cancelled: impl Fn() -> bool) -> MediaStatus {
    read_media(cancelled).unwrap_or_else(MediaStatus::unavailable)
}

/// 100 ns desde 1601 → milissegundos Unix.
fn unix_ms(universal: i64) -> Option<i64> {
    (universal > 116_444_736_000_000_000).then(|| (universal - 116_444_736_000_000_000) / 10_000)
}

type Session = ::windows::Media::Control::GlobalSystemMediaTransportControlsSession;

/// `None`: falha; `Some(None)`: nenhuma sessão de mídia ativa.
/// A sessão "atual" do Windows é a que recebeu foco por último (um vídeo pausado
/// num app qualquer). Preferimos a que está tocando de fato; só sem nenhuma
/// tocando caímos na atual.
fn current_session(cancelled: &impl Fn() -> bool) -> Option<Option<Session>> {
    // O gerenciador de sessões é pedido uma vez por thread e reaproveitado (antes: a cada
    // leitura, de 1,5 em 1,5 s, o dia todo). Falha descarta e pede de novo na próxima.
    let manager = match MANAGER.with(|cached| cached.borrow().clone()) {
        Some(manager) => manager,
        None => {
            let manager = bounded!(SessionManager::RequestAsync(), cancelled);
            MANAGER.with(|cached| *cached.borrow_mut() = Some(manager.clone()));
            manager
        }
    };
    let Ok(sessions) = manager.GetSessions() else { MANAGER.with(|cached| *cached.borrow_mut() = None); return None };
    {
        for session in sessions {
            let playing = session.GetPlaybackInfo().and_then(|info| info.PlaybackStatus()).is_ok_and(|status| status == PlaybackStatus::Playing);
            if playing { return Some(Some(session)); }
        }
    }
    match manager.GetCurrentSession() {
        Ok(session) => Some(Some(session)),
        // windows-core 0.62 representa S_OK + ponteiro nulo por Error::empty().
        Err(error) if error.code().0 == 0 => Some(None),
        Err(_) => None,
    }
}

/// Capa publicada pelo app de mídia, como data URL. Lida quando a faixa muda e relida nos primeiros
/// segundos: o Chrome publica título antes da arte e, no começo, a capa é o ícone do navegador.
static ART: std::sync::Mutex<(String, Option<String>, Option<std::time::Instant>)> = std::sync::Mutex::new((String::new(), None, None));
const ART_SETTLE: std::time::Duration = std::time::Duration::from_secs(10);
const MAX_ART: u32 = 768 * 1024;

pub(super) fn media_art() -> Option<String> { ART.lock().ok().and_then(|art| art.1.clone()) }

pub(crate) fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for index in 0..4 {
            if index <= chunk.len() { out.push(TABLE[(value >> (18 - 6 * index) & 63) as usize] as char); } else { out.push('='); }
        }
    }
    out
}

fn read_art(properties: &::windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties, cancelled: &impl Fn() -> bool) -> Option<String> {
    use ::windows::Storage::Streams::DataReader;
    let reference = properties.Thumbnail().ok()?;
    let stream = bounded!(reference.OpenReadAsync(), cancelled);
    let size = u32::try_from(stream.Size().ok()?).ok().filter(|size| *size > 0 && *size <= MAX_ART)?;
    let kind = stream.ContentType().ok().map(|kind| kind.to_string()).filter(|kind| kind.starts_with("image/")).unwrap_or_else(|| "image/png".into());
    let reader = DataReader::CreateDataReader(&stream).ok()?;
    let loaded = bounded!(reader.LoadAsync(size), cancelled);
    let mut bytes = vec![0u8; loaded as usize];
    reader.ReadBytes(&mut bytes).ok()?;
    Some(format!("data:{kind};base64,{}", base64(&bytes)))
}

thread_local! {
    /// COM fica iniciado na thread de mídia enquanto ela vive (o gerenciador guardado depende dele).
    static COM: bool = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
    static MANAGER: std::cell::RefCell<Option<SessionManager>> = const { std::cell::RefCell::new(None) };
}

fn read_media(cancelled: impl Fn() -> bool) -> Option<MediaStatus> {
    if !COM.with(|ready| *ready) { return None; }
    if cancelled() { return None; }
    let Some(session) = current_session(&cancelled)? else { return Some(MediaStatus::bare(MediaState::Empty)); };
    let info = session.GetPlaybackInfo().ok()?;
    let playback = info.PlaybackStatus().ok()?;
    let state = if playback == PlaybackStatus::Playing { MediaState::Playing }
        else if playback == PlaybackStatus::Paused { MediaState::Paused }
        else { MediaState::Empty };
    if state == MediaState::Empty { return Some(MediaStatus::bare(state)); }
    let properties = bounded!(session.TryGetMediaPropertiesAsync(), cancelled);
    let nonempty = |value: String| if value.trim().is_empty() { None } else { Some(value.chars().take(512).collect()) };
    let mut status = MediaStatus::bare(state);
    status.title = properties.Title().ok().and_then(|value| nonempty(value.to_string()));
    status.artist = properties.Artist().ok().and_then(|value| nonempty(value.to_string()));
    status.source = session.SourceAppUserModelId().ok().and_then(|id| source_name(&id.to_string()));
    // Capa: relida só quando título/artista/app mudam.
    let key = format!("{}|{}|{}", status.title.as_deref().unwrap_or(""), status.artist.as_deref().unwrap_or(""), status.source.as_deref().unwrap_or(""));
    let (fresh, settling) = ART.lock().map(|art| (art.0 != key, art.2.is_some_and(|at| at.elapsed() < ART_SETTLE))).unwrap_or((false, false));
    if fresh || settling {
        let art = read_art(&properties, &cancelled);
        if let Ok(mut slot) = ART.lock() {
            let since = if fresh { Some(std::time::Instant::now()) } else { slot.2 };
            let art = if fresh { art } else { art.or_else(|| slot.1.clone()) };
            *slot = (key.clone(), art, since);
        }
    }
    // A chave muda junto com a arte: a interface busca de novo quando a capa definitiva chega.
    status.art_key = ART.lock().ok().and_then(|art| art.1.as_ref().map(|data| format!("{key}#{}", data.len())));
    if let Ok(controls) = info.Controls() {
        status.can_previous = controls.IsPreviousEnabled().unwrap_or(false);
        status.can_next = controls.IsNextEnabled().unwrap_or(false);
        status.can_toggle = controls.IsPlayPauseToggleEnabled().unwrap_or(false);
    }
    // Apps que não publicam timeline devolvem zeros: sem duração, sem barra.
    if let Ok(timeline) = session.GetTimelineProperties() {
        let span = |value: ::windows::Foundation::TimeSpan| u64::try_from(value.Duration / 10_000).ok();
        let start = timeline.StartTime().ok().and_then(span).unwrap_or(0);
        let end = timeline.EndTime().ok().and_then(span);
        let position = timeline.Position().ok().and_then(span);
        if let (Some(end), Some(position)) = (end, position) {
            if end > start && end - start >= 1_000 {
                status.duration_ms = Some(end - start);
                status.position_ms = Some(position.saturating_sub(start).min(end - start));
                status.position_at_ms = timeline.LastUpdatedTime().ok().and_then(|time| unix_ms(time.UniversalTime));
            }
        }
    }
    Some(status)
}

pub(super) fn control(action: MediaAction, cancelled: impl Fn() -> bool) -> bool {
    let run = || -> Option<bool> {
        if !COM.with(|ready| *ready) { return None; }
        let session = current_session(&cancelled)??;
        Some(match action {
            MediaAction::Toggle => bounded!(session.TryTogglePlayPauseAsync(), cancelled),
            MediaAction::Next => bounded!(session.TrySkipNextAsync(), cancelled),
            MediaAction::Previous => bounded!(session.TrySkipPreviousAsync(), cancelled),
        })
    };
    run().unwrap_or(false)
}

#[cfg(test)]
mod art_tests {
    #[test]
    fn base64_matches_reference() {
        assert_eq!(super::base64(b"Man"), "TWFu");
        assert_eq!(super::base64(b"Ma"), "TWE=");
        assert_eq!(super::base64(b"M"), "TQ==");
    }
}
