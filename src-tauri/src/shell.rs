use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{App, Emitter, Manager, WebviewWindow, WebviewWindowBuilder};
#[cfg(not(windows))]
use tauri::{PhysicalPosition, PhysicalSize};

// Tamanho fixo: comporta o corpo aberto, as asas e o overshoot da mola. A janela
// nunca muda de tamanho durante a interação; fora da forma ela é click-through.
// 430 de altura comporta o Ask expandido (580 × 380) e o overshoot.
const WINDOW_SIZE: (f64, f64) = (680.0, 430.0);
pub const SHELL_OPEN_EVENT: &str = "shell:open";
pub const SHELL_COLLAPSE_EVENT: &str = "shell:collapse";
pub const SHELL_HIDDEN_EVENT: &str = "shell:hidden";
/// Ilha escondida/reexibida por app em tela cheia (payload: bool).
pub const SHELL_OCCLUDED_EVENT: &str = "shell:occluded";
/// Preferência "ocultar em tela cheia", aplicada pelo vigia de monitores.
pub static HIDE_IN_FULLSCREEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

fn island_layout(origin: (i32, i32), area: (u32, u32), scale: f64) -> ((i32, i32), (u32, u32)) {
    let logical = WINDOW_SIZE;
    let width = ((logical.0 * scale).round() as u32).min(area.0);
    let height = ((logical.1 * scale).round() as u32).min(area.1);
    let x = origin.0 + ((area.0 - width) / 2) as i32;
    ((x, origin.1), (width, height))
}

pub fn place_island(window: &WebviewWindow) -> Result<(), String> {
    // Sempre a tela principal do Windows; a tela onde a janela estava pode ter
    // deixado de ser a principal (ou de existir) quando monitores mudam.
    let monitor = match window.primary_monitor() {
        Ok(Some(monitor)) => monitor,
        _ => window.current_monitor().map_err(|error| error.to_string())?
            .ok_or_else(|| "Nenhum monitor está disponível para posicionar a ilha.".to_string())?,
    };
    let area = monitor.work_area();
    let (position, size) = island_layout((area.position.x, monitor.position().y),
        (area.size.width, area.size.height), monitor.scale_factor());
    #[cfg(windows)]
    {
        use ::windows::Win32::{Foundation::HWND, UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER}};
        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        unsafe { SetWindowPos(HWND(hwnd.0), None, position.0, position.1, size.0 as i32, size.1 as i32,
            SWP_NOACTIVATE | SWP_NOZORDER) }.map_err(|error| error.to_string())
    }
    #[cfg(not(windows))]
    {
        window.set_position(PhysicalPosition::new(position.0, position.1)).map_err(|error| error.to_string())?;
        window.set_size(PhysicalSize::new(size.0, size.1)).map_err(|error| error.to_string())
    }
}

