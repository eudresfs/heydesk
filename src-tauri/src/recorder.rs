// Gravação de tela com o FFmpeg instalado na máquina (winget: Gyan.FFmpeg).
// Vídeo: Windows Graphics Capture (filtro gfxcapture, FFmpeg 8+) no monitor principal
// ou na janela escolhida; é pela GPU e não trava com janelas transparentes (bolha de
// câmera, realce). Sem gfxcapture: gdigrab (ddagrab falha em notebooks com duas GPUs).
// Áudio: microfone (dshow) e áudio do sistema (WASAPI loopback, enviado ao FFmpeg
// por pipe nomeado). Pausar = fechar o segmento atual; parar = juntar os segmentos
// num MP4 em Vídeos\Heydesk.
use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

pub const STATE_EVENT: &str = "recorder:state";
#[cfg(windows)]
const NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities { pub ffmpeg: Option<String>, pub encoder: Option<String>, pub microphones: Vec<String>, pub windows: Vec<String> }

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    /// "screen" ou "window"
    pub source: String,
    pub window: Option<String>,
    pub microphone: Option<String>,
    pub system_audio: bool,
    pub fps: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecorderState {
    /// "idle" | "recording" | "paused" | "saving" | "error"
    pub state: String,
    /// Tempo gravado (sem pausas) até `at`.
    pub elapsed_ms: u64,
    pub at: i64,
    pub last_file: Option<String>,
    pub error: Option<String>,
}

fn now_ms() -> i64 { chrono::Utc::now().timestamp_millis() }

/// O notch (com o teleprompter) não aparece no vídeo: o Windows o tira das capturas.
fn hide_from_capture(app: &AppHandle, hidden: bool) {
    #[cfg(windows)]
    {
        use tauri::Manager;
        use ::windows::Win32::{Foundation::HWND, UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE}};
        if let Some(Ok(hwnd)) = app.get_webview_window("main").map(|window| window.hwnd()) {
            let _ = unsafe { SetWindowDisplayAffinity(HWND(hwnd.0), if hidden { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE }) };
        }
    }
    #[cfg(not(windows))]
    { let _ = (app, hidden); }
}

fn command(program: &Path) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.creation_flags(NO_WINDOW); }
    command
}

/// FFmpeg no PATH ou no atalho do winget.
pub fn find_ffmpeg() -> Option<PathBuf> {
    static FOUND: OnceLock<Option<PathBuf>> = OnceLock::new();
    FOUND.get_or_init(|| {
        let mut candidates: Vec<PathBuf> = std::env::var_os("PATH").map(|path| std::env::split_paths(&path).map(|dir| dir.join("ffmpeg.exe")).collect()).unwrap_or_default();
        if let Some(local) = std::env::var_os("LOCALAPPDATA") { candidates.push(PathBuf::from(local).join("Microsoft").join("WinGet").join("Links").join("ffmpeg.exe")); }
        candidates.into_iter().find(|path| path.is_file())
    }).clone()
}

/// Primeiro codificador H.264 que funciona: GPU (NVIDIA, AMD, Intel) e, por último, x264.
pub fn encoder(ffmpeg: &Path) -> String {
    static CHOSEN: OnceLock<String> = OnceLock::new();
    CHOSEN.get_or_init(|| {
        for candidate in ["h264_nvenc", "h264_amf", "h264_qsv"] {
            let ok = command(ffmpeg).args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=0.2", "-c:v", candidate, "-f", "null", "-"])
                .stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|status| status.success());
            if ok { return candidate.to_string(); }
        }
        "libx264".to_string()
    }).clone()
}

