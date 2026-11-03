// Eventos do Windows que viram avisos no notch: volume (subir/baixar/mutar), rede
// (Wi-Fi conectado, queda de internet) e notificações de apps escolhidos (como o
// WhatsApp). Cada um roda numa thread própria e emite um evento Tauri na hora;
// o frontend decide o que mostrar.
use serde::Serialize;
use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
use tauri::{AppHandle, Emitter};

pub const VOLUME_EVENT: &str = "desktop:volume";
pub const NETWORK_EVENT: &str = "desktop:network";
pub const NOTIFICATION_EVENT: &str = "desktop:notification";

#[derive(Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Volume { pub level: u8, pub muted: bool }

#[derive(Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Network { pub online: bool, pub wifi: bool, pub ssid: Option<String> }

/// Notificação espelhada pelo Vincular ao Celular (Phone Link): o app de origem vem
/// na primeira linha ("WhatsApp"), depois remetente e mensagem.
pub(crate) fn phone_link(aumid: &str) -> bool { aumid.starts_with("Microsoft.YourPhone_") }

/// App, título e corpo de uma notificação; `None` se não passar no filtro.
pub(crate) fn shape(filters: &[String], app: &str, aumid: &str, texts: &[String]) -> Option<(String, String, String)> {
    // Vincular ao Celular: avisos do iPhone vêm com o app no AUMID
    // ("…!YourPhoneNotifications_net.whatsapp.WhatsAppSMB") e o contato na 1ª linha;
    // no formato antigo ("…!App") o nome do app é a 1ª linha.
    let bundle = aumid.split_once("!YourPhoneNotifications_").map(|(_, bundle)| bundle);
    let (app, rest) = match bundle {
        Some(bundle) => {
            if !app_matches(filters, app) && !app_matches(filters, bundle) { return None; }
            (if app.trim().is_empty() || app == "Vincular ao Celular" || app == "Phone Link" { bundle.rsplit('.').next().unwrap_or(bundle).to_string() } else { app.to_string() }, texts)
        }
        None if phone_link(aumid) && !texts.is_empty() => (texts[0].clone(), &texts[1..]),
        None => (app.to_string(), texts),
    };
    if bundle.is_none() && !app_matches(filters, &app) { return None; }
    let title = rest.first().cloned().unwrap_or_else(|| app.clone()).chars().take(80).collect();
    let body = rest.iter().skip(1).cloned().collect::<Vec<_>>().join(" ").chars().take(300).collect();
    Some((app, title, body))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification { pub id: u32, pub app: String, pub title: String, pub body: String }

/// "WhatsApp" bate com "WhatsApp Desktop", "5319275A.WhatsAppDesktop" etc.
pub(crate) fn app_matches(filters: &[String], app: &str) -> bool {
    let app = app.to_lowercase();
    filters.iter().any(|filter| !filter.trim().is_empty() && app.contains(&filter.trim().to_lowercase()))
}

/// Windows em silêncio: "Não perturbe" (Windows 11 desliga os toasts globais) ou um
/// app em tela cheia/apresentação. Melhor esforço: não há API pública para o
/// estado do "Não perturbe".
pub fn quiet() -> bool {
    #[cfg(windows)]
    {
        use ::windows::{core::w, Win32::{System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD},
            UI::Shell::{SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_QUIET_TIME, QUNS_RUNNING_D3D_FULL_SCREEN}}};
        let mut value: u32 = 1;
        let mut size = std::mem::size_of::<u32>() as u32;
        let toasts_off = unsafe { RegGetValueW(HKEY_CURRENT_USER, w!(r"Software\Microsoft\Windows\CurrentVersion\Notifications\Settings"),
            w!("NOC_GLOBAL_SETTING_TOASTS_ENABLED"), RRF_RT_REG_DWORD, None, Some(&mut value as *mut u32 as *mut _), Some(&mut size)) }.is_ok() && value == 0;
        let state = unsafe { SHQueryUserNotificationState() }.unwrap_or_default();
        toasts_off || state == QUNS_QUIET_TIME || state == QUNS_BUSY || state == QUNS_PRESENTATION_MODE || state == QUNS_RUNNING_D3D_FULL_SCREEN
    }
    #[cfg(not(windows))]
    { false }
}

pub fn start(app: AppHandle) {
    #[cfg(windows)]
    {
        let volume = app.clone();
        let _ = std::thread::Builder::new().name("heydesk-volume".into()).spawn(move || windows_impl::watch_volume(volume));
        let network = app.clone();
        let _ = std::thread::Builder::new().name("heydesk-network".into()).spawn(move || windows_impl::watch_network(network));
    }
    #[cfg(not(windows))]
    { let _ = app; }
}

/// Notificações: só começam quando o usuário liga a opção (o Windows pede permissão).
#[derive(Default)]
pub struct Notifications { running: Arc<AtomicBool>, filters: Arc<std::sync::Mutex<Vec<String>>> }