/// Conectar, desconectar ou trocar o monitor principal (ou mover a barra de tarefas)
/// não gera evento na janela; compara a tela principal a cada segundo.
pub fn watch_displays(window: WebviewWindow) {
    let spawned = std::thread::Builder::new().name("heydesk-displays".into()).spawn(move || {
        // Lido direto do Win32 nesta thread: `primary_monitor()` do Tauri passa pela
        // thread principal, e isto roda a cada segundo o dia todo.
        #[cfg(windows)]
        // A tela principal sempre começa em (0,0): um monitor novo de mesma resolução e
        // DPI parecia "igual". Por isso entram também o número de monitores e se a ilha
        // está mesmo na tela principal (senão a ilha ficava na tela onde abriu). Entra
        // também onde a janela está: o Windows a move sozinho ao trocar monitores ou
        // voltar da suspensão, e ela ficava fora do centro com a tela "igual".
        let signature = |window: &WebviewWindow| unsafe {
            use ::windows::Win32::{Foundation::{HWND, POINT, RECT}, Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTOPRIMARY},
                UI::{HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI}, WindowsAndMessaging::{GetSystemMetrics, GetWindowRect, SM_CMONITORS}}};
            let monitor = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
            let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
            if !GetMonitorInfoW(monitor, &mut info).as_bool() { return None; }
            let (mut dpi, mut _y) = (0u32, 0u32);
            let _ = GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi, &mut _y);
            let on_primary = window.hwnd().map(|hwnd| MonitorFromWindow(HWND(hwnd.0), MONITOR_DEFAULTTONEAREST) == monitor).unwrap_or(true);
            let mut rect = RECT::default();
            if let Ok(hwnd) = window.hwnd() { let _ = GetWindowRect(HWND(hwnd.0), &mut rect); }
            let (screen, work) = (info.rcMonitor, info.rcWork);
            Some((screen.right, screen.bottom, work.left, work.top, work.right - work.left, work.bottom - work.top, dpi as u64, GetSystemMetrics(SM_CMONITORS), on_primary, (rect.left, rect.top, rect.right - rect.left)))
        };
        #[cfg(not(windows))]
        let signature = |window: &WebviewWindow| window.primary_monitor().ok().flatten().map(|monitor| {
            let area = monitor.work_area();
            let at = window.outer_position().map(|at| (at.x, at.y, 0)).unwrap_or_default();
            (monitor.position().x, monitor.position().y, area.position.x, area.position.y, area.size.width as i32, area.size.height as i32, monitor.scale_factor().to_bits(), 1, true, at)
        });
        let mut last = signature(&window);
        let mut hidden_by_fullscreen = false;
        let mut tick = 0u32;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            tick = tick.wrapping_add(1);
            #[cfg(windows)]
            { hidden_by_fullscreen = follow_fullscreen(&window, hidden_by_fullscreen); }
            if tick % 2 != 0 { continue; }
            let now = signature(&window);
            if now.is_none() || now == last { continue; }
            if let Err(error) = place_island(&window) { eprintln!("[Heydesk] Falha ao reposicionar a ilha: {error}"); }
            // Relê depois de mover: a ilha já está na tela principal.
            last = signature(&window);
        }
    });
    if let Err(error) = spawned { eprintln!("[Heydesk] Falha ao vigiar monitores: {error}"); }
}

/// Jogo, vídeo ou apresentação em tela cheia no monitor principal esconde a ilha;
/// ao sair, ela volta sem roubar foco. Só reexibe o que esta rotina escondeu: a
/// ilha ocultada pelo usuário continua oculta.
#[cfg(windows)]
fn follow_fullscreen(window: &WebviewWindow, hidden: bool) -> bool {
    use ::windows::Win32::{Foundation::{HWND, POINT}, Graphics::Gdi::{MonitorFromPoint, MonitorFromWindow, MONITOR_DEFAULTTONULL, MONITOR_DEFAULTTOPRIMARY},
        UI::{Shell::{SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN},
        WindowsAndMessaging::{GetForegroundWindow, IsWindowVisible, ShowWindow, SW_HIDE, SW_SHOWNOACTIVATE}}};
    let Ok(handle) = window.hwnd() else { return hidden };
    let island = HWND(handle.0);
    let busy = unsafe {
        let state = SHQueryUserNotificationState().unwrap_or_default();
        let fullscreen = state == QUNS_BUSY || state == QUNS_RUNNING_D3D_FULL_SCREEN || state == QUNS_PRESENTATION_MODE;
        let foreground = GetForegroundWindow();
        fullscreen && foreground != island && !foreground.is_invalid()
            && MonitorFromWindow(foreground, MONITOR_DEFAULTTONULL) == MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY)
    };
    let wanted = busy && HIDE_IN_FULLSCREEN.load(std::sync::atomic::Ordering::Relaxed);
    unsafe {
        // O frontend pausa leituras e animações enquanto a ilha está escondida.
        if wanted && !hidden && IsWindowVisible(island).as_bool() { let _ = ShowWindow(island, SW_HIDE); let _ = window.emit(SHELL_OCCLUDED_EVENT, true); return true; }
        if !wanted && hidden { let _ = ShowWindow(island, SW_SHOWNOACTIVATE); let _ = window.emit(SHELL_OCCLUDED_EVENT, false); return false; }
    }
    hidden
}

