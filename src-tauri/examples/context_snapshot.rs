//! Diagnóstico local limitado a status de hardware, mídia e clima autorizado.
#[path = "../src/desktop_context/mod.rs"]
mod desktop_context;

fn main() {
    let monitor = desktop_context::DesktopMonitor::new(desktop_context::DesktopConfig {
        system_info: true, media: true, weather: true,
        location: Some(desktop_context::WeatherLocation { city:"Natal/RN".into(), latitude:-5.795, longitude:-35.20944 }),
    });
    std::thread::sleep(std::time::Duration::from_secs(7));
    println!("{}", serde_json::to_string(&monitor.snapshot()).expect("Snapshot serializável"));
}
