use super::MAX_SAFE_INTEGER;
use chrono::DateTime;
use serde::Deserialize;
use serde_json::value::RawValue;

#[derive(Deserialize)]
struct Envelope<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    timestamp: Option<&'a str>,
    #[serde(borrow)]
    payload: &'a RawValue,
}
#[derive(Deserialize)]
struct Meta<'a> { id: &'a str }
#[derive(Deserialize)]
struct Event<'a> { #[serde(rename = "type")] kind: &'a str }
#[derive(Deserialize)]
struct Durable<'a> { thread_id: &'a str, response_id: &'a str, usage: Metrics }

#[derive(Debug, Deserialize, PartialEq, Eq)]
pub(super) struct Metrics {
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub cache_write_input_tokens: Option<u64>,
    pub output_tokens: u64,
    pub reasoning_output_tokens: u64,
    pub total_tokens: u64,
}
impl Metrics {
    fn valid(&self) -> bool {
        [self.input_tokens, self.cached_input_tokens, self.output_tokens, self.reasoning_output_tokens, self.total_tokens]
            .into_iter().chain(self.cache_write_input_tokens).all(|n| n <= MAX_SAFE_INTEGER)
            && self.cached_input_tokens <= self.input_tokens
            && self.reasoning_output_tokens <= self.output_tokens
            && self.cache_write_input_tokens.is_none_or(|n| n <= self.input_tokens)
    }
}
pub(super) struct Record { pub owner: String, pub id: String, pub at: i64, pub metrics: Metrics }
pub(super) enum Parsed { Meta(String, bool), Record(Record), Legacy(Option<super::quota::Observation>), Ignore, Invalid }

fn valid_id(id: &str) -> bool { !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control) }

pub(super) fn parse(bytes: &[u8]) -> Parsed {
    let Ok(envelope) = serde_json::from_slice::<Envelope<'_>>(bytes) else { return Parsed::Invalid; };
    match envelope.kind {
        "session_meta" => match serde_json::from_str::<Meta<'_>>(envelope.payload.get()) {
            Ok(meta) if valid_id(meta.id) => {
                let safe = serde_json::from_str(envelope.payload.get()).ok().is_some_and(|value| super::quota::safe_session(&value));
                Parsed::Meta(meta.id.to_owned(), safe)
            }, _ => Parsed::Invalid,
        },
        "token_usage_record" => {
            let Ok(record) = serde_json::from_str::<Durable<'_>>(envelope.payload.get()) else { return Parsed::Invalid; };
            let Some(at) = envelope.timestamp.and_then(|t| DateTime::parse_from_rfc3339(t).ok()) else { return Parsed::Invalid; };
            if !valid_id(record.thread_id) || !valid_id(record.response_id) || !record.usage.valid() { return Parsed::Invalid; }
            Parsed::Record(Record { owner: record.thread_id.into(), id: record.response_id.into(), at: at.timestamp(), metrics: record.usage })
        }
        "event_msg" => match serde_json::from_str::<Event<'_>>(envelope.payload.get()) {
            Ok(event) if event.kind == "token_count" => Parsed::Legacy(super::quota::parse(envelope.timestamp, envelope.payload.get())), _ => Parsed::Ignore,
        },
        _ => Parsed::Ignore,
    }
}