/// Microfones que o DirectShow enxerga (nome exato para o FFmpeg). Listar abre um
/// FFmpeg (~0,5 s), então a lista vale por 30 s entre aberturas das opções.
pub fn microphones(ffmpeg: &Path) -> Vec<String> {
    static CACHE: Mutex<Option<(Instant, Vec<String>)>> = Mutex::new(None);
    if let Ok(cache) = CACHE.lock() { if let Some((at, list)) = cache.as_ref() { if at.elapsed() < Duration::from_secs(30) { return list.clone(); } } }
    let list = list_microphones(ffmpeg);
    if let Ok(mut cache) = CACHE.lock() { *cache = Some((Instant::now(), list.clone())); }
    list
}
fn list_microphones(ffmpeg: &Path) -> Vec<String> {
    let output = command(ffmpeg).args(["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"]).stdout(Stdio::null()).stderr(Stdio::piped()).output();
    let Ok(output) = output else { return Vec::new() };
    parse_devices(&String::from_utf8_lossy(&output.stderr))
}
pub(crate) fn parse_devices(log: &str) -> Vec<String> {
    log.lines().filter(|line| line.trim_end().ends_with("(audio)")).filter_map(|line| {
        let start = line.find('"')? + 1;
        let end = start + line[start..].find('"')?;
        Some(line[start..end].to_string())
    }).collect()
}

/// Janelas visíveis com título (para gravar só uma janela).
pub fn windows() -> Vec<String> {
    #[cfg(windows)]
    unsafe {
        use ::windows::Win32::{Foundation::{HWND, LPARAM}, UI::WindowsAndMessaging::{EnumWindows, GetWindowTextLengthW, GetWindowTextW, IsIconic, IsWindowVisible, GetWindowLongW, GWL_EXSTYLE, WS_EX_TOOLWINDOW}};
        unsafe extern "system" fn each(hwnd: HWND, data: LPARAM) -> ::windows::core::BOOL {
            let list = unsafe { &mut *(data.0 as *mut Vec<String>) };
            let visible = unsafe { IsWindowVisible(hwnd).as_bool() && !IsIconic(hwnd).as_bool() } && unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) } as u32 & WS_EX_TOOLWINDOW.0 == 0;
            let length = unsafe { GetWindowTextLengthW(hwnd) };
            if visible && length > 0 {
                let mut buffer = vec![0u16; length as usize + 1];
                let read = unsafe { GetWindowTextW(hwnd, &mut buffer) };
                let title = String::from_utf16_lossy(&buffer[..read as usize]);
                if !title.trim().is_empty() && title != "Heydesk" && title != "Program Manager" && !list.contains(&title) { list.push(title); }
            }
            true.into()
        }
        let mut list: Vec<String> = Vec::new();
        let _ = EnumWindows(Some(each), LPARAM(&mut list as *mut _ as isize));
        list.truncate(40);
        list
    }
    #[cfg(not(windows))]
    { Vec::new() }
}

pub fn capabilities() -> Capabilities {
    let Some(ffmpeg) = find_ffmpeg() else { return Capabilities { windows: windows(), ..Default::default() } };
    Capabilities { encoder: Some(encoder(&ffmpeg)), microphones: microphones(&ffmpeg), windows: windows(), ffmpeg: Some(ffmpeg.to_string_lossy().to_string()) }
}

/// Tamanho do monitor principal em pixels físicos (ele começa sempre em 0,0).
pub(crate) fn primary_size() -> (i32, i32) {
    #[cfg(all(windows, not(test)))]
    unsafe {
        use ::windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
        let size = (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN));
        if size.0 > 0 && size.1 > 0 { return size; }
    }
    (1920, 1080)
}

/// Como capturar o vídeo: gdigrab (antigo, lento com janelas transparentes) ou
/// Windows Graphics Capture (monitor principal ou a janela pelo HWND).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Capture { Gdi, Wgc(Option<u64>) }

/// O FFmpeg instalado tem o filtro gfxcapture?
fn has_gfxcapture(ffmpeg: &Path) -> bool {
    static FOUND: OnceLock<bool> = OnceLock::new();
    *FOUND.get_or_init(|| command(ffmpeg).args(["-hide_banner", "-filters"]).stderr(Stdio::null()).output()
        .is_ok_and(|output| String::from_utf8_lossy(&output.stdout).contains(" gfxcapture ")))
}

