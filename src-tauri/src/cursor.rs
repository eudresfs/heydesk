// Realce de cursor e cliques para gravações: uma janela transparente, sem cliques,
// cobre o monitor principal; esta thread manda a posição do cursor e o estado dos
// botões para ela (~60 vezes por segundo) enquanto está aberta.
use serde::Serialize;
use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
use tauri::{AppHandle, Emitter, Manager};

pub const LABEL: &str = "cursor";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Pointer { x: i32, y: i32, left: bool, right: bool }

#[derive(Default)]
pub struct CursorOverlay { running: Arc<AtomicBool> }

impl CursorOverlay {
    pub fn show(&self, app: &AppHandle, show: bool) -> Result<(), String> {
        if !show {
            self.running.store(false, Ordering::Relaxed);
            if let Some(window) = app.get_webview_window(LABEL) { window.close().map_err(|error| error.to_string())?; }
            return Ok(());
        }
        if app.get_webview_window(LABEL).is_some() { return Ok(()); }
        let monitor = app.primary_monitor().ok().flatten().ok_or("Monitor principal não encontrado.")?;
        let (scale, size) = (monitor.scale_factor(), monitor.size());
        let window = tauri::WebviewWindowBuilder::new(app, LABEL, tauri::WebviewUrl::App("index.html?view=cursor".into()))
            .title("Realce do cursor").position(0.0, 0.0).inner_size(size.width as f64 / scale, size.height as f64 / scale)
            .decorations(false).transparent(true).always_on_top(true).skip_taskbar(true).resizable(false).shadow(false).focused(false)
            .build().map_err(|error| error.to_string())?;
        // Uma janela sempre por cima do tamanho exato do monitor parece app em tela cheia
        // e o Windows esconde a barra de tarefas; 1 px a menos evita isso.
        let _ = window.set_size(tauri::PhysicalSize::new(size.width, size.height.saturating_sub(1)));
        window.set_ignore_cursor_events(true).map_err(|error| error.to_string())?;
        let _ = window.set_focusable(false);
        self.running.store(true, Ordering::Relaxed);
        let (running, app) = (self.running.clone(), app.clone());
        std::thread::Builder::new().name("heydesk-cursor".into()).spawn(move || {
            let mut last: Option<(i32, i32, bool, bool)> = None;
            while running.load(Ordering::Relaxed) {
                if let Some(now) = sample() {
                    if last != Some(now) { let _ = app.emit_to(LABEL, "cursor:pointer", Pointer { x: now.0, y: now.1, left: now.2, right: now.3 }); last = Some(now); }
                }
                std::thread::sleep(std::time::Duration::from_millis(16));
            }
        }).map_err(|error| error.to_string())?;
        Ok(())
    }
}

#[cfg(windows)]
fn sample() -> Option<(i32, i32, bool, bool)> {
    use ::windows::Win32::{Foundation::POINT, UI::{Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON}, WindowsAndMessaging::GetCursorPos}};
    let mut point = POINT::default();
    unsafe {
        GetCursorPos(&mut point).ok()?;
        let down = |key: i32| (GetAsyncKeyState(key) as u16 & 0x8000) != 0;
        Some((point.x, point.y, down(VK_LBUTTON.0 as i32), down(VK_RBUTTON.0 as i32)))
    }
}
#[cfg(not(windows))]
fn sample() -> Option<(i32, i32, bool, bool)> { None }
