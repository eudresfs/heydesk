// Nota rápida e tarefas, guardadas só nesta máquina (notes.json em app_config_dir).
// Gravação atômica, como as configurações: uma falha mantém o arquivo anterior.
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex};

pub const MAX_NOTE: usize = 20_000;
pub const MAX_TODOS: usize = 200;
const MAX_TODO_TEXT: usize = 280;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub done: bool,
    #[serde(default)]
    pub starred: bool,
    /// Época Unix em ms.
    #[serde(default)]
    pub created_at: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Drink { pub at: i64, pub ml: u32 }

/// Lembrete de água: meta diária, copo padrão, lembretes e o registro dos goles.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Water { pub goal_ml: u32, pub cup_ml: u32, pub reminders: bool, pub interval_min: u32, pub log: Vec<Drink>, pub snooze_until: i64 }
impl Default for Water {
    fn default() -> Self { Self { goal_ml: 2000, cup_ml: 250, reminders: true, interval_min: 60, log: Vec::new(), snooze_until: 0 } }
}

/// Compromisso da agenda local; lembrete `remind_min` antes e na hora.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event { pub id: String, pub title: String, pub at: i64, #[serde(default = "ten")] pub remind_min: u32, #[serde(default)] pub reminders: Vec<u32> }
fn ten() -> u32 { 10 }

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notes {
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub todos: Vec<Todo>,
    #[serde(default)]
    pub water: Water,
    #[serde(default)]
    pub events: Vec<Event>,
    #[serde(default)]
    pub prompter: Prompter,
}

/// Teleprompter: texto, velocidade (1–10), tamanho da fonte (px) e espelhado.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Prompter { pub text: String, pub speed: u8, pub size: u8, pub mirror: bool, pub opacity: u8, pub height: u16 }
impl Default for Prompter {
    fn default() -> Self { Self { text: String::new(), speed: 4, size: 26, mirror: false, opacity: 100, height: 300 } }
}

impl Notes {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.note.chars().count() > MAX_NOTE { return Err(format!("A nota passou de {MAX_NOTE} caracteres.")); }
        if self.prompter.text.len() > 200_000 || !(1..=10).contains(&self.prompter.speed) || !(14..=64).contains(&self.prompter.size) || !(30..=100).contains(&self.prompter.opacity) || !(200..=420).contains(&self.prompter.height) { return Err("Teleprompter inválido.".into()); }
        if self.todos.len() > MAX_TODOS { return Err(format!("Limite de {MAX_TODOS} tarefas.")); }
        let water = &self.water;
        if !(250..=10_000).contains(&water.goal_ml) || !(50..=2_000).contains(&water.cup_ml) || !(15..=240).contains(&water.interval_min) || water.log.len() > 500
            || water.log.iter().any(|drink| drink.ml == 0 || drink.ml > 2_000) { return Err("Registro de água inválido.".into()); }
        if self.events.len() > 500 || self.events.iter().any(|event| event.id.is_empty() || event.id.len() > 64 || event.title.trim().is_empty() || event.title.chars().count() > 140 || event.remind_min > 1440) {
            return Err("Compromisso inválido.".into());
        }
        for todo in &self.todos {
            if todo.id.is_empty() || todo.id.len() > 64 { return Err("Tarefa com identificador inválido.".into()); }
            let size = todo.text.chars().count();
            if size == 0 || size > MAX_TODO_TEXT { return Err(format!("Cada tarefa tem de 1 a {MAX_TODO_TEXT} caracteres.")); }
        }
        Ok(())
    }
}

pub struct NotesStore { path: PathBuf, lock: Mutex<()> }

impl NotesStore {
    pub fn new(path: PathBuf) -> Self { Self { path, lock: Mutex::new(()) } }

    pub fn load(&self) -> Result<Notes, String> {
        let _guard = self.lock.lock().map_err(|_| "Notas indisponíveis.".to_string())?;
        match fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "O arquivo de notas está corrompido; nada foi alterado.".to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Notes::default()),
            Err(error) => Err(format!("Não foi possível ler as notas: {error}")),
        }
    }

    pub fn save(&self, notes: Notes) -> Result<Notes, String> {
        notes.validate()?;
        let _guard = self.lock.lock().map_err(|_| "Notas indisponíveis.".to_string())?;
        let bytes = serde_json::to_vec_pretty(&notes).map_err(|error| error.to_string())?;
        crate::settings::atomic_write(&self.path, &bytes).map_err(|error| format!("Não foi possível salvar as notas: {error}"))?;
        Ok(notes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (NotesStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!("heydesk-notes-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        (NotesStore::new(dir.join("notes.json")), dir)
    }

    #[test]
    fn missing_file_is_empty_and_round_trips() {
        let (store, dir) = store();
        assert_eq!(store.load().unwrap(), Notes::default());
        let mut notes = Notes { note: "lembrar".into(), todos: vec![Todo { id: "a".into(), text: "comprar café".into(), done: false, starred: true, created_at: 1 }], ..Default::default() };
        notes.water.log.push(Drink { at: 10, ml: 250 });
        notes.events.push(Event { id: "e".into(), title: "Dentista".into(), at: 1_000, remind_min: 10, reminders: vec![30, 15] });
        store.save(notes.clone()).unwrap();
        assert_eq!(store.load().unwrap(), notes);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_oversized_or_empty_and_keeps_previous_file() {
        let (store, dir) = store();
        store.save(Notes { note: "ok".into(), ..Default::default() }).unwrap();
        assert!(store.save(Notes { note: "x".repeat(MAX_NOTE + 1), ..Default::default() }).is_err());
        assert!(store.save(Notes { water: Water { goal_ml: 0, ..Water::default() }, ..Default::default() }).is_err());
        assert!(store.save(Notes { todos: vec![Todo { id: "a".into(), text: String::new(), ..Default::default() }], ..Default::default() }).is_err());
        assert_eq!(store.load().unwrap().note, "ok");
        fs::write(&store.path, b"{nope").unwrap();
        assert!(store.load().is_err());
        let _ = fs::remove_dir_all(dir);
    }
}