/// HWND da janela com este título exato.
fn window_handle(title: &str) -> Option<u64> {
    #[cfg(windows)]
    unsafe {
        use ::windows::{core::{HSTRING, PCWSTR}, Win32::UI::WindowsAndMessaging::FindWindowW};
        return FindWindowW(PCWSTR::null(), &HSTRING::from(title)).ok().filter(|hwnd| !hwnd.is_invalid()).map(|hwnd| hwnd.0 as u64);
    }
    #[cfg(not(windows))]
    { let _ = title; None }
}

/// A captura pela GPU funciona nesta máquina? (driver básico, VM ou área de trabalho
/// remota podem falhar). Tira um quadro de teste; o sucesso fica guardado, a falha
/// é testada de novo na próxima gravação.
fn gfxcapture_works(ffmpeg: &Path) -> bool {
    static WORKS: AtomicBool = AtomicBool::new(false);
    if WORKS.load(Ordering::Relaxed) { return true; }
    let Ok(mut probe) = command(ffmpeg).args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "gfxcapture=monitor_idx=0,hwdownload,format=bgra", "-frames:v", "1", "-f", "null", "-"])
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() else { return false };
    let deadline = Instant::now() + Duration::from_millis(2500);
    let ok = loop {
        match probe.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(40)),
            _ => { let _ = probe.kill(); let _ = probe.wait(); break false; }
        }
    };
    if ok { WORKS.store(true, Ordering::Relaxed); }
    ok
}

fn capture_for(ffmpeg: &Path, options: &Options) -> Capture {
    if !has_gfxcapture(ffmpeg) || !gfxcapture_works(ffmpeg) { return Capture::Gdi; }
    match options.window.as_deref().filter(|title| options.source == "window" && !title.is_empty()) {
        Some(title) => window_handle(title).map(|hwnd| Capture::Wgc(Some(hwnd))).unwrap_or(Capture::Gdi),
        None => Capture::Wgc(None),
    }
}

/// Argumentos do FFmpeg para um segmento.
pub(crate) fn segment_args(options: &Options, capture: Capture, encoder: &str, pipe: Option<(&str, u32, u16, bool)>, output: &Path) -> Vec<String> {
    // 60 fps só com captura e codificação pela placa de vídeo; sem codificador de GPU
    // (x264 na CPU) ou com gdigrab, 30 fps para não travar em máquinas modestas.
    let software = encoder == "libx264";
    let rate = options.fps.unwrap_or(if capture == Capture::Gdi || software { 30 } else { 60 }).clamp(10, 60);
    let fps = rate.to_string();
    let mut args: Vec<String> = ["-hide_banner", "-loglevel", "warning", "-y"].iter().map(|s| s.to_string()).collect();
    let mut push = |items: &[&str]| args.extend(items.iter().map(|s| s.to_string()));
    let window = options.window.as_deref().filter(|title| options.source == "window" && !title.is_empty());
    match (capture, window) {
        (Capture::Wgc(hwnd), _) => {
            let source = hwnd.map(|hwnd| format!("hwnd={hwnd}")).unwrap_or_else(|| "monitor_idx=0".into());
            push(&["-thread_queue_size", "512", "-f", "lavfi", "-i", &format!("gfxcapture={source}:max_framerate={fps},hwdownload,format=bgra,fps={fps}")]);
        }
        (Capture::Gdi, Some(title)) => push(&["-thread_queue_size", "512", "-f", "gdigrab", "-framerate", &fps, "-draw_mouse", "1", "-i", &format!("title={title}")]),
        (Capture::Gdi, None) => { let (width, height) = primary_size(); push(&["-thread_queue_size", "512", "-f", "gdigrab", "-framerate", &fps, "-draw_mouse", "1", "-offset_x", "0", "-offset_y", "0", "-video_size", &format!("{width}x{height}"), "-i", "desktop"]) }
    }
    let mut audio = 0;
    if let Some(mic) = options.microphone.as_deref().filter(|mic| !mic.is_empty()) {
        push(&["-thread_queue_size", "1024", "-f", "dshow", "-audio_buffer_size", "50", "-i", &format!("audio={mic}")]);
        audio += 1;
    }
    if let Some((pipe, rate, channels, float)) = pipe {
        push(&["-thread_queue_size", "1024", "-f", if float { "f32le" } else { "s16le" }, "-ar", &rate.to_string(), "-ac", &channels.to_string(), "-i", pipe]);
        audio += 1;
    }
    // Largura e altura pares (exigência do H.264).
    push(&["-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=nv12"]);
    match audio {
        2 => push(&["-filter_complex", "[1:a][2:a]amix=inputs=2:duration=longest:normalize=0[a]", "-map", "0:v", "-map", "[a]"]),
        1 => push(&["-map", "0:v", "-map", "1:a"]),
        _ => push(&["-map", "0:v"]),
    }
    match encoder {
        "libx264" => push(&["-c:v", "libx264", "-preset", if rate > 30 { "ultrafast" } else { "veryfast" }, "-crf", "23"]),
        other => push(&["-c:v", other, "-b:v", if rate > 30 { "12M" } else { "8M" }]),
    }
    if audio > 0 { push(&["-c:a", "aac", "-b:a", "160k"]); }
    args.push(output.to_string_lossy().to_string());
    args
}

