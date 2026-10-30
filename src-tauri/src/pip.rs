// PiP da transmissão "grudado" no notch: fica centralizado logo abaixo da ilha e desce
// e sobe junto quando o painel abre e fecha. Arrastado para longe, solta e fica onde o
// usuário deixou; solto perto da ilha (até ~90 px), gruda de novo.
use crate::pointer::SharedShape;
use std::{sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Mutex}, time::{Duration, Instant}};
use tauri::{AppHandle, Manager, PhysicalPosition};

pub const LABEL: &str = "pip";
const GAP: f64 = 8.0;
const SNAP: f64 = 90.0;

#[derive(Default)]
pub struct Pip {
    docked: AtomicBool,
    /// Movimentos feitos pelo próprio app (animação) não contam como arrasto.
    moving_until: Mutex<Option<Instant>>,
    /// Último "Moved" vindo do usuário; o ajuste espera o arrasto parar.
    drag_token: AtomicU64,
}

/// Onde o PiP grudado fica: centralizado sob a ilha, `GAP` abaixo da borda de baixo.
fn dock_target(app: &AppHandle) -> Option<PhysicalPosition<i32>> {
    let main = app.get_webview_window("main")?;
    let pip = app.get_webview_window(LABEL)?;
    let (origin, size, scale) = (main.outer_position().ok()?, main.outer_size().ok()?, main.scale_factor().ok()?);
    let shape = app.state::<SharedShape>().current();
    let width = pip.outer_size().ok()?.width as f64;
    let x = origin.x as f64 + size.width as f64 / 2.0 - width / 2.0;
    let y = origin.y as f64 + (shape.height + GAP) * scale;
    Some(PhysicalPosition::new(x.round() as i32, y.round() as i32))
}

impl Pip {
    pub fn opened(&self, app: &AppHandle) { self.docked.store(true, Ordering::Relaxed); self.follow(app); }
    pub fn is_docked(&self) -> bool { self.docked.load(Ordering::Relaxed) }

    /// Ilha mudou de forma (abriu, fechou, toast) ou o PiP mudou de tamanho: acompanha.
    pub fn follow(&self, app: &AppHandle) {
        if !self.is_docked() { return; }
        let (Some(target), Some(pip)) = (dock_target(app), app.get_webview_window(LABEL)) else { return };
        let Ok(from) = pip.outer_position() else { return };
        if from == target { return; }
        // Desliza ~200 ms (ease-out) para parecer preso à borda da ilha.
        let steps = 12u32;
        if let Ok(mut until) = self.moving_until.lock() { *until = Some(Instant::now() + Duration::from_millis(320)); }
        std::thread::spawn(move || {
            for step in 1..=steps {
                let t = step as f64 / steps as f64;
                let ease = 1.0 - (1.0 - t).powi(3);
                let x = from.x as f64 + (target.x - from.x) as f64 * ease;
                let y = from.y as f64 + (target.y - from.y) as f64 * ease;
                let _ = pip.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
                std::thread::sleep(Duration::from_millis(16));
            }
        });
    }

    /// O PiP se moveu. Se foi o usuário, espera o arrasto parar e decide: perto da ilha
    /// gruda, longe fica solto onde foi deixado.
    pub fn moved(&self, app: &AppHandle) {
        if self.moving_until.lock().ok().and_then(|until| *until).is_some_and(|until| Instant::now() < until) { return; }
        let token = self.drag_token.fetch_add(1, Ordering::Relaxed) + 1;
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(280));
            let pip = app.state::<Pip>();
            if pip.drag_token.load(Ordering::Relaxed) != token { return; }
            let (Some(target), Some(window)) = (dock_target(&app), app.get_webview_window(LABEL)) else { return };
            let Ok(now) = window.outer_position() else { return };
            let scale = window.scale_factor().unwrap_or(1.0);
            let distance = ((now.x - target.x) as f64).hypot((now.y - target.y) as f64) / scale;
            pip.docked.store(distance <= SNAP, Ordering::Relaxed);
            pip.follow(&app);
        });
    }
}
