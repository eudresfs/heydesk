// Ficha da faixa (álbum, ano, gênero e capa) pela busca pública do iTunes, sob demanda: só quando o
// Player está aberto. A consulta envia artista e título; nada mais sai da máquina.
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Mutex, time::Duration};

const SEARCH: &str = "https://itunes.apple.com/search";
const MAX_ART: u64 = 768 * 1024;

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackInfo {
    pub album: Option<String>,
    pub year: Option<u32>,
    pub genre: Option<String>,
    /// Capa 600×600 como data URL.
    pub art: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Song {
    #[serde(default)] track_name: String,
    #[serde(default)] artist_name: String,
    collection_name: Option<String>,
    release_date: Option<String>,
    primary_genre_name: Option<String>,
    artwork_url100: Option<String>,
    track_time_millis: Option<u64>,
}

#[derive(Deserialize)]
struct Results { #[serde(default)] results: Vec<Song> }

/// Comparação sem caixa, acentos de pontuação e sufixos entre parênteses ("(Remastered)", "(Live)").
fn plain(text: &str) -> String {
    let base = text.split(['(', '[']).next().unwrap_or(text);
    base.chars().filter(|ch| ch.is_alphanumeric() || ch.is_whitespace()).collect::<String>().to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Artista principal: "A & B", "A, B" e "A feat. B" contam como A.
fn main_artist(name: &str) -> String {
    let lower = name.to_lowercase();
    let cut = [" & ", ", ", " feat. ", " feat ", " ft. ", " x "].iter().filter_map(|sep| lower.find(sep)).min().unwrap_or(lower.len());
    plain(&lower[..cut])
}

/// Mesma música do mesmo artista (tributos e "Calm Down Oasis" ficam de fora). Entre as versões, a de
/// duração mais próxima, evitando ao vivo, remaster, coletânea, single e EP. As datas do iTunes não
/// servem para desempate: coletâneas aparecem com o ano da faixa original.
pub(crate) fn best(songs: Vec<Song>, title: &str, artist: &str, duration_ms: Option<u64>) -> Option<Song> {
    let (title, artist) = (plain(title), main_artist(artist));
    if title.is_empty() { return None; }
    let gap = |song: &Song| match (duration_ms, song.track_time_millis) { (Some(a), Some(b)) => a.abs_diff(b) / 1000, _ => 0 };
    let penalty = |song: &Song| {
        let album = song.collection_name.as_deref().unwrap_or_default().to_lowercase();
        let mut score = gap(song);
        if song.track_name.contains(['(', '[']) { score += 3; }
        if album.ends_with(" - single") || album.ends_with(" - ep") { score += 2; }
        if ["deluxe", "remaster", "edition", "live", "best of", "greatest", "hits", "collection", "anthology", "essential"].iter().any(|word| album.contains(word)) { score += 3; }
        score
    };
    songs.into_iter()
        .filter(|song| plain(&song.track_name) == title && (artist.is_empty() || main_artist(&song.artist_name) == artist))
        .filter(|song| gap(song) <= 15)
        .min_by_key(|song| penalty(song))
}

fn year(date: &str) -> Option<u32> { date.get(..4)?.parse().ok().filter(|year| (1900..=2100).contains(year)) }

fn fetch(title: &str, artist: &str, duration_ms: Option<u64>) -> Option<TrackInfo> {
    let client = reqwest::blocking::Client::builder().https_only(true).timeout(Duration::from_secs(8))
        .user_agent("Heydesk (Windows notch; track info on demand)").build().ok()?;
    let term = format!("{artist} {}", crate::lyrics::clean_title(title));
    let response = client.get(SEARCH).query(&[("term", term.trim()), ("media", "music"), ("entity", "song"), ("limit", "25")]).send().ok()?;
    if !response.status().is_success() { return None; }
    let songs = response.json::<Results>().ok()?.results;
    let song = best(songs, &crate::lyrics::clean_title(title), artist, duration_ms)?;
    // Só imagens do CDN da Apple, ampliadas de 100×100 para 600×600.
    let art = song.artwork_url100.as_deref()
        .filter(|url| url.parse::<tauri::Url>().is_ok_and(|parsed| parsed.scheme() == "https" && parsed.host_str().is_some_and(|host| host.ends_with(".mzstatic.com"))))
        .and_then(|url| {
            let response = client.get(url.replace("100x100bb", "600x600bb")).send().ok().filter(|response| response.status().is_success())?;
            if response.content_length().is_some_and(|length| length > MAX_ART) { return None; }
            let kind = response.headers().get("content-type").and_then(|value| value.to_str().ok()).filter(|kind| kind.starts_with("image/")).unwrap_or("image/jpeg").to_string();
            let bytes = response.bytes().ok().filter(|bytes| !bytes.is_empty() && bytes.len() as u64 <= MAX_ART)?;
            Some(format!("data:{kind};base64,{}", crate::desktop_context::base64(&bytes)))
        });
    Some(TrackInfo { album: song.collection_name.filter(|album| !album.trim().is_empty()), year: song.release_date.as_deref().and_then(year), genre: song.primary_genre_name, art })
}

#[derive(Default)]
pub struct TrackInfoCache(Mutex<HashMap<String, Option<TrackInfo>>>);
impl TrackInfoCache {
    /// `None`: nada confiável encontrado (ou sem rede); a interface fica só com o que o Windows informa.
    pub fn get(&self, title: &str, artist: &str, duration_ms: Option<u64>) -> Option<TrackInfo> {
        let key = format!("{}\u{1f}{}", title.to_lowercase(), artist.to_lowercase());
        if let Some(hit) = self.0.lock().ok().and_then(|cache| cache.get(&key).cloned()) { return hit; }
        let result = fetch(title, artist, duration_ms);
        if let Ok(mut cache) = self.0.lock() {
            if cache.len() >= 60 { cache.clear(); }
            cache.insert(key, result.clone());
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn song(name: &str, artist: &str, album: &str, date: &str, ms: u64) -> Song {
        Song { track_name: name.into(), artist_name: artist.into(), collection_name: Some(album.into()), release_date: Some(date.into()), primary_genre_name: None, artwork_url100: None, track_time_millis: Some(ms) }
    }
    #[test]
    fn picks_original_album_of_same_artist() {
        let songs = vec![
            song("Running Alone (Live)", "Angra", "Live", "2003-01-01", 445_000),
            song("Running Alone", "Angra", "The Best of Angra", "2010-01-01", 434_000),
            song("Running Alone", "Angra", "Rebirth", "2001-11-01", 436_000),
            song("Running Alone", "Outro", "X", "1990-01-01", 434_000),
            song("Running Alone", "Calm Down Angra", "Y", "1980-01-01", 434_000),
            song("Carry On", "Angra", "Angels Cry", "1993-01-01", 434_000),
        ];
        let rebirth = best(songs, "Running Alone", "Angra", Some(434_000)).unwrap();
        assert_eq!(rebirth.collection_name.as_deref(), Some("Rebirth"));
        assert_eq!(year("2001-11-01T08:00:00Z"), Some(2001));
        let oasis = vec![
            song("Stand By Me", "Oasis", "Stand By Me - EP", "1987-08-21", 356_627),
            song("Stand By Me", "Oasis", "Time Flies...1994-2009", "1987-08-21", 359_480),
            song("Stand By Me", "Oasis", "Be Here Now", "1997-08-21", 356_627),
        ];
        assert_eq!(best(oasis, "Stand by Me", "Oasis", Some(357_000)).unwrap().collection_name.as_deref(), Some("Be Here Now"));
    }
    #[test]
    fn rejects_far_duration_and_empty_title() {
        assert!(best(vec![song("A", "B", "C", "2000", 100_000)], "A", "B", Some(200_000)).is_none());
        assert!(best(vec![song("A", "B", "C", "2000", 100_000)], "", "B", None).is_none());
    }
}