struct Segment { child: Child, audio_stop: Option<Arc<AtomicBool>> }
struct Session { options: Options, encoder: String, ffmpeg: PathBuf, dir: PathBuf, parts: Vec<PathBuf>, segment: Option<Segment>, recorded: Duration, since: Option<Instant>, output: PathBuf }

#[derive(Default)]
pub struct Recorder { session: Mutex<Option<Session>>, state: Mutex<RecorderState> }

impl Recorder {
    pub fn state(&self) -> RecorderState { self.state.lock().map(|state| state.clone()).unwrap_or_default() }
    fn publish(&self, app: &AppHandle, update: impl FnOnce(&mut RecorderState)) {
        if let Ok(mut state) = self.state.lock() { update(&mut state); state.at = now_ms(); let _ = app.emit(STATE_EVENT, state.clone()); }
    }
    fn elapsed(session: &Session) -> u64 { (session.recorded + session.since.map(|since| since.elapsed()).unwrap_or_default()).as_millis() as u64 }

    pub fn start(&self, app: &AppHandle, options: Options) -> Result<RecorderState, String> {
        let mut slot = self.session.lock().map_err(|_| "Gravador indisponível.".to_string())?;
        if slot.is_some() { return Err("Já existe uma gravação.".into()); }
        let ffmpeg = find_ffmpeg().ok_or("FFmpeg não encontrado. Instale com: winget install Gyan.FFmpeg")?;
        if options.source != "screen" && options.source != "window" { return Err("Fonte inválida.".into()); }
        let videos = std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join("Videos").join("Heydesk")).ok_or("Pasta de vídeos não encontrada.")?;
        std::fs::create_dir_all(&videos).map_err(|error| error.to_string())?;
        let stamp = chrono::Local::now().format("%Y-%m-%d %H-%M-%S");
        let output = videos.join(format!("Gravação {stamp}.mp4"));
        let dir = std::env::temp_dir().join(format!("heydesk-rec-{}", now_ms()));
        std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        let mut session = Session { encoder: encoder(&ffmpeg), options, ffmpeg, dir, parts: Vec::new(), segment: None, recorded: Duration::ZERO, since: None, output };
        hide_from_capture(app, true);
        if let Err(error) = start_segment(&mut session) { hide_from_capture(app, false); return Err(error); }
        *slot = Some(session);
        drop(slot);
        self.publish(app, |state| { state.state = "recording".into(); state.elapsed_ms = 0; state.error = None; });
        Ok(self.state())
    }

    pub fn pause(&self, app: &AppHandle) -> Result<RecorderState, String> {
        let mut slot = self.session.lock().map_err(|_| "Gravador indisponível.".to_string())?;
        let session = slot.as_mut().ok_or("Nada gravando.")?;
        if session.segment.is_none() { return Ok(self.state()); }
        stop_segment(session)?;
        let elapsed = Self::elapsed(session);
        drop(slot);
        self.publish(app, |state| { state.state = "paused".into(); state.elapsed_ms = elapsed; });
        Ok(self.state())
    }

    pub fn resume(&self, app: &AppHandle) -> Result<RecorderState, String> {
        let mut slot = self.session.lock().map_err(|_| "Gravador indisponível.".to_string())?;
        let session = slot.as_mut().ok_or("Nada gravando.")?;
        if session.segment.is_some() { return Ok(self.state()); }
        start_segment(session)?;
        let elapsed = Self::elapsed(session);
        drop(slot);
        self.publish(app, |state| { state.state = "recording".into(); state.elapsed_ms = elapsed; });
        Ok(self.state())
    }

    /// Fecha o segmento e junta tudo num MP4 (em segundo plano: pode levar alguns segundos).
    pub fn stop(self: &Arc<Self>, app: &AppHandle) -> Result<RecorderState, String> {
        let mut session = self.session.lock().map_err(|_| "Gravador indisponível.".to_string())?.take().ok_or("Nada gravando.")?;
        if session.segment.is_some() { stop_segment(&mut session)?; }
        hide_from_capture(app, false);
        let elapsed = Self::elapsed(&session);
        self.publish(app, |state| { state.state = "saving".into(); state.elapsed_ms = elapsed; });
        let (recorder, app) = (self.clone(), app.clone());
        std::thread::spawn(move || {
            let result = finish(&session);
            let _ = std::fs::remove_dir_all(&session.dir);
            recorder.publish(&app, |state| match result {
                Ok(()) => { state.state = "idle".into(); state.last_file = Some(session.output.to_string_lossy().to_string()); state.error = None; }
                Err(error) => { state.state = "error".into(); state.error = Some(error); }
            });
        });
        Ok(self.state())
    }
}

