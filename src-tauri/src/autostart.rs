// Iniciar com o Windows: um valor em HKCU\...\CurrentVersion\Run apontando para o
// executável instalado. Ligado na primeira abertura da versão instalada; depois vale o
// que o usuário escolher em Configurações (o marcador evita religar à força).
use std::path::Path;

const VALUE: &str = "Heydesk";
const MARKER: &str = "autostart.init";

#[cfg(windows)]
mod registry {
    use ::windows::{core::HSTRING, Win32::System::Registry::{RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ}};
    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

    pub fn read(name: &str) -> Option<String> {
        let mut size = 0u32;
        unsafe { RegGetValueW(HKEY_CURRENT_USER, &HSTRING::from(RUN), &HSTRING::from(name), RRF_RT_REG_SZ, None, None, Some(&mut size)) }.ok().ok()?;
        let mut buffer = vec![0u16; size as usize / 2 + 1];
        unsafe { RegGetValueW(HKEY_CURRENT_USER, &HSTRING::from(RUN), &HSTRING::from(name), RRF_RT_REG_SZ, None, Some(buffer.as_mut_ptr().cast()), Some(&mut size)) }.ok().ok()?;
        Some(String::from_utf16_lossy(&buffer).trim_end_matches('\0').to_string())
    }
    pub fn write(name: &str, value: &str) -> Result<(), String> {
        let wide: Vec<u16> = value.encode_utf16().chain(Some(0)).collect();
        unsafe { RegSetKeyValueW(HKEY_CURRENT_USER, &HSTRING::from(RUN), &HSTRING::from(name), REG_SZ.0, Some(wide.as_ptr().cast()), (wide.len() * 2) as u32) }.ok().map_err(|error| error.to_string())
    }
    pub fn delete(name: &str) -> Result<(), String> {
        let result = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, &HSTRING::from(RUN), &HSTRING::from(name)) };
        // Já não existir não é erro.
        if result.is_ok() || result.0 == 2 { Ok(()) } else { Err(result.to_hresult().message()) }
    }
}

/// Comando que o Windows roda no login: o executável atual, entre aspas.
fn command() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    Ok(format!("\"{}\"", exe.display()))
}

/// Está ligado para este executável?
pub fn enabled() -> bool {
    #[cfg(windows)]
    { registry::read(VALUE).is_some_and(|value| command().is_ok_and(|current| value.eq_ignore_ascii_case(&current))) }
    #[cfg(not(windows))]
    { false }
}

pub fn set(on: bool) -> Result<bool, String> {
    #[cfg(windows)]
    { if on { registry::write(VALUE, &command()?)?; } else { registry::delete(VALUE)?; } }
    #[cfg(not(windows))]
    { let _ = on; }
    Ok(enabled())
}

/// Primeira abertura da versão instalada: liga o início com o Windows uma única vez.
/// Se o executável mudou de lugar (reinstalação), atualiza o caminho sem religar o que
/// o usuário desligou.
pub fn first_run(config_dir: &Path) {
    let marker = config_dir.join(MARKER);
    #[cfg(windows)]
    {
        if !marker.exists() {
            if set(true).is_ok() { let _ = std::fs::create_dir_all(config_dir); let _ = std::fs::write(&marker, "ligado na primeira abertura\n"); }
        } else if registry::read(VALUE).is_some() && !enabled() {
            let _ = set(true);
        }
    }
    #[cfg(not(windows))]
    { let _ = marker; }
}

#[tauri::command]
pub fn get_autostart() -> bool { enabled() }

#[tauri::command]
pub fn set_autostart(on: bool) -> Result<bool, String> { set(on) }
