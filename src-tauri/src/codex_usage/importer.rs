use super::{parser::{self, Parsed, Record}, updated_now, CodexUsageSnapshot, UsageDay, UsageStatus, MAX_SAFE_INTEGER};
use super::quota::{self, CodexQuotaSnapshot, Observation, ObservedWindow};
use chrono::{DateTime, Days, Local, NaiveDate, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use std::{collections::{BTreeMap, HashSet}, fs::{self, File, Metadata, ReadDir}, io::{BufRead, BufReader, Read, Seek, SeekFrom}, path::{Path, PathBuf}, time::UNIX_EPOCH};

const BATCH_BYTES: usize = 4 * 1024 * 1024;
const MAX_LINE: usize = 512 * 1024;
const DB_ERROR: &str = "Não foi possível atualizar o banco local de métricas.";
const FILE_ERROR: &str = "Não foi possível ler os arquivos locais do Codex.";
const RANGE_ERROR: &str = "As métricas excederam o intervalo numérico suportado.";

#[derive(Default)]
struct Checkpoint {
    offset: u64, owner: Option<String>, quota_safe: bool, durable: bool, legacy: bool, invalid: u64, skipping: bool,
    prefix: String, prefix_len: usize, previous_len: u64, modified: String,
    created: String, anchor: String, anchor_len: usize,
}

pub(super) struct Importer {
    home: PathBuf, db: Connection, files: Vec<PathBuf>, index: usize, installed: bool, updated: Option<String>,
    directories: Vec<PathBuf>, reading_directory: Option<ReadDir>,
    waiting_files: u64,
}

fn is_link(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() { return true; }
    #[cfg(windows)]
    { use std::os::windows::fs::MetadataExt; metadata.file_attributes() & 0x400 != 0 }
    #[cfg(not(windows))]
    { false }
}

impl Importer {
    pub(super) fn open(home: PathBuf, database: &Path) -> Result<Self, &'static str> {
        if let Some(parent) = database.parent() { fs::create_dir_all(parent).map_err(|_| DB_ERROR)?; }
        let mut db = Connection::open(database).map_err(|_| DB_ERROR)?;
        db.busy_timeout(std::time::Duration::from_millis(500)).map_err(|_| DB_ERROR)?;
        let version: u32 = db.pragma_query_value(None, "user_version", |row| row.get(0)).map_err(|_| DB_ERROR)?;
        if version > 2 { return Err("O banco local de métricas usa uma versão mais recente."); }
        if version == 0 {
            let tx = db.transaction().map_err(|_| DB_ERROR)?;
            tx.execute_batch("CREATE TABLE responses (
                response_id TEXT PRIMARY KEY, owner TEXT NOT NULL, at INTEGER NOT NULL,
                input INTEGER NOT NULL, cached INTEGER NOT NULL, cache_write INTEGER,
                output INTEGER NOT NULL, reasoning INTEGER NOT NULL, total INTEGER NOT NULL,
                conflict INTEGER NOT NULL DEFAULT 0
            ); CREATE INDEX responses_at ON responses(at);
            CREATE TABLE checkpoints (
                path TEXT PRIMARY KEY, offset INTEGER NOT NULL, owner TEXT, durable INTEGER NOT NULL,
                legacy INTEGER NOT NULL, invalid INTEGER NOT NULL, skipping INTEGER NOT NULL,
                prefix TEXT NOT NULL, prefix_len INTEGER NOT NULL, previous_len INTEGER NOT NULL, modified TEXT NOT NULL,
                created TEXT NOT NULL, anchor TEXT NOT NULL, anchor_len INTEGER NOT NULL
            ); PRAGMA user_version = 1;").map_err(|_| DB_ERROR)?;
            tx.commit().map_err(|_| DB_ERROR)?;
        }
        if version < 2 {
            let tx = db.transaction().map_err(|_| DB_ERROR)?;
            tx.execute_batch("ALTER TABLE checkpoints ADD COLUMN quota_safe INTEGER NOT NULL DEFAULT 0;
                CREATE TABLE quota_observations (
                    limit_id TEXT NOT NULL, signature TEXT NOT NULL, observed_at INTEGER NOT NULL,
                    PRIMARY KEY(limit_id,signature)
                );
                CREATE INDEX quota_observed_at ON quota_observations(limit_id,observed_at);
                UPDATE checkpoints SET offset=0,owner=NULL,durable=0,legacy=0,invalid=0,skipping=0,
                    prefix='',prefix_len=0,previous_len=0,modified='',created='',anchor='',anchor_len=0;
                PRAGMA user_version = 2;").map_err(|_| DB_ERROR)?;
            // Replay limitado pelo orçamento normal. responses permanece e sua chave
            // estável torna o reprocessamento idempotente, incluindo checkpoints v1 no EOF.
            tx.commit().map_err(|_| DB_ERROR)?;
        }
        Ok(Self { home, db, files: Vec::new(), index: 0, installed: false, updated: None,
            directories: Vec::new(), reading_directory: None, waiting_files: 0 })
    }

    pub(super) fn start_scan(&mut self) -> Result<(), &'static str> {
        let mut directories = Vec::new(); let mut installed = false;
        // Pilha LIFO: prioriza sessões ativas antes do histórico arquivado.
        for name in ["archived_sessions", "sessions"] {
            let root = self.home.join(name);
            let metadata = match fs::symlink_metadata(&root) {
                Ok(m) => m, Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue, Err(_) => return Err(FILE_ERROR),
            };
            if is_link(&metadata) || !metadata.is_dir() { continue; }
            installed = true;
            directories.push(root);
        }
        self.directories = directories; self.reading_directory = None;
        self.files.clear(); self.index = 0; self.installed = installed; self.waiting_files = 0;
        Ok(())
    }

    fn discover_batch(&mut self) -> Result<(), &'static str> {
        // Limita também a descoberta: uma árvore grande continua cancelável entre lotes.
        for _ in 0..256 {
            if self.reading_directory.is_none() {
                let Some(path) = self.directories.pop() else { break; };
                let metadata = fs::symlink_metadata(&path).map_err(|_| FILE_ERROR)?;
                if is_link(&metadata) { continue; }
                self.reading_directory = Some(fs::read_dir(path).map_err(|_| FILE_ERROR)?);
            }
            let Some(entry) = self.reading_directory.as_mut().unwrap().next() else { self.reading_directory = None; continue; };
            let path = entry.map_err(|_| FILE_ERROR)?.path();
            let metadata = fs::symlink_metadata(&path).map_err(|_| FILE_ERROR)?;
            if is_link(&metadata) { continue; }
            if metadata.is_dir() { self.directories.push(path); }
            else if metadata.is_file() && path.extension().is_some_and(|s| s == "jsonl") { self.files.push(path); }
        }
        Ok(())
    }

    /// Um lote confirma registros e checkpoint na mesma transação.
    pub(super) fn step(&mut self) -> Result<bool, &'static str> {
        self.discover_batch()?;
        let mut remaining = BATCH_BYTES;
        let mut visited = 0;
        while self.index < self.files.len() && remaining > 0 && visited < 64 {
            let (read, more, waiting) = self.import_file(&self.files[self.index].clone(), remaining)?;
            if waiting { self.waiting_files = checked(self.waiting_files, 1)?; }
            visited += 1;
            remaining = remaining.saturating_sub(read);
            if !more { self.index += 1; }
            // Arquivo parcialmente escrito precisa aguardar a próxima rodada.
            if read == 0 && more { self.index += 1; }
        }
        self.updated = Some(updated_now());
        Ok(self.index < self.files.len() || !self.directories.is_empty() || self.reading_directory.is_some())
    }

    fn import_file(&mut self, path: &Path, budget: usize) -> Result<(usize, bool, bool), &'static str> {
        let metadata = match fs::symlink_metadata(path) {
            Ok(m) => m, Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((0, false, false)), Err(_) => return Err(FILE_ERROR),
        };
        if is_link(&metadata) || !metadata.is_file() { return Ok((0, false, false)); }
        // Verificação adicional contra junctions inseridas depois da descoberta.
        let relative = path.strip_prefix(&self.home).map_err(|_| FILE_ERROR)?;
        let Some(first) = relative.components().next() else { return Err(FILE_ERROR); };
        let allowed = self.home.join(first.as_os_str()).canonicalize().map_err(|_| FILE_ERROR)?;
        let canonical = path.canonicalize().map_err(|_| FILE_ERROR)?;
        if !canonical.starts_with(&allowed) { return Ok((0, false, false)); }
        let mut ancestor = path.parent();
        while let Some(dir) = ancestor {
            if dir == self.home { break; }
            if is_link(&fs::symlink_metadata(dir).map_err(|_| FILE_ERROR)?) { return Ok((0, false, false)); }
            ancestor = dir.parent();
        }
        let key = relative.to_string_lossy();
        let mut checkpoint = self.db.query_row("SELECT offset,owner,durable,legacy,invalid,skipping,prefix,prefix_len,previous_len,modified,created,anchor,anchor_len,quota_safe FROM checkpoints WHERE path=?1", [&*key], |r| {
            Ok(Checkpoint { offset: row_u64(r, 0)?, owner: r.get(1)?, durable: r.get(2)?, legacy: r.get(3)?, invalid: row_u64(r, 4)?, skipping: r.get(5)?, prefix: r.get(6)?, prefix_len: row_usize(r, 7)?, previous_len: row_u64(r, 8)?, modified: r.get(9)?, created: r.get(10)?, anchor: r.get(11)?, anchor_len: row_usize(r, 12)?, quota_safe: r.get(13)? })
        }).optional().map_err(|_| DB_ERROR)?.unwrap_or_default();
        if checkpoint.prefix_len > 256 || checkpoint.anchor_len > 256 {
            return Err("O checkpoint local de métricas contém um tamanho inválido.");
        }
        let modified = metadata.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos().to_string()).unwrap_or_default();
        let created = metadata.created().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos().to_string()).unwrap_or_default();
        if checkpoint.offset == metadata.len() && checkpoint.previous_len == metadata.len()
            && checkpoint.modified == modified && checkpoint.created == created && !checkpoint.skipping {
            return Ok((0, false, false));
        }
        let mut file = open_readonly(path).map_err(|_| FILE_ERROR)?;
        let mut prefix = vec![0; 256];
        let prefix_read = file.read(&mut prefix).map_err(|_| FILE_ERROR)?; prefix.truncate(prefix_read);
        let previous_prefix_matches = checkpoint.prefix_len <= prefix.len() && hash(&prefix[..checkpoint.prefix_len]) == checkpoint.prefix;
        let previous_anchor_matches = checkpoint.offset <= metadata.len()
            && fingerprint_at(&mut file, checkpoint.offset, checkpoint.anchor_len)? == checkpoint.anchor;
        if checkpoint.offset > metadata.len() || (checkpoint.offset > 0 && (!previous_prefix_matches || !previous_anchor_matches
            || created != checkpoint.created || (metadata.len() <= checkpoint.previous_len && modified != checkpoint.modified))) {
            checkpoint = Checkpoint::default();
        }
        checkpoint.prefix_len = prefix.len(); checkpoint.prefix = hash(&prefix);
        checkpoint.previous_len = metadata.len(); checkpoint.modified = modified; checkpoint.created = created;
        file.seek(SeekFrom::Start(checkpoint.offset)).map_err(|_| FILE_ERROR)?;
        let mut reader = BufReader::with_capacity(32 * 1024, file);
        let tx = self.db.transaction().map_err(|_| DB_ERROR)?;
        let mut consumed = 0; let mut line = Vec::new(); let mut line_start = checkpoint.offset;
        loop {
            let available = reader.fill_buf().map_err(|_| FILE_ERROR)?;
            if available.is_empty() { break; }
            let end = available.iter().position(|b| *b == b'\n').map(|p| p + 1).unwrap_or(available.len());
            let take = end.min(budget.saturating_sub(consumed));
            if take == 0 { break; }
            let newline = available[take - 1] == b'\n';
            if !checkpoint.skipping {
                if line.len() + take > MAX_LINE {
                    checkpoint.skipping = true; checkpoint.invalid = checked(checkpoint.invalid, 1)?; line.clear();
                } else { line.extend_from_slice(&available[..take]); }
            }
            reader.consume(take); consumed += take; checkpoint.offset += take as u64;
            if newline {
                if !checkpoint.skipping {
                    match parser::parse(&line) {
                        // Só o primeiro session_meta pertence ao arquivo. Forks podem copiar os do pai.
                        Parsed::Meta(owner, quota_safe) => {
                            if checkpoint.owner.is_none() { checkpoint.owner = Some(owner); checkpoint.quota_safe = quota_safe; }
                        }
                        Parsed::Record(record) => {
                            checkpoint.durable = true;
                            if checkpoint.owner.as_deref() == Some(record.owner.as_str()) { insert_record(&tx, record)?; }
                            else { checkpoint.invalid = checked(checkpoint.invalid, 1)?; }
                        }
                        Parsed::Legacy(observation) => {
                            checkpoint.legacy = true;
                            if checkpoint.owner.is_some() && checkpoint.quota_safe {
                                if let Some(observation) = observation { insert_quota(&tx, observation)?; }
                            }
                        },
                        Parsed::Invalid => checkpoint.invalid = checked(checkpoint.invalid, 1)?,
                        Parsed::Ignore => {}
                    }
                }
                line.clear(); checkpoint.skipping = false; line_start = checkpoint.offset;
            }
            if consumed >= budget { break; }
        }
        // Uma linha JSON incompleta nunca avança o checkpoint; uma linha enorme já descartada pode avançar em blocos.
        let reached_eof = checkpoint.offset >= metadata.len();
        if !line.is_empty() && !checkpoint.skipping { checkpoint.offset = line_start; }
        let at_eof = checkpoint.offset >= metadata.len();
        let partial = !line.is_empty();
        let waiting = reached_eof && (partial || checkpoint.skipping);
        checkpoint.anchor_len = checkpoint.offset.min(256) as usize;
        checkpoint.anchor = fingerprint_at(reader.get_mut(), checkpoint.offset, checkpoint.anchor_len)?;
        save_checkpoint(&tx, &key, &checkpoint)?;
        tx.commit().map_err(|_| DB_ERROR)?;
        Ok((consumed, !waiting && !at_eof && (!partial || consumed >= budget), waiting))
    }

    pub(super) fn snapshot(&self, scanning: bool) -> Result<CodexUsageSnapshot, &'static str> {
        let (legacy, invalid): (u64, u64) = self.db.query_row("SELECT COALESCE(SUM(CASE WHEN legacy=1 AND durable=0 THEN 1 ELSE 0 END),0),COALESCE(SUM(invalid),0) FROM checkpoints", [], |r| Ok((row_u64(r, 0)?, row_u64(r, 1)?))).map_err(|_| DB_ERROR)?;
        let conflicts = self.db.query_row("SELECT COUNT(*) FROM responses WHERE conflict=1", [], |r| row_u64(r, 0)).map_err(|_| DB_ERROR)?;
        let days = self.days()?;
        let insufficient = legacy > 0 || invalid > 0 || conflicts > 0 || self.waiting_files > 0;
        let status = if !self.installed { UsageStatus::NotInstalled }
            else if insufficient { UsageStatus::InsufficientData }
            else if scanning && days.is_empty() { UsageStatus::Loading }
            else if days.is_empty() { UsageStatus::Empty } else { UsageStatus::Ready };
        let today = days.iter().find(|d| d.date == Local::now().date_naive().to_string()).cloned();
        Ok(CodexUsageSnapshot { enabled: true, status, last_updated: self.updated.clone(), scanning,
            scanned_files: self.index.min(self.files.len()) as u64, pending_files: checked(self.files.len().saturating_sub(self.index) as u64, self.waiting_files)?,
            legacy_only_files: legacy.min(MAX_SAFE_INTEGER), invalid_records: invalid.min(MAX_SAFE_INTEGER), conflicts: conflicts.min(MAX_SAFE_INTEGER), today, days, error: None })
    }

    pub(super) fn quota_snapshot(&self) -> Result<CodexQuotaSnapshot, &'static str> {
        self.quota_snapshot_at(Utc::now().timestamp())
    }

    pub(super) fn quota_snapshot_at(&self, now: i64) -> Result<CodexQuotaSnapshot, &'static str> {
        let mut statement = self.db.prepare("SELECT observed_at,signature FROM quota_observations WHERE limit_id='codex' ORDER BY observed_at DESC LIMIT 2").map_err(|_| DB_ERROR)?;
        let observations = statement.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
            .map_err(|_| DB_ERROR)?.collect::<Result<Vec<_>, _>>().map_err(|_| DB_ERROR)?;
        let Some((at, signature)) = observations.first() else { return Ok(CodexQuotaSnapshot::initial(true)); };
        // Duas observações diferentes no mesmo instante não têm ordem comprovada.
        if observations.get(1).is_some_and(|(other, _)| other == at) { return Ok(CodexQuotaSnapshot::initial(true)); }
        let windows: Vec<ObservedWindow> = serde_json::from_str(signature).map_err(|_| DB_ERROR)?;
        Ok(quota::snapshot(*at, windows, now))
    }

    fn days(&self) -> Result<Vec<UsageDay>, &'static str> {
        let today = Local::now().date_naive(); let first = today.checked_sub_days(Days::new(13)).ok_or(RANGE_ERROR)?;
        let cutoff = Utc::now().timestamp() - 15 * 86_400;
        let mut statement = self.db.prepare("SELECT owner,at,input,cached,cache_write,output,reasoning,total FROM responses WHERE conflict=0 AND at>=?1 ORDER BY at").map_err(|_| DB_ERROR)?;
        let mut rows = statement.query([cutoff]).map_err(|_| DB_ERROR)?;
        let mut grouped: BTreeMap<NaiveDate, (UsageDay, HashSet<String>)> = BTreeMap::new();
        while let Some(row) = rows.next().map_err(|_| DB_ERROR)? {
            let at: i64 = row.get(1).map_err(|_| DB_ERROR)?;
            let date = local_date(at, &Local).ok_or(RANGE_ERROR)?;
            if date < first || date > today { continue; }
            let (day, owners) = grouped.entry(date).or_insert_with(|| (UsageDay { date: date.to_string(), input_tokens: 0, output_tokens: 0,
                cached_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0, response_count: 0, session_count: 0, cache_write_input_tokens: Some(0) }, HashSet::new()));
            day.input_tokens = checked(day.input_tokens, row_u64(row, 2).map_err(|_| DB_ERROR)?)?;
            day.cached_input_tokens = checked(day.cached_input_tokens, row_u64(row, 3).map_err(|_| DB_ERROR)?)?;
            day.cache_write_input_tokens = match (day.cache_write_input_tokens, row_optional_u64(row, 4).map_err(|_| DB_ERROR)?) { (Some(a), Some(b)) => Some(checked(a, b)?), _ => None };
            day.output_tokens = checked(day.output_tokens, row_u64(row, 5).map_err(|_| DB_ERROR)?)?;
            day.reasoning_output_tokens = checked(day.reasoning_output_tokens, row_u64(row, 6).map_err(|_| DB_ERROR)?)?;
            day.total_tokens = checked(day.total_tokens, row_u64(row, 7).map_err(|_| DB_ERROR)?)?;
            day.response_count = checked(day.response_count, 1)?;
            owners.insert(row.get::<_, String>(0).map_err(|_| DB_ERROR)?);
            day.session_count = owners.len() as u64;
        }
        Ok(grouped.into_values().map(|(day, _)| day).rev().collect())
    }
}

