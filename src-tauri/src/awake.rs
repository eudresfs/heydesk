// Keep Awake: impede o Windows de dormir ou apagar a tela enquanto ligado. O pedido
// (SetThreadExecutionState contínuo) vale enquanto a thread que o fez existir, então
// uma thread dedicada segura o pedido e o desfaz ao ser liberada.
use std::sync::{mpsc, Mutex};

#[derive(Default)]
pub struct KeepAwake(Mutex<Option<mpsc::Sender<()>>>);

impl KeepAwake {
    pub fn active(&self) -> bool { self.0.lock().map(|held| held.is_some()).unwrap_or(false) }

    pub fn set(&self, on: bool) -> Result<bool, String> {
        let mut held = self.0.lock().map_err(|_| "Estado do Keep Awake indisponível.".to_string())?;
        if on == held.is_some() { return Ok(on); }
        if !on { held.take(); return Ok(false); }
        let (release, wait) = mpsc::channel::<()>();
        let (ready, started) = mpsc::channel::<bool>();
        std::thread::Builder::new().name("heydesk-awake".into()).spawn(move || {
            #[cfg(windows)]
            {
                use ::windows::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED};
                let granted = unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED) }.0 != 0;
                let _ = ready.send(granted);
                if !granted { return; }
                // Bloqueia até o Sender cair (desligar ou sair do app).
                let _ = wait.recv();
                unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
            }
            #[cfg(not(windows))]
            { let _ = (ready.send(false), wait); }
        }).map_err(|error| error.to_string())?;
        if started.recv().unwrap_or(false) { *held = Some(release); Ok(true) }
        else { Err("O Windows recusou manter o PC acordado.".into()) }
    }
}