fn start_segment(session: &mut Session) -> Result<(), String> {
    let part = session.dir.join(format!("parte-{:03}.mkv", session.parts.len()));
    let (pipe, audio_stop) = if session.options.system_audio {
        let (name, rate, channels, float, stop) = loopback::start(session.parts.len()).map_err(|error| format!("Áudio do sistema indisponível: {error}"))?;
        (Some((name, rate, channels, float)), Some(stop))
    } else { (None, None) };
    let args = segment_args(&session.options, capture_for(&session.ffmpeg, &session.options), &session.encoder, pipe.as_ref().map(|(name, rate, channels, float)| (name.as_str(), *rate, *channels, *float)), &part);
    let log = std::fs::File::create(session.dir.join(format!("ffmpeg-{:03}.log", session.parts.len()))).map_err(|error| error.to_string())?;
    let child = command(&session.ffmpeg).args(&args).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(log).spawn()
        .map_err(|error| { if let Some(stop) = &audio_stop { stop.store(true, Ordering::Relaxed); } format!("Não foi possível iniciar o FFmpeg: {error}") })?;
    session.parts.push(part);
    session.segment = Some(Segment { child, audio_stop });
    session.since = Some(Instant::now());
    Ok(())
}

/// Pede ao FFmpeg para encerrar ("q"), o que fecha o arquivo corretamente.
fn stop_segment(session: &mut Session) -> Result<(), String> {
    let Some(mut segment) = session.segment.take() else { return Ok(()) };
    if let Some(since) = session.since.take() { session.recorded += since.elapsed(); }
    if let Some(stdin) = segment.child.stdin.as_mut() { let _ = stdin.write_all(b"q"); let _ = stdin.flush(); }
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        match segment.child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(40)),
            _ => { let _ = segment.child.kill(); let _ = segment.child.wait(); break; }
        }
    }
    if let Some(stop) = segment.audio_stop { stop.store(true, Ordering::Relaxed); }
    Ok(())
}

