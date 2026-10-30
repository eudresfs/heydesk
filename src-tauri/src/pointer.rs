//! Hit-test nativo da ilha. A janela tem tamanho fixo e transparente; só a forma
//! preta recebe o mouse. Fora dela a janela ignora o cursor (click-through), então
//! o hover não pode vir do DOM: este monitor amostra o cursor e publica a transição.
use std::sync::{Arc, Mutex};
use serde::Deserialize;
use tauri::{Emitter, WebviewWindow};

pub const SHELL_POINTER_EVENT: &str = "shell:pointer";
/// Histerese de saída em pixels lógicos, igual à do frontend.
const EXIT_MARGIN: f64 = 3.0;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub struct HitShape { pub width: f64, pub height: f64, pub radius: f64, pub wing: f64 }

impl HitShape {
    pub const COMPACT: HitShape = HitShape { width: 220.0, height: 32.0, radius: 15.0, wing: 10.0 };

    /// Rejeita valores que não descrevem uma ilha dentro da janela fixa.
    pub fn validated(self) -> Result<HitShape, String> {
        let finite = [self.width, self.height, self.radius, self.wing].iter().all(|value| value.is_finite() && *value >= 0.0);
        if !finite || self.width > 680.0 || self.height > 440.0 || self.radius > 80.0 || self.wing > 40.0 {
            return Err("Forma da ilha inválida.".into());
        }
        Ok(self)
    }
}

#[derive(Clone, Default)]
pub struct SharedShape(pub Arc<Mutex<Option<HitShape>>>);

impl SharedShape {
    pub fn set(&self, shape: HitShape) { *self.0.lock().unwrap_or_else(|poison| poison.into_inner()) = Some(shape); }
    /// Forma atual da ilha (o PiP grudado usa a altura para ficar logo abaixo).
    pub fn current(&self) -> HitShape { self.get() }
    fn get(&self) -> HitShape { self.0.lock().unwrap_or_else(|poison| poison.into_inner()).unwrap_or(HitShape::COMPACT) }
}

/// Mesmo contorno de `containsNotchPoint` em `geometry.ts`: corpo, cantos inferiores e asas côncavas.
pub fn contains(shape: &HitShape, center: f64, x: f64, y: f64, margin: f64) -> bool {
    if !x.is_finite() || !y.is_finite() { return false; }
    let (left, right) = (center - shape.width / 2.0, center + shape.width / 2.0);
    let HitShape { height, radius, wing, .. } = *shape;
    if y < -margin || y > height + margin || x < left - wing - margin || x > right + wing + margin { return false; }
    if x >= left - margin && x <= right + margin {
        if y <= height - radius || (x >= left + radius && x <= right - radius) { return true; }
        let corner_x = if x < center { left + radius } else { right - radius };
        return (x - corner_x).hypot(y - (height - radius)) <= radius + margin;
    }
    if y > wing + margin { return false; }
    let corner_x = if x < left { left - wing } else { right + wing };
    (x - corner_x).hypot(y - wing) >= (wing - margin).max(0.0)
}

pub fn spawn_monitor(window: WebviewWindow, shape: SharedShape) {
    let spawned = std::thread::Builder::new().name("heydesk-pointer".into()).spawn(move || {
        #[cfg(windows)]
        {
            let Ok(hwnd) = window.hwnd() else { return; };
            let hwnd = hwnd.0 as isize;
            let (mut inside, mut pause) = (false, 12);
            loop {
                std::thread::sleep(std::time::Duration::from_millis(pause));
                let (now, next) = sample(hwnd, &shape.get(), inside);
                pause = next;
                if now == inside { continue; }
                inside = now;
                if let Err(error) = window.set_ignore_cursor_events(!inside) {
                    eprintln!("[Heydesk] Falha ao alternar click-through: {error}");
                }
                let _ = window.emit(SHELL_POINTER_EVENT, inside);
            }
        }
        #[cfg(not(windows))]
        { let _ = (window, shape); }
    });
    if let Err(error) = spawned { eprintln!("[Heydesk] Falha ao iniciar monitor do ponteiro: {error}"); }
}

/// Dentro da forma? E quanto esperar até a próxima leitura: 12 ms perto do notch,
/// 40 ms longe dele e 250 ms com a janela oculta (o dia todo, isso pesa).
#[cfg(windows)]
fn sample(hwnd: isize, shape: &HitShape, inside: bool) -> (bool, u64) {
    use ::windows::Win32::{Foundation::{HWND, POINT, RECT}, UI::{HiDpi::GetDpiForWindow,
        WindowsAndMessaging::{GetCursorPos, GetWindowRect, IsWindowVisible}}};
    let handle = HWND(hwnd as *mut core::ffi::c_void);
    unsafe {
        if !IsWindowVisible(handle).as_bool() { return (false, 250); }
        let (mut rect, mut cursor) = (RECT::default(), POINT::default());
        if GetWindowRect(handle, &mut rect).is_err() || GetCursorPos(&mut cursor).is_err() { return (inside, 40); }
        let dpi = GetDpiForWindow(handle);
        let scale = if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 };
        let x = (cursor.x - rect.left) as f64 / scale;
        let y = (cursor.y - rect.top) as f64 / scale;
        let center = (rect.right - rect.left) as f64 / scale / 2.0;
        let now = contains(shape, center, x, y, if inside { EXIT_MARGIN } else { 0.0 });
        (now, if now || contains(shape, center, x, y, 90.0) { 12 } else { 40 })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hit_test_matches_the_frontend_fixture() {
        // Mesmos pontos de tests/island-polish.test.tsx: corpo 420×140, raio 32, asas 22, centro 260.
        let shape = HitShape { width: 420.0, height: 140.0, radius: 32.0, wing: 22.0 };
        assert!(contains(&shape, 260.0, 260.0, 100.0, 0.0));
        assert!(!contains(&shape, 260.0, 5.0, 100.0, 0.0));
        assert!(!contains(&shape, 260.0, 260.0, 160.0, 0.0));
        assert!(!contains(&shape, 260.0, 51.0, 139.0, 0.0));
        assert!(contains(&shape, 260.0, 49.0, 1.0, 0.0));
        assert!(!contains(&shape, 260.0, 29.0, 21.0, 0.0));
        assert!(contains(&shape, 260.0, 260.0, 142.0, 3.0));
        assert!(!contains(&shape, 260.0, f64::NAN, 10.0, 3.0));
    }

    #[test]
    fn invalid_shapes_are_rejected() {
        assert!(HitShape::COMPACT.validated().is_ok());
        assert!(HitShape { width: f64::INFINITY, ..HitShape::COMPACT }.validated().is_err());
        assert!(HitShape { height: -1.0, ..HitShape::COMPACT }.validated().is_err());
        assert!(HitShape { width: 4000.0, ..HitShape::COMPACT }.validated().is_err());
    }
}