impl Notifications {
    pub fn configure(&self, app: AppHandle, enabled: bool, filters: Vec<String>) -> Result<String, String> {
        if let Ok(mut slot) = self.filters.lock() { *slot = filters; }
        if !enabled { self.running.store(false, Ordering::Relaxed); return Ok("off".into()); }
        if self.running.swap(true, Ordering::Relaxed) { return Ok("on".into()); }
        #[cfg(windows)]
        {
            let status = windows_impl::request_access();
            if status != "allowed" { self.running.store(false, Ordering::Relaxed); return Ok(status); }
            let (running, filters) = (self.running.clone(), self.filters.clone());
            std::thread::Builder::new().name("heydesk-notifications".into())
                .spawn(move || windows_impl::watch_notifications(app, running, filters)).map_err(|error| error.to_string())?;
            Ok("on".into())
        }
        #[cfg(not(windows))]
        { let _ = app; self.running.store(false, Ordering::Relaxed); Ok("unsupported".into()) }
    }
}

#[cfg(windows)]
mod windows_impl {
    use super::*;
    use std::{collections::HashSet, time::{Duration, Instant}};

    pub fn watch_volume(app: AppHandle) {
        use ::windows::Win32::{Media::Audio::{eConsole, eRender, Endpoints::IAudioEndpointVolume, IMMDeviceEnumerator, MMDeviceEnumerator},
            System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED}};
        unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); }
        let mut last: Option<Volume> = None;
        let mut endpoint: Option<IAudioEndpointVolume> = None;
        let mut bound = Instant::now() - Duration::from_secs(60);
        // O enumerador vive o tempo todo; recriar a cada passada custava COM à toa.
        let mut enumerator: Option<IMMDeviceEnumerator> = None;
        loop {
            // O dispositivo padrão muda (fone, HDMI): reassocia a cada 10 s.
            if endpoint.is_none() || bound.elapsed() > Duration::from_secs(10) {
                bound = Instant::now();
                if enumerator.is_none() { enumerator = unsafe { CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL).ok() }; }
                endpoint = unsafe {
                    enumerator.as_ref()
                        .and_then(|enumerator| enumerator.GetDefaultAudioEndpoint(eRender, eConsole).ok())
                        .and_then(|device| device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None).ok())
                };
            }
            if let Some(volume) = &endpoint {
                let reading = unsafe { volume.GetMasterVolumeLevelScalar().ok().zip(volume.GetMute().ok()) };
                if let Some((level, muted)) = reading {
                    let now = Volume { level: (level * 100.0).round().clamp(0.0, 100.0) as u8, muted: muted.as_bool() };
                    // A primeira leitura só registra o estado.
                    if last.as_ref().is_some_and(|previous| *previous != now) { let _ = app.emit(VOLUME_EVENT, now.clone()); }
                    last = Some(now);
                } else { endpoint = None; }
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }

    pub fn watch_network(app: AppHandle) {
        use ::windows::Networking::Connectivity::{NetworkConnectivityLevel, NetworkInformation};
        let mut last: Option<Network> = None;
        loop {
            let profile = NetworkInformation::GetInternetConnectionProfile().ok();
            let online = profile.as_ref().and_then(|profile| profile.GetNetworkConnectivityLevel().ok()).is_some_and(|level| level == NetworkConnectivityLevel::InternetAccess);
            let wifi = profile.as_ref().and_then(|profile| profile.IsWlanConnectionProfile().ok()).unwrap_or(false);
            let ssid = if wifi { profile.as_ref().and_then(|profile| profile.WlanConnectionProfileDetails().ok()).and_then(|details| details.GetConnectedSsid().ok()).map(|ssid| ssid.to_string()).filter(|ssid| !ssid.is_empty()) } else { None };
            let now = Network { online, wifi, ssid };
            if last.as_ref().is_some_and(|previous| *previous != now) { let _ = app.emit(NETWORK_EVENT, now.clone()); }
            last = Some(now);
            std::thread::sleep(Duration::from_secs(2));
        }
    }

    /// Espera uma operação WinRT por polling (prazo de 30 s, para o pedido de permissão).
    macro_rules! wait {
        ($operation:expr) => {{
            (|| -> ::windows::core::Result<_> {
                let operation = $operation?;
                let deadline = Instant::now() + Duration::from_secs(30);
                while operation.Status()?.0 == 0 {
                    if Instant::now() >= deadline { let _ = operation.Cancel(); return Err(::windows::core::Error::empty()); }
                    std::thread::sleep(Duration::from_millis(40));
                }
                operation.GetResults()
            })()
        }};
    }

    pub fn request_access() -> String {
        use ::windows::UI::Notifications::Management::{UserNotificationListener, UserNotificationListenerAccessStatus};
        let status = wait!(UserNotificationListener::Current().and_then(|listener| listener.RequestAccessAsync()));
        match status {
            Ok(value) if value == UserNotificationListenerAccessStatus::Allowed => "allowed".into(),
            Ok(value) if value == UserNotificationListenerAccessStatus::Denied => "denied".into(),
            Ok(_) => "unspecified".into(),
            Err(_) => "unsupported".into(),
        }
    }

    pub fn watch_notifications(app: AppHandle, running: Arc<AtomicBool>, filters: Arc<std::sync::Mutex<Vec<String>>>) {
        use ::windows::UI::Notifications::{KnownNotificationBindings, Management::UserNotificationListener, NotificationKinds};
        let Ok(listener) = UserNotificationListener::Current() else { running.store(false, Ordering::Relaxed); return };
        let mut seen: HashSet<u32> = HashSet::new();
        let mut primed = false;
        // Cada leitura faz o Windows reinterpretar o XML de toda a central (custa CPU, mais
        // ainda com muitas notificações). Sem evento para app não empacotado: lê a cada 4 s e,
        // por 1 min depois de uma notificação de app escolhido (conversa em andamento), a cada 1,2 s.
        let mut lively_until: Option<Instant> = None;
        while running.load(Ordering::Relaxed) {
            if let Ok(list) = wait!(listener.GetNotificationsAsync(NotificationKinds::Toast)) {
                let wanted = filters.lock().map(|filters| filters.clone()).unwrap_or_default();
                for item in list {
                    let Ok(id) = item.Id() else { continue };
                    if !seen.insert(id) || !primed { continue; }
                    let info = item.AppInfo().ok();
                    let app_name = info.as_ref().and_then(|info| info.DisplayInfo().ok()).and_then(|info| info.DisplayName().ok()).map(|name| name.to_string()).unwrap_or_default();
                    let aumid = info.as_ref().and_then(|info| info.AppUserModelId().ok()).map(|id| id.to_string()).unwrap_or_default();
                    let texts: Vec<String> = item.Notification().and_then(|notification| notification.Visual())
                        .and_then(|visual| visual.GetBinding(&KnownNotificationBindings::ToastGeneric()?))
                        .and_then(|binding| binding.GetTextElements())
                        .map(|elements| elements.into_iter().filter_map(|element| element.Text().ok().map(|text| text.to_string())).collect())
                        .unwrap_or_default();
                    let Some((source, title, body)) = shape(&wanted, &app_name, &aumid, &texts) else { continue };
                    lively_until = Some(Instant::now() + Duration::from_secs(60));
                    let _ = app.emit(NOTIFICATION_EVENT, Notification { id, app: source, title, body });
                }
                // A primeira leitura só registra o que já estava na central.
                primed = true;
            }
            let lively = lively_until.is_some_and(|until| Instant::now() < until);
            std::thread::sleep(Duration::from_millis(if lively { 1200 } else { 4000 }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn app_filter_is_case_insensitive_substring() {
        let filters = vec!["WhatsApp".to_string(), " ".to_string()];
        assert!(app_matches(&filters, "WhatsApp Desktop"));
        assert!(app_matches(&filters, "5319275A.WhatsAppDesktop"));
        assert!(!app_matches(&filters, "Microsoft Teams"));
        assert!(!app_matches(&[], "WhatsApp"));
    }
    #[test]
    fn phone_link_uses_first_line_as_source_app() {
        let filters = vec!["WhatsApp".to_string()];
        let texts = |items: &[&str]| items.iter().map(|text| text.to_string()).collect::<Vec<_>>();
        let link = "Microsoft.YourPhone_8wekyb3d8bbwe!App";
        assert_eq!(shape(&filters, "Vincular ao Celular", link, &texts(&["WhatsApp", "Ana", "Bora?"])), Some(("WhatsApp".into(), "Ana".into(), "Bora?".into())));
        assert_eq!(shape(&filters, "Vincular ao Celular", link, &texts(&["Uber", "Viaje"])), None);
        assert_eq!(shape(&filters, "WhatsApp", "5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App", &texts(&["Ana", "Oi", "tudo"])), Some(("WhatsApp".into(), "Ana".into(), "Oi tudo".into())));
        // iPhone pelo Vincular ao Celular: app no AUMID, contato na 1ª linha.
        let iphone = "Microsoft.YourPhone_8wekyb3d8bbwe!YourPhoneNotifications_net.whatsapp.WhatsAppSMB";
        assert_eq!(shape(&filters, "WhatsApp Business", iphone, &texts(&["Ana", "Bora?"])), Some(("WhatsApp Business".into(), "Ana".into(), "Bora?".into())));
        assert_eq!(shape(&filters, "", iphone, &texts(&["Ana", "Bora?"])), Some(("WhatsAppSMB".into(), "Ana".into(), "Bora?".into())));
        assert_eq!(shape(&filters, "Uber", "Microsoft.YourPhone_8wekyb3d8bbwe!YourPhoneNotifications_com.ubercab.UberClient", &texts(&["Viagem"])), None);
    }
}