pub(super) fn local_date<T: TimeZone>(timestamp: i64, zone: &T) -> Option<NaiveDate> {
    Some(DateTime::from_timestamp(timestamp, 0)?.with_timezone(zone).date_naive())
}
fn checked(a: u64, b: u64) -> Result<u64, &'static str> { a.checked_add(b).filter(|v| *v <= MAX_SAFE_INTEGER).ok_or(RANGE_ERROR) }
fn sql_range_error(index: usize) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(index, rusqlite::types::Type::Integer,
        Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, "Inteiro fora do intervalo suportado.")))
}
fn row_u64(row: &Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(index)?;
    u64::try_from(value).map_err(|_| sql_range_error(index))
}
fn row_usize(row: &Row<'_>, index: usize) -> rusqlite::Result<usize> {
    let value: i64 = row.get(index)?;
    usize::try_from(value).map_err(|_| sql_range_error(index))
}
fn row_optional_u64(row: &Row<'_>, index: usize) -> rusqlite::Result<Option<u64>> {
    let value: Option<i64> = row.get(index)?;
    value.map(|n| u64::try_from(n).map_err(|_| sql_range_error(index))).transpose()
}
fn sql_integer(value: u64) -> Result<i64, &'static str> { i64::try_from(value).map_err(|_| RANGE_ERROR) }
fn hash(bytes: &[u8]) -> String {
    let mut value = 0xcbf29ce484222325u64;
    for byte in bytes { value ^= u64::from(*byte); value = value.wrapping_mul(0x100000001b3); }
    format!("{value:016x}")
}
fn open_readonly(path: &Path) -> std::io::Result<File> {
    let mut options = fs::OpenOptions::new(); options.read(true);
    #[cfg(windows)]
    { use std::os::windows::fs::OpenOptionsExt; options.custom_flags(0x00200000); }
    options.open(path)
}
fn fingerprint_at(file: &mut File, offset: u64, length: usize) -> Result<String, &'static str> {
    file.seek(SeekFrom::Start(offset.saturating_sub(length as u64))).map_err(|_| FILE_ERROR)?;
    let mut bytes = vec![0; length];
    file.read_exact(&mut bytes).map_err(|_| FILE_ERROR)?;
    Ok(hash(&bytes))
}
fn save_checkpoint(tx: &Transaction<'_>, path: &str, c: &Checkpoint) -> Result<(), &'static str> {
    tx.execute("INSERT INTO checkpoints(path,offset,owner,durable,legacy,invalid,skipping,prefix,prefix_len,previous_len,modified,created,anchor,anchor_len,quota_safe)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15) ON CONFLICT(path) DO UPDATE SET
        offset=excluded.offset,owner=excluded.owner,durable=excluded.durable,legacy=excluded.legacy,invalid=excluded.invalid,
        skipping=excluded.skipping,prefix=excluded.prefix,prefix_len=excluded.prefix_len,previous_len=excluded.previous_len,modified=excluded.modified,
        created=excluded.created,anchor=excluded.anchor,anchor_len=excluded.anchor_len,quota_safe=excluded.quota_safe",
        params![path,sql_integer(c.offset)?,c.owner,c.durable,c.legacy,sql_integer(c.invalid)?,c.skipping,c.prefix,
            i64::try_from(c.prefix_len).map_err(|_| RANGE_ERROR)?,sql_integer(c.previous_len)?,c.modified,c.created,c.anchor,
            i64::try_from(c.anchor_len).map_err(|_| RANGE_ERROR)?,c.quota_safe]).map_err(|_| DB_ERROR)?;
    Ok(())
}
fn insert_quota(tx: &Transaction<'_>, observation: Observation) -> Result<(), &'static str> {
    let signature = serde_json::to_string(&observation.windows).map_err(|_| DB_ERROR)?;
    tx.execute("INSERT INTO quota_observations(limit_id,signature,observed_at) VALUES('codex',?1,?2)
        ON CONFLICT(limit_id,signature) DO UPDATE SET observed_at=MIN(observed_at,excluded.observed_at)",
        params![signature,observation.at]).map_err(|_| DB_ERROR)?;
    Ok(())
}
fn insert_record(tx: &Transaction<'_>, record: Record) -> Result<(), &'static str> {
    let m = record.metrics;
    tx.execute("INSERT INTO responses(response_id,owner,at,input,cached,cache_write,output,reasoning,total)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
        ON CONFLICT(response_id) DO UPDATE SET conflict=CASE WHEN
        responses.owner IS NOT excluded.owner OR responses.input IS NOT excluded.input OR responses.cached IS NOT excluded.cached OR
        responses.cache_write IS NOT excluded.cache_write OR responses.output IS NOT excluded.output OR
        responses.reasoning IS NOT excluded.reasoning OR responses.total IS NOT excluded.total THEN 1 ELSE responses.conflict END",
        params![record.id,record.owner,record.at,sql_integer(m.input_tokens)?,sql_integer(m.cached_input_tokens)?,
            m.cache_write_input_tokens.map(sql_integer).transpose()?,sql_integer(m.output_tokens)?,
            sql_integer(m.reasoning_output_tokens)?,sql_integer(m.total_tokens)?]).map_err(|_| DB_ERROR)?;
    Ok(())
}
