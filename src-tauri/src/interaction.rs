//! Sinais locais efêmeros para o mascote. Não captura teclas nem persiste posições.
use serde::Serialize;
use tauri::WebviewWindow;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionSnapshot { idle_ms: Option<u64>, look: Option<Look> }
#[derive(Serialize)]
pub struct Look { x: f64, y: f64 }

fn look_for_cursor(cursor: (i32, i32), origin: (i32, i32), width: u32, scale: f64) -> Option<Look> {
    if !scale.is_finite() || scale <= 0.0 || width == 0 { return None; }
    let center = origin.0 as f64 + width as f64 / 2.0;
    Some(Look { x: ((cursor.0 as f64 - center) / (60.0 * scale)).clamp(-3.5, 3.5),
        y: ((cursor.1 as f64 - origin.1 as f64) / (80.0 * scale)).clamp(-1.0, 2.0) })
}

pub fn snapshot(window: &WebviewWindow) -> InteractionSnapshot {
    #[cfg(windows)]
    {
        use ::windows::Win32::{Foundation::POINT, System::SystemInformation::GetTickCount,
            UI::{Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO}, WindowsAndMessaging::GetCursorPos}};
        let mut last = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, ..Default::default() };
        let idle_ms = unsafe { GetLastInputInfo(&mut last) }.as_bool()
            .then(|| unsafe { GetTickCount() }.wrapping_sub(last.dwTime) as u64);
        let mut cursor = POINT::default();
        let look = if unsafe { GetCursorPos(&mut cursor) }.is_ok() {
            window.outer_position().ok().zip(window.inner_size().ok()).zip(window.scale_factor().ok())
                .and_then(|((origin, size), scale)| look_for_cursor((cursor.x,cursor.y), (origin.x,origin.y),size.width,scale))
        } else { None };
        InteractionSnapshot { idle_ms, look }
    }
    #[cfg(not(windows))]
    { let _ = window; InteractionSnapshot { idle_ms: None, look: None } }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gaze_is_relative_to_window_and_clamped_without_exposing_screen_coordinates() {
        let middle = look_for_cursor((960, 15), (850,0),220,1.0).unwrap();
        assert_eq!(middle.x,0.0); assert_eq!(middle.y,0.1875);
        let far = look_for_cursor((-1900, 900),(850,0),220,1.0).unwrap();
        assert_eq!(far.x,-3.5); assert_eq!(far.y,2.0);
        let scaled = look_for_cursor((0,-1200),(-1920,-1080),440,2.0).unwrap();
        assert_eq!(scaled.x,3.5); assert_eq!(scaled.y,-0.75);
        assert!(look_for_cursor((0,0),(0,0),220,0.0).is_none());
    }
}