fn finish(session: &Session) -> Result<(), String> {
    let parts: Vec<&PathBuf> = session.parts.iter().filter(|part| part.metadata().is_ok_and(|meta| meta.len() > 1024)).collect();
    if parts.is_empty() {
        let log = std::fs::read_to_string(session.dir.join("ffmpeg-000.log")).unwrap_or_default();
        return Err(format!("A gravação ficou vazia. {}", log.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or("")));
    }
    let list = session.dir.join("partes.txt");
    let body: String = parts.iter().map(|part| format!("file '{}'\n", part.to_string_lossy().replace('\'', "'\\''"))).collect();
    std::fs::write(&list, body).map_err(|error| error.to_string())?;
    let status = command(&session.ffmpeg).args(["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i"]).arg(&list)
        .args(["-c", "copy", "-movflags", "+faststart"]).arg(&session.output).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|error| error.to_string())?;
    if !status.success() { return Err("Não foi possível juntar a gravação.".into()); }
    Ok(())
}

/// Áudio do sistema: WASAPI em loopback do alto-falante padrão, escrito em tempo real num
/// pipe nomeado que o FFmpeg lê. Sem som tocando, escreve silêncio para manter o ritmo.
#[cfg(windows)]
mod loopback {
    use super::*;
    use ::windows::{core::HSTRING, Win32::{Foundation::{CloseHandle, HANDLE}, Media::Audio::*, Storage::FileSystem::{WriteFile, PIPE_ACCESS_OUTBOUND}, System::{Com::*, Pipes::*}}};

    struct SendHandle(HANDLE);
    unsafe impl Send for SendHandle {}

    pub fn start(index: usize) -> Result<(String, u32, u16, bool, Arc<AtomicBool>), String> {
        let name = format!(r"\\.\pipe\heydesk-audio-{}-{index}", std::process::id());
        let pipe = unsafe { CreateNamedPipeW(&HSTRING::from(&name), PIPE_ACCESS_OUTBOUND, PIPE_TYPE_BYTE | PIPE_WAIT, 1, 1 << 20, 0, 0, None) };
        if pipe.is_invalid() { return Err("pipe".into()); }
        // Lê o formato antes de devolver, para o FFmpeg saber a taxa e os canais.
        let (rate, channels, float) = mix_format().map_err(|error| error.to_string())?;
        let stop = Arc::new(AtomicBool::new(false));
        let (flag, handle) = (stop.clone(), SendHandle(pipe));
        std::thread::Builder::new().name("heydesk-loopback".into()).spawn(move || {
            let handle = handle;
            let _ = unsafe { ConnectNamedPipe(handle.0, None) };
            if let Err(error) = capture(handle.0, &flag) { eprintln!("[Heydesk] loopback: {error}"); }
            unsafe { let _ = CloseHandle(handle.0); }
        }).map_err(|error| error.to_string())?;
        Ok((name, rate, channels, float, stop))
    }

