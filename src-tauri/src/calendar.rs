// Agendas assinadas por link ICS (Google "endereço secreto no formato iCal", iCloud
// "calendário público", Outlook): só leitura. Os links ficam em calendars.json, só
// nesta máquina, e nunca voltam inteiros para a interface (são como senhas).
use chrono::{Datelike, Duration as Span, Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc, Weekday};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::{Arc, Condvar, Mutex}, thread, time::Duration};

const MAX_FEEDS: usize = 8;
const MAX_EVENTS: usize = 600;
const AHEAD_DAYS: i64 = 62;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Feed { pub id: String, pub name: String, pub color: String, pub url: String }

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Config { feeds: Vec<Feed> }

/// O que a interface vê de uma assinatura: nome, cor e só o domínio do link.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PublicFeed { pub id: String, pub name: String, pub color: String, pub host: String }

/// `url: None` mantém o link já salvo daquela assinatura.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedInput { pub id: String, pub name: String, pub color: String, pub url: Option<String> }

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeedEvent { pub id: String, pub title: String, pub at: i64, pub all_day: bool, pub feed: String, pub color: String }

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSnapshot { pub events: Vec<FeedEvent>, pub observed_at: Option<i64>, pub errors: Vec<String> }

fn host(url: &str) -> String { url.split("://").nth(1).unwrap_or(url).split('/').next().unwrap_or("").to_string() }
/// Link de compartilhamento/incorporação do Google (`?cid=` em base64 ou `embed?src=`)
/// vira o endereço ICS público da mesma agenda.
pub(crate) fn google_share_to_ics(url: &str) -> Option<String> {
    if !url.contains("calendar.google.com/calendar") || url.contains("/ical/") { return None; }
    let query = url.split_once('?')?.1;
    let param = |key: &str| query.split('&').find_map(|pair| pair.split_once('=').filter(|(k, _)| *k == key).map(|(_, v)| v.to_string()));
    let id = if let Some(cid) = param("cid") {
        let cid = crate::shelf::percent_decode(&cid);
        String::from_utf8(base64_decode(&cid)?).ok().filter(|id| id.contains('@') || id.contains('.'))?
    } else { crate::shelf::percent_decode(&param("src")?) };
    let encoded: String = id.bytes().map(|byte| if byte.is_ascii_alphanumeric() || b"-._".contains(&byte) { (byte as char).to_string() } else { format!("%{byte:02X}") }).collect();
    Some(format!("https://calendar.google.com/calendar/ical/{encoded}/public/basic.ics"))
}
fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let value = |c: u8| match c { b'A'..=b'Z' => Some(c - b'A'), b'a'..=b'z' => Some(c - b'a' + 26), b'0'..=b'9' => Some(c - b'0' + 52), b'+' | b'-' => Some(62), b'/' | b'_' => Some(63), _ => None };
    let mut out = Vec::new();
    let (mut buffer, mut bits) = (0u32, 0);
    for c in text.bytes().filter(|c| *c != b'=') {
        buffer = buffer << 6 | value(c)? as u32; bits += 6;
        if bits >= 8 { bits -= 8; out.push((buffer >> bits) as u8); buffer &= (1 << bits) - 1; }
    }
    Some(out)
}
fn normalize(url: &str) -> Option<String> {
    let url = url.trim();
    if let Some(ics) = google_share_to_ics(url) { return Some(ics); }
    let url = if let Some(rest) = url.strip_prefix("webcal://") { format!("https://{rest}") } else { url.to_string() };
    (url.starts_with("https://") && url.len() <= 2000 && !url.chars().any(char::is_whitespace)).then_some(url)
}
fn is_hex(color: &str) -> bool { color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit()) }

// ---------- ICS ----------

struct Prop { name: String, params: Vec<(String, String)>, value: String }