fn open_island(window: &WebviewWindow) -> tauri::Result<()> {
    window.show()?;
    window.set_focus()?;
    window.emit(SHELL_OPEN_EVENT, ())
}

fn navigation_allowed(url: &tauri::Url) -> bool {
    let local_app = url.port().is_none()
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost")));
    let local_dev = cfg!(debug_assertions) && url.scheme() == "http"
        && url.host_str() == Some("localhost") && url.port() == Some(1420);
    local_app || local_dev
}

pub fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let config = app.config().app.windows.iter().find(|config| config.label == "main")
        .ok_or("A janela principal não está configurada.")?;
    let window = WebviewWindowBuilder::from_config(app, config)?
        .on_navigation(navigation_allowed)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()?;
    place_island(&window).map_err(std::io::Error::other)?;
    let shape = crate::pointer::SharedShape::default();
    app.manage(shape.clone());

    let open = MenuItem::with_id(app, "open", "Abrir", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "Ocultar", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Encerrar", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &hide, &quit])?;
    let mut tray = TrayIconBuilder::new().tooltip("Heydesk").menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let result = match event.id.as_ref() {
                "open" => app.get_webview_window("main").map(|window| open_island(&window)),
                "hide" => app.get_webview_window("main").map(|window| {
                    window.hide()?;
                    window.emit(SHELL_HIDDEN_EVENT, ())
                }),
                "quit" => { app.exit(0); None },
                _ => None,
            };
            if let Some(Err(error)) = result { eprintln!("[Heydesk] Falha na ação da bandeja: {error}"); }
        });
    if let Some(icon) = app.default_window_icon() { tray = tray.icon(icon.clone()); }
    tray.build(app)?;

    // Mostrar sem ativar: a bandeja é a única abertura que solicita foco explicitamente.
    window.set_ignore_cursor_events(true)?;
    window.set_focusable(false)?;
    window.show()?;
    window.set_focusable(true)?;
    watch_displays(window.clone());
    crate::pointer::spawn_monitor(window, shape);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_event_names_follow_the_tauri_transport_contract() {
        for name in [SHELL_OPEN_EVENT, SHELL_COLLAPSE_EVENT, SHELL_HIDDEN_EVENT, crate::pointer::SHELL_POINTER_EVENT] {
            // Contrato externo do Tauri: pontos não são aceitos em nomes de eventos IPC.
            assert!(name.chars().all(|character| character.is_alphanumeric()
                || matches!(character, '-' | '/' | ':' | '_')), "Evento inválido para Tauri: {name}");
        }
        assert_eq!([SHELL_OPEN_EVENT, SHELL_COLLAPSE_EVENT], ["shell:open", "shell:collapse"]);
    }

    #[test]
    fn layout_is_fixed_centered_and_scaled_on_the_target_monitor() {
        let (position, size) = island_layout((-1920, 48), (1920, 1032), 1.5);
        assert_eq!((position, size), ((-1470, 48), (1020, 645)));
        let (position, size) = island_layout((0, 0), (1920, 1080), 1.0);
        assert_eq!((position, size), ((620, 0), (680, 430)));
        let (position, size) = island_layout((40, 10), (320, 240), 1.0);
        assert_eq!((position, size), ((40, 10), (320, 240)));
    }

    #[test]
    fn navigation_only_allows_the_application_and_local_development_origin() {
        for url in ["tauri://localhost/index.html", "http://tauri.localhost/index.html"] {
            assert!(navigation_allowed(&tauri::Url::parse(url).unwrap()));
        }
        for url in ["https://example.com", "file:///C:/secret", "http://tauri.localhost:9000", "http://localhost:9000", "javascript:alert(1)"] {
            assert!(!navigation_allowed(&tauri::Url::parse(url).unwrap()));
        }
        assert_eq!(navigation_allowed(&tauri::Url::parse("http://localhost:1420").unwrap()), cfg!(debug_assertions));
    }
}