    fn client() -> ::windows::core::Result<IAudioClient> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?.Activate::<IAudioClient>(CLSCTX_ALL, None)
        }
    }
    fn mix_format() -> ::windows::core::Result<(u32, u16, bool)> {
        unsafe {
            let format = client()?.GetMixFormat()?;
            let info = (*format).clone();
            CoTaskMemFree(Some(format as *const _));
            Ok((info.nSamplesPerSec, info.nChannels, info.wBitsPerSample == 32))
        }
    }

    fn capture(pipe: HANDLE, stop: &AtomicBool) -> ::windows::core::Result<()> {
        unsafe {
            let client = client()?;
            let format = client.GetMixFormat()?;
            let (rate, block) = ((*format).nSamplesPerSec as u64, (*format).nBlockAlign as usize);
            client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 2_000_000, 0, format, None)?;
            CoTaskMemFree(Some(format as *const _));
            let capture: IAudioCaptureClient = client.GetService()?;
            client.Start()?;
            let started = Instant::now();
            let mut written: u64 = 0;
            let write = |bytes: &[u8]| -> bool { WriteFile(pipe, Some(bytes), None, None).is_ok() };
            while !stop.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(10));
                loop {
                    let frames = capture.GetNextPacketSize()?;
                    if frames == 0 { break; }
                    let (mut data, mut count, mut flags) = (std::ptr::null_mut(), 0u32, 0u32);
                    capture.GetBuffer(&mut data, &mut count, &mut flags, None, None)?;
                    let size = count as usize * block;
                    let ok = if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() { write(&vec![0u8; size]) } else { write(std::slice::from_raw_parts(data, size)) };
                    capture.ReleaseBuffer(count)?;
                    if !ok { client.Stop()?; return Ok(()); }
                    written += count as u64;
                }
                // Sem pacotes (nada tocando): completa com silêncio até o relógio.
                let expected = started.elapsed().as_micros() as u64 * rate / 1_000_000;
                if expected > written + rate / 20 {
                    let gap = (expected - written) as usize;
                    if !write(&vec![0u8; gap * block]) { break; }
                    written += gap as u64;
                }
            }
            client.Stop()?;
            Ok(())
        }
    }
}
#[cfg(not(windows))]
mod loopback {
    use super::*;
    pub fn start(_: usize) -> Result<(String, u32, u16, bool, Arc<AtomicBool>), String> { Err("só no Windows".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_dshow_audio_devices() {
        let log = "[in#0 @ 0x1] \"Integrated Webcam\" (video)\n[in#0 @ 0x1]   Alternative name \"@device_pnp\"\n[in#0 @ 0x1] \"Microfone (Realtek(R) Audio)\" (audio)\n";
        assert_eq!(parse_devices(log), vec!["Microfone (Realtek(R) Audio)".to_string()]);
    }
    #[test]
    fn segment_args_mix_mic_and_system_audio() {
        let options = Options { source: "screen".into(), window: None, microphone: Some("Mic".into()), system_audio: true, fps: Some(30) };
        let args = segment_args(&options, Capture::Gdi, "h264_qsv", Some((r"\\.\pipe\x", 48_000, 2, true)), Path::new("out.mkv"));
        let joined = args.join(" ");
        assert!(joined.contains("-f gdigrab -framerate 30 -draw_mouse 1 -offset_x 0 -offset_y 0 -video_size 1920x1080 -i desktop"));
        assert!(joined.contains("-f dshow -audio_buffer_size 50 -i audio=Mic"));
        assert!(joined.contains(r"-f f32le -ar 48000 -ac 2 -i \\.\pipe\x"));
        assert!(joined.contains("amix=inputs=2"));
        assert!(joined.ends_with("-c:a aac -b:a 160k out.mkv"));
        let window = Options { source: "window".into(), window: Some("Bloco de Notas".into()), microphone: None, system_audio: false, fps: None };
        let joined = segment_args(&window, Capture::Gdi, "libx264", None, Path::new("o.mkv")).join(" ");
        assert!(joined.contains("-f gdigrab -framerate 30 -draw_mouse 1 -i title=Bloco de Notas"));
        assert!(joined.contains("-map 0:v -c:v libx264"));
        let joined = segment_args(&options, Capture::Wgc(None), "h264_qsv", None, Path::new("o.mkv")).join(" ");
        assert!(joined.contains("-f lavfi -i gfxcapture=monitor_idx=0:max_framerate=30,hwdownload,format=bgra,fps=30"));
        let joined = segment_args(&window, Capture::Wgc(Some(42)), "h264_qsv", None, Path::new("o.mkv")).join(" ");
        assert!(joined.contains("-i gfxcapture=hwnd=42:max_framerate=60,"));
        assert!(joined.contains("-b:v 12M"));
        let joined = segment_args(&options, Capture::Wgc(None), "libx264", None, Path::new("o.mkv")).join(" ");
        assert!(joined.contains("max_framerate=30,") && joined.contains("-preset veryfast"), "sem GPU: 30 fps");
    }
}