/// Desdobra linhas (RFC 5545: continuação começa com espaço/tab) e separa nome;params:valor.
fn props(text: &str) -> Vec<Prop> {
    let mut lines: Vec<String> = Vec::new();
    for raw in text.lines() {
        if (raw.starts_with(' ') || raw.starts_with('\t')) && !lines.is_empty() { lines.last_mut().unwrap().push_str(&raw[1..]); } else { lines.push(raw.to_string()); }
    }
    lines.into_iter().filter_map(|line| {
        let (head, value) = line.split_once(':')?;
        let mut parts = head.split(';');
        let name = parts.next()?.to_ascii_uppercase();
        let params = parts.filter_map(|param| param.split_once('=').map(|(k, v)| (k.to_ascii_uppercase(), v.trim_matches('"').to_string()))).collect();
        Some(Prop { name, params, value: value.to_string() })
    }).collect()
}

fn unescape(value: &str) -> String { value.replace("\\n", " ").replace("\\N", " ").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\") }

/// Horário de parede local. "…Z" vem em UTC; com TZID ou flutuante, vale o fuso desta
/// máquina (a agenda costuma estar no mesmo fuso); só data = dia inteiro.
fn when(prop: &Prop) -> Option<(NaiveDateTime, bool)> {
    let value = prop.value.trim();
    if value.len() == 8 || prop.params.iter().any(|(k, v)| k == "VALUE" && v == "DATE") {
        return NaiveDate::parse_from_str(&value[..8.min(value.len())], "%Y%m%d").ok().map(|date| (date.and_time(NaiveTime::MIN), true));
    }
    if let Some(utc) = value.strip_suffix('Z') {
        let naive = NaiveDateTime::parse_from_str(utc, "%Y%m%dT%H%M%S").ok()?;
        return Some((Utc.from_utc_datetime(&naive).with_timezone(&Local).naive_local(), false));
    }
    NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%S").ok().map(|naive| (naive, false))
}
fn stamp(naive: NaiveDateTime) -> Option<i64> { Local.from_local_datetime(&naive).earliest().map(|time| time.timestamp_millis()) }

struct Rule { freq: String, interval: i64, count: Option<usize>, until: Option<NaiveDateTime>, by_day: Vec<(i64, Weekday)>, by_month_day: Vec<i64> }

fn weekday(code: &str) -> Option<Weekday> {
    Some(match code { "MO" => Weekday::Mon, "TU" => Weekday::Tue, "WE" => Weekday::Wed, "TH" => Weekday::Thu, "FR" => Weekday::Fri, "SA" => Weekday::Sat, "SU" => Weekday::Sun, _ => return None })
}
fn rule(value: &str) -> Option<Rule> {
    let mut rule = Rule { freq: String::new(), interval: 1, count: None, until: None, by_day: Vec::new(), by_month_day: Vec::new() };
    for part in value.split(';') {
        let (key, val) = part.split_once('=')?;
        match key {
            "FREQ" => rule.freq = val.to_string(),
            "INTERVAL" => rule.interval = val.parse().ok().filter(|n: &i64| *n >= 1)?,
            "COUNT" => rule.count = val.parse().ok(),
            "UNTIL" => rule.until = when(&Prop { name: String::new(), params: Vec::new(), value: val.to_string() }).map(|(time, all_day)| if all_day { time + Span::days(1) - Span::seconds(1) } else { time }),
            "BYDAY" => rule.by_day = val.split(',').filter_map(|day| { let split = day.len().checked_sub(2)?; Some((day[..split].parse().unwrap_or(0), weekday(&day[split..])?)) }).collect(),
            "BYMONTHDAY" => rule.by_month_day = val.split(',').filter_map(|day| day.parse().ok()).collect(),
            _ => {}
        }
    }
    matches!(rule.freq.as_str(), "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY").then_some(rule)
}

fn month_add(date: NaiveDate, months: i64) -> (i32, u32) {
    let total = date.year() as i64 * 12 + date.month0() as i64 + months;
    ((total.div_euclid(12)) as i32, (total.rem_euclid(12)) as u32 + 1)
}
fn days_in(year: i32, month: u32) -> u32 {
    let next = if month == 12 { NaiveDate::from_ymd_opt(year + 1, 1, 1) } else { NaiveDate::from_ymd_opt(year, month + 1, 1) };
    next.and_then(|next| next.pred_opt()).map(|last| last.day()).unwrap_or(28)
}
/// n-ésimo dia da semana do mês (n<0 conta do fim; 0 = todos).
fn nth_weekdays(year: i32, month: u32, n: i64, day: Weekday) -> Vec<NaiveDate> {
    let all: Vec<NaiveDate> = (1..=days_in(year, month)).filter_map(|d| NaiveDate::from_ymd_opt(year, month, d)).filter(|date| date.weekday() == day).collect();
    match n { 0 => all, n if n > 0 => all.get(n as usize - 1).copied().into_iter().collect(), n => all.len().checked_sub((-n) as usize).and_then(|i| all.get(i).copied()).into_iter().collect() }
}

/// Ocorrências de uma regra a partir de `start`, até `end` (horário local).
fn expand(start: NaiveDateTime, rule: &Rule, end: NaiveDateTime) -> Vec<NaiveDateTime> {
    let time = start.time();
    let mut out = Vec::new();
    let mut emitted = 0usize;
    for step in 0..2000i64 {
        let n = step * rule.interval;
        let mut dates: Vec<NaiveDate> = match rule.freq.as_str() {
            "DAILY" => vec![start.date() + Span::days(n)],
            "WEEKLY" => {
                let monday = start.date() - Span::days(start.weekday().num_days_from_monday() as i64) + Span::weeks(n);
                if rule.by_day.is_empty() { vec![start.date() + Span::weeks(n)] } else { rule.by_day.iter().map(|(_, day)| monday + Span::days(day.num_days_from_monday() as i64)).collect() }
            }
            "MONTHLY" => {
                let (year, month) = month_add(start.date(), n);
                if !rule.by_day.is_empty() { rule.by_day.iter().flat_map(|(nth, day)| nth_weekdays(year, month, *nth, *day)).collect() }
                else {
                    let days = if rule.by_month_day.is_empty() { vec![start.day() as i64] } else { rule.by_month_day.clone() };
                    days.into_iter().filter_map(|d| { let max = days_in(year, month) as i64; let d = if d < 0 { max + 1 + d } else { d }; (1..=max).contains(&d).then(|| NaiveDate::from_ymd_opt(year, month, d as u32)).flatten() }).collect()
                }
            }
            _ => NaiveDate::from_ymd_opt(start.year() + n as i32, start.month(), start.day()).into_iter().collect(),
        };
        dates.sort();
        let mut past_end = false;
        for date in dates {
            let at = date.and_time(time);
            if at < start { continue; }
            if rule.until.is_some_and(|until| at > until) || at > end { past_end = true; break; }
            if rule.count.is_some_and(|count| emitted >= count) { return out; }
            emitted += 1;
            out.push(at);
        }
        if past_end || rule.count.is_some_and(|count| emitted >= count) || out.len() > MAX_EVENTS { break; }
    }
    out
}

/// Eventos de um arquivo ICS dentro da janela [from, to], já com repetições expandidas.
pub(crate) fn parse_ics(text: &str, feed: &Feed, from: NaiveDateTime, to: NaiveDateTime) -> Vec<FeedEvent> {
    #[derive(Default)]
    struct Raw { uid: String, title: String, start: Option<(NaiveDateTime, bool)>, rule: Option<String>, exdates: Vec<NaiveDateTime>, recurrence: Option<NaiveDateTime>, cancelled: bool }
    let mut raws: Vec<Raw> = Vec::new();
    let mut current: Option<Raw> = None;
    let mut depth = 0; // VALARM e afins dentro do VEVENT
    for prop in props(text) {
        match (prop.name.as_str(), prop.value.as_str()) {
            ("BEGIN", "VEVENT") => { current = Some(Raw::default()); depth = 0; continue; }
            ("END", "VEVENT") => { if let Some(raw) = current.take() { raws.push(raw); } continue; }
            ("BEGIN", _) if current.is_some() => { depth += 1; continue; }
            ("END", _) if current.is_some() => { depth -= 1; continue; }
            _ => {}
        }
        let Some(raw) = current.as_mut() else { continue };
        if depth > 0 { continue; }
        match prop.name.as_str() {
            "UID" => raw.uid = prop.value.clone(),
            "SUMMARY" => raw.title = unescape(&prop.value).trim().chars().take(140).collect(),
            "DTSTART" => raw.start = when(&prop),
            "RRULE" => raw.rule = Some(prop.value.clone()),
            "EXDATE" => for value in prop.value.split(',') { if let Some((time, _)) = when(&Prop { name: String::new(), params: prop.params.clone(), value: value.to_string() }) { raw.exdates.push(time); } },
            "RECURRENCE-ID" => raw.recurrence = when(&prop).map(|(time, _)| time),
            "STATUS" => raw.cancelled = prop.value.eq_ignore_ascii_case("CANCELLED"),
            _ => {}
        }
    }
    // Instâncias alteradas (RECURRENCE-ID) substituem a ocorrência original da série.
    let overridden: Vec<(String, NaiveDateTime)> = raws.iter().filter_map(|raw| raw.recurrence.map(|time| (raw.uid.clone(), time))).collect();
    let mut events = Vec::new();
    for raw in &raws {
        let Some((start, all_day)) = raw.start else { continue };
        if raw.cancelled { continue; }
        let title = if raw.title.is_empty() { "(sem título)".to_string() } else { raw.title.clone() };
        let occurrences = match (raw.recurrence, raw.rule.as_deref().and_then(rule)) {
            (None, Some(rule)) => expand(start, &rule, to).into_iter()
                .filter(|at| !raw.exdates.contains(at) && !overridden.iter().any(|(uid, time)| *uid == raw.uid && time == at)).collect(),
            _ => vec![start],
        };
        for at in occurrences {
            if at < from || at > to { continue; }
            let Some(ms) = stamp(at) else { continue };
            events.push(FeedEvent { id: format!("{}:{}:{}", feed.id, raw.uid, ms), title: title.clone(), at: ms, all_day, feed: feed.name.clone(), color: feed.color.clone() });
        }
    }
    events
}

// ---------- estado e busca ----------

struct State { config: Config, snapshot: CalendarSnapshot, wake: u64, stopped: bool }
pub struct Calendars { shared: Arc<(Mutex<State>, Condvar)>, path: PathBuf }

impl Calendars {
    pub fn start(path: PathBuf) -> Self {
        let mut config: Config = std::fs::read(&path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
        for feed in &mut config.feeds { if let Some(ics) = google_share_to_ics(&feed.url) { feed.url = ics; } }
        let shared = Arc::new((Mutex::new(State { config, snapshot: CalendarSnapshot::default(), wake: 0, stopped: false }), Condvar::new()));
        let worker = shared.clone();
        let _ = thread::Builder::new().name("heydesk-calendars".into()).spawn(move || run(worker));
        Self { shared, path }
    }
    pub fn snapshot(&self) -> CalendarSnapshot { self.shared.0.lock().map(|state| state.snapshot.clone()).unwrap_or_default() }
    pub fn feeds(&self) -> Vec<PublicFeed> {
        self.shared.0.lock().map(|state| state.config.feeds.iter().map(|feed| PublicFeed { id: feed.id.clone(), name: feed.name.clone(), color: feed.color.clone(), host: host(&feed.url) }).collect()).unwrap_or_default()
    }
    pub fn save(&self, inputs: Vec<FeedInput>) -> Result<Vec<PublicFeed>, String> {
        if inputs.len() > MAX_FEEDS { return Err(format!("No máximo {MAX_FEEDS} agendas.")); }
        let mut state = self.shared.0.lock().map_err(|_| "Agenda indisponível.".to_string())?;
        let mut feeds = Vec::new();
        for input in inputs {
            let name = input.name.trim().chars().take(40).collect::<String>();
            if input.id.is_empty() || input.id.len() > 40 || !is_hex(&input.color) { return Err("Agenda inválida.".into()); }
            let url = match input.url {
                Some(url) => normalize(&url).ok_or("O link precisa começar com https:// ou webcal://.")?,
                None => state.config.feeds.iter().find(|feed| feed.id == input.id).map(|feed| feed.url.clone()).ok_or("Link da agenda ausente.")?,
            };
            feeds.push(Feed { id: input.id, name: if name.is_empty() { host(&url) } else { name }, color: input.color, url });
        }
        let config = Config { feeds };
        let bytes = serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?;
        crate::settings::atomic_write(&self.path, &bytes).map_err(|error| format!("Não foi possível salvar: {error}"))?;
        state.config = config; state.wake += 1;
        drop(state);
        self.shared.1.notify_all();
        Ok(self.feeds())
    }
}
impl Drop for Calendars {
    fn drop(&mut self) { if let Ok(mut state) = self.shared.0.lock() { state.stopped = true; } self.shared.1.notify_all(); }
}

// Atualiza a cada 15 min, ou logo depois de salvar as assinaturas.
fn run(shared: Arc<(Mutex<State>, Condvar)>) {
    loop {
        let (config, wake) = match shared.0.lock() { Ok(state) if !state.stopped => (state.config.clone(), state.wake), _ => return };
        let now = Local::now().naive_local();
        let (from, to) = (now - Span::days(1), now + Span::days(AHEAD_DAYS));
        let mut events = Vec::new();
        let mut errors = Vec::new();
        let client = reqwest::blocking::Client::builder().https_only(true).timeout(Duration::from_secs(15)).user_agent("Heydesk").build().ok();
        for feed in &config.feeds {
            let text = client.as_ref().ok_or_else(|| "sem rede".to_string())
                .and_then(|client| client.get(&feed.url).send().map_err(|_| "sem resposta".to_string()))
                .and_then(|response| if response.status().is_success() { response.text().map_err(|_| "resposta inválida".to_string()) } else { Err(format!("HTTP {}", response.status().as_u16())) });
            match text {
                Ok(text) if text.contains("BEGIN:VCALENDAR") => events.extend(parse_ics(&text, feed, from, to)),
                Ok(_) if host(&feed.url) == "calendar.google.com" => errors.push(format!("{}: use o Endereço secreto no formato iCal (Configurações da agenda › Integrar agenda)", feed.name)),
                Ok(_) => errors.push(format!("{}: o link não é uma agenda ICS", feed.name)),
                Err(error) if host(&feed.url) == "calendar.google.com" && error.starts_with("HTTP 404") => errors.push(format!("{}: agenda não é pública; use o Endereço secreto no formato iCal (Configurações da agenda › Integrar agenda)", feed.name)),
                Err(error) => errors.push(format!("{}: {error}", feed.name)),
            }
        }
        events.sort_by_key(|event: &FeedEvent| event.at);
        events.truncate(MAX_EVENTS);
        let Ok(mut state) = shared.0.lock() else { return };
        if state.wake != wake { continue; }
        state.snapshot = CalendarSnapshot { events, observed_at: Some(Utc::now().timestamp_millis()), errors };
        let _ = shared.1.wait_timeout_while(state, Duration::from_secs(900), |state| state.wake == wake && !state.stopped);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn feed() -> Feed { Feed { id: "g".into(), name: "Google".into(), color: "#4285F4".into(), url: "https://x/ics".into() } }
    fn at(text: &str) -> NaiveDateTime { NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M").unwrap() }
    fn local(ms: i64) -> String { Local.timestamp_millis_opt(ms).unwrap().format("%Y-%m-%d %H:%M").to_string() }

    #[test]
    fn single_events_fold_lines_and_skip_cancelled() {
        let ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nSUMMARY:Reunião com\r\n  time\\, sala 2\r\nDTSTART;TZID=America/Sao_Paulo:20261030T153000\r\nBEGIN:VALARM\r\nTRIGGER:-PT10M\r\nSUMMARY:alarme\r\nEND:VALARM\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:2\r\nSUMMARY:Cancelado\r\nSTATUS:CANCELLED\r\nDTSTART:20261030T180000\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:3\r\nSUMMARY:Feriado\r\nDTSTART;VALUE=DATE:20261102\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let events = parse_ics(ics, &feed(), at("2026-10-01 00:00"), at("2026-12-01 00:00"));
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].title, "Reunião com time, sala 2");
        assert_eq!(local(events[0].at), "2026-10-30 15:30");
        assert!(events[1].all_day);
        assert_eq!(local(events[1].at), "2026-11-02 00:00");
    }

    #[test]
    fn weekly_rule_honours_byday_count_exdate_and_overrides() {
        let ics = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:s\nSUMMARY:Daily\nDTSTART:20261026T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6\nEXDATE:20261028T090000\nEND:VEVENT\nBEGIN:VEVENT\nUID:s\nRECURRENCE-ID:20261102T090000\nSUMMARY:Daily (movida)\nDTSTART:20261102T110000\nEND:VEVENT\nEND:VCALENDAR\n";
        let events = parse_ics(ics, &feed(), at("2026-10-01 00:00"), at("2026-12-31 00:00"));
        let mut times: Vec<String> = events.iter().map(|event| format!("{} {}", local(event.at), event.title)).collect();
        times.sort();
        assert_eq!(times, vec!["2026-10-26 09:00 Daily", "2026-11-02 11:00 Daily (movida)", "2026-11-04 09:00 Daily", "2026-11-09 09:00 Daily", "2026-11-11 09:00 Daily"]);
    }

    #[test]
    fn monthly_nth_weekday_and_until() {
        let rule = rule("FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20261231T235959Z").unwrap();
        let dates: Vec<String> = expand(at("2026-10-30 10:00"), &rule, at("2027-06-01 00:00")).iter().map(|time| time.format("%m-%d").to_string()).collect();
        assert_eq!(dates, vec!["10-30", "11-27", "12-25"]);
        let daily = rule_daily();
        assert_eq!(expand(at("2026-10-30 08:00"), &daily, at("2026-11-05 00:00")).len(), 3);
    }
    fn rule_daily() -> Rule { rule("FREQ=DAILY;INTERVAL=2").unwrap() }

    #[test]
    fn links_are_normalized_and_hidden() {
        assert_eq!(normalize("webcal://p01-caldav.icloud.com/published/2/abc").as_deref(), Some("https://p01-caldav.icloud.com/published/2/abc"));
        assert_eq!(normalize("http://insecure/x.ics"), None);
        // cid = base64("pessoa@example.com")
        assert_eq!(normalize("https://calendar.google.com/calendar/u/0?cid=cGVzc29hQGV4YW1wbGUuY29t").as_deref(), Some("https://calendar.google.com/calendar/ical/pessoa%40example.com/public/basic.ics"));
        assert_eq!(normalize("https://calendar.google.com/calendar/embed?src=pt-br.brazilian%23holiday%40group.v.calendar.google.com&ctz=America%2FSao_Paulo").as_deref(), Some("https://calendar.google.com/calendar/ical/pt-br.brazilian%23holiday%40group.v.calendar.google.com/public/basic.ics"));
        assert_eq!(host("https://calendar.google.com/calendar/ical/secret/basic.ics"), "calendar.google.com");
    }
}
