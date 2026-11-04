// Letras do LRCLIB, sob demanda (só quando o usuário abre a letra no Player). A
// consulta envia título, artista e duração da faixa; nada mais sai da máquina.
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Mutex, time::Duration};

const GET: &str = "https://lrclib.net/api/get";
const SEARCH: &str = "https://lrclib.net/api/search";

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LyricLine { pub at_ms: u64, pub text: String }

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Lyrics {
    /// "synced" | "plain" | "instrumental" | "none" | "error"
    pub state: String,
    pub lines: Vec<LyricLine>,
    pub plain: Option<String>,
}
impl Lyrics {
    fn of(state: &str) -> Self { Self { state: state.into(), lines: Vec::new(), plain: None } }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Record { instrumental: Option<bool>, plain_lyrics: Option<String>, synced_lyrics: Option<String>, duration: Option<f64> }

/// `[mm:ss.xx] texto`, com várias marcas por linha permitidas; tags de metadado são ignoradas.
pub(crate) fn parse_lrc(source: &str) -> Vec<LyricLine> {
    let mut lines = Vec::new();
    for raw in source.lines() {
        let mut rest = raw.trim();
        let mut stamps = Vec::new();
        while let Some(stripped) = rest.strip_prefix('[') {
            let Some(end) = stripped.find(']') else { break };
            let (stamp, after) = (&stripped[..end], &stripped[end + 1..]);
            let Some((minutes, seconds)) = stamp.split_once(':') else { break };
            let (Ok(minutes), Ok(seconds)) = (minutes.parse::<u64>(), seconds.parse::<f64>()) else { break };
            stamps.push(minutes * 60_000 + (seconds * 1000.0).round() as u64);
            rest = after;
        }
        let text = rest.trim().to_string();
        lines.extend(stamps.into_iter().map(|at_ms| LyricLine { at_ms, text: text.clone() }));
    }
    lines.sort_by_key(|line| line.at_ms);
    lines
}

/// Títulos de vídeo carregam sufixos que o LRCLIB não conhece: "(Official Video)", "[Lyrics]".
pub(crate) fn clean_title(title: &str) -> String {
    let mut out = String::new();
    let mut depth = 0;
    let mut group = String::new();
    for ch in title.chars() {
        match ch {
            '(' | '[' => { depth += 1; group.clear(); }
            ')' | ']' if depth > 0 => {
                depth -= 1;
                let lower = group.to_lowercase();
                let noise = ["official", "video", "lyric", "audio", "remaster", "visualizer", "hd", "4k", "mv"].iter().any(|word| lower.contains(word));
                if !noise { out.push_str(&format!("({group})")); }
            }
            _ if depth > 0 => group.push(ch),
            _ => out.push(ch),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn to_lyrics(record: Record) -> Lyrics {
    if record.instrumental == Some(true) { return Lyrics::of("instrumental"); }
    if let Some(synced) = record.synced_lyrics.filter(|value| !value.trim().is_empty()) {
        let lines = parse_lrc(&synced);
        if !lines.is_empty() { return Lyrics { state: "synced".into(), lines, plain: None }; }
    }
    match record.plain_lyrics.filter(|value| !value.trim().is_empty()) {
        Some(plain) => Lyrics { state: "plain".into(), lines: Vec::new(), plain: Some(plain) },
        None => Lyrics::of("none"),
    }
}

/// Registro com letra sincronizada de verdade.
fn synced(record: &Record) -> bool { record.synced_lyrics.as_ref().is_some_and(|value| !value.trim().is_empty()) }

/// Entre os achados, a letra sincronizada da versão com duração mais próxima (até 6 s de diferença:
/// versões ao vivo e remasters têm marcas de tempo diferentes). Sem duração conhecida, a primeira.
pub(crate) fn best_synced(records: Vec<Record>, duration_ms: Option<u64>) -> Option<Record> {
    let gap = |record: &Record| match (duration_ms, record.duration) { (Some(ms), Some(seconds)) => (seconds - ms as f64 / 1000.0).abs(), (Some(_), None) => f64::MAX, _ => 0.0 };
    records.into_iter().filter(|record| synced(record) && gap(record) <= 6.0)
        .min_by(|a, b| gap(a).total_cmp(&gap(b)))
}

fn fetch(title: &str, artist: &str, duration_ms: Option<u64>) -> Lyrics {
    let client = match reqwest::blocking::Client::builder().https_only(true).timeout(Duration::from_secs(8))
        .user_agent("Heydesk (Windows notch; lyrics on demand)").build() { Ok(client) => client, Err(_) => return Lyrics::of("error") };
    let track = clean_title(title);
    let mut query = vec![("track_name", track.clone()), ("artist_name", artist.to_string())];
    if let Some(ms) = duration_ms { query.push(("duration", (ms / 1000).to_string())); }
    // O par exato do LRCLIB às vezes é um registro só com letra comum, mesmo havendo dezenas de
    // versões sincronizadas da mesma faixa: ele fica de reserva e a busca procura uma sincronizada.
    let exact = match client.get(GET).query(&query).send() {
        Ok(response) if response.status().is_success() => response.json::<Record>().ok(),
        Ok(response) if response.status().as_u16() == 404 => None,
        _ => return Lyrics::of("error"),
    };
    if let Some(record) = exact.clone().filter(|record| synced(record) || record.instrumental == Some(true)) { return to_lyrics(record); }
    // Busca por faixa e artista; títulos de vídeo ("Banda - Música") também pela frase inteira.
    let mut searches = vec![vec![("track_name", track.clone()), ("artist_name", artist.to_string())]];
    searches.push(vec![("q", format!("{artist} {track}").trim().to_string())]);
    let mut plain = exact;
    for search in searches {
        let Ok(response) = client.get(SEARCH).query(&search).send() else { continue };
        let Ok(records) = response.json::<Vec<Record>>() else { continue };
        if plain.is_none() { plain = records.iter().find(|record| record.plain_lyrics.as_ref().is_some_and(|value| !value.trim().is_empty())).cloned(); }
        if let Some(record) = best_synced(records, duration_ms) { return to_lyrics(record); }
    }
    plain.map(to_lyrics).unwrap_or_else(|| Lyrics::of("none"))
}

#[derive(Default)]
pub struct LyricsCache(Mutex<HashMap<String, Lyrics>>);
impl LyricsCache {
    pub fn get(&self, title: &str, artist: &str, duration_ms: Option<u64>) -> Lyrics {
        let key = format!("{}\u{1f}{}", title.to_lowercase(), artist.to_lowercase());
        if let Some(hit) = self.0.lock().ok().and_then(|cache| cache.get(&key).cloned()) { return hit; }
        let result = fetch(title, artist, duration_ms);
        // Falha de rede não fica em cache: abrir de novo tenta outra vez.
        if result.state != "error" { if let Ok(mut cache) = self.0.lock() {
            // Limite: um dia inteiro de músicas não pode crescer sem fim; 60 bastam para repetir.
            if cache.len() >= 60 { cache.clear(); }
            cache.insert(key, result.clone());
        } }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_stamps_metadata_and_repeated_lines() {
        let lines = parse_lrc("[ar:Keane]\n[00:30.37] I knew the pathway\n[01:02.5][02:10.00] Refrão\n[00:41.38]\nsem marca");
        assert_eq!(lines.iter().map(|line| (line.at_ms, line.text.as_str())).collect::<Vec<_>>(),
            [(30_370, "I knew the pathway"), (41_380, ""), (62_500, "Refrão"), (130_000, "Refrão")]);
    }
    #[test]
    fn cleans_video_suffixes_but_keeps_real_parentheses() {
        assert_eq!(clean_title("Somewhere Only We Know (Official Video)"), "Somewhere Only We Know");
        assert_eq!(clean_title("Song [Lyrics]  (feat. Ana)"), "Song (feat. Ana)");
    }
    #[test]
    fn prefers_synced_then_plain_then_instrumental() {
        let synced = to_lyrics(Record { instrumental: Some(false), plain_lyrics: Some("a".into()), synced_lyrics: Some("[00:01.00] a".into()), duration: None });
        assert_eq!(synced.state, "synced");
        assert_eq!(to_lyrics(Record { instrumental: None, plain_lyrics: Some("a".into()), synced_lyrics: None, duration: None }).state, "plain");
        assert_eq!(to_lyrics(Record { instrumental: Some(true), plain_lyrics: None, synced_lyrics: None, duration: None }).state, "instrumental");
    }
    #[test]
    fn picks_synced_version_with_closest_duration() {
        let record = |synced: bool, duration: f64| Record { instrumental: None, plain_lyrics: Some("a".into()), synced_lyrics: synced.then(|| format!("[00:01.00] {duration}")), duration: Some(duration) };
        let best = best_synced(vec![record(false, 434.0), record(true, 445.0), record(true, 436.0), record(true, 433.0)], Some(434_000)).unwrap();
        assert_eq!(best.duration, Some(433.0));
        assert!(best_synced(vec![record(true, 445.0), record(false, 434.0)], Some(434_000)).is_none());
        assert_eq!(best_synced(vec![record(true, 300.0)], None).unwrap().duration, Some(300.0));
    }
}
