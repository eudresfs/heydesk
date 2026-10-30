//! Configuração local explícita de clima, usando a mesma validação e escrita do aplicativo.
#[path = "../src/desktop_context/mod.rs"]
mod desktop_context;
#[path = "../src/settings.rs"]
mod settings;

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 4 { return Err("Uso: configure_weather <settings.json> <cidade> <latitude> <longitude>".into()); }
    let location = desktop_context::WeatherLocation {
        city: args[1].clone(), latitude: args[2].parse().map_err(|_| "Latitude inválida.")?,
        longitude: args[3].parse().map_err(|_| "Longitude inválida.")?,
    };
    if !location.is_valid() { return Err("Localização inválida.".into()); }
    let store = settings::SettingsStore::new(std::path::PathBuf::from(&args[0]));
    let mut preferences = store.load()?;
    preferences.weather_location = Some(location);
    preferences.modules.weather = true;
    let saved = store.save(preferences)?;
    println!("{}", serde_json::json!({"schemaVersion":saved.schema_version,"city":saved.weather_location.map(|v| v.city),"accentColor":saved.appearance.accent_color}));
    Ok(())
}
