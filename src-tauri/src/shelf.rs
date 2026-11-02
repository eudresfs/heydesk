// Prateleira de arquivos, nos dois sentidos: o celular (Android ou iPhone) envia e
// baixa pela rede local lendo um QR code; no PC, arquivos entram pelo botão ou arrastando. Enquanto "Receber" está ligado, um servidor HTTP mínimo escuta só no IP da
// rede local, numa porta aleatória, e só aceita caminhos com um token aleatório de
// 128 bits; desliga sozinho em 10 min sem uso. Os arquivos ficam em
// %LOCALAPPDATA%\dev.heydesk.app\shelf, só nesta máquina.
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    net::{IpAddr, TcpListener, TcpStream, UdpSocket},
    path::{Path, PathBuf},
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

pub const CHANGED_EVENT: &str = "shelf:changed";
const MAX_FILE: u64 = 2 * 1024 * 1024 * 1024;
const MAX_ITEMS: usize = 200;
/// Pelo botão "Adicionar" o arquivo passa pela memória; acima disso, arrastar (copia do disco).
const MAX_INLINE: usize = 512 * 1024 * 1024;
const IDLE: Duration = Duration::from_secs(600);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item { pub id: String, pub name: String, pub size: u64, pub added_at: i64 }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiveInfo { pub url: String, pub qr_size: usize, pub qr: String, pub expires_at: i64 }

struct Session { info: ReceiveInfo, stop: Arc<AtomicBool> }
/// `received`: itens que chegaram do celular nesta sessão — só eles aparecem para o celular.
struct Inner { items: Vec<Item>, session: Option<Session>, received: Vec<String> }
pub struct Shelf { inner: Arc<Mutex<Inner>>, dir: PathBuf, thumbs: Mutex<std::collections::HashMap<String, Option<String>>> }

fn now_ms() -> i64 { chrono::Utc::now().timestamp_millis() }
fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buffer = vec![0u8; bytes];
    getrandom::getrandom(&mut buffer).map_err(|_| "Sem gerador aleatório.".to_string())?;
    Ok(buffer.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Nome seguro para gravar no Windows: só o último componente, sem caracteres proibidos.
pub(crate) fn safe_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base.chars().map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c }).collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    let stem = trimmed.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "LPT1", "LPT2", "LPT3"].contains(&stem.as_str());
    let name: String = if trimmed.is_empty() || reserved { format!("arquivo{}", if reserved { format!("_{trimmed}") } else { String::new() }) } else { trimmed.to_string() };
    name.chars().take(120).collect()
}

pub fn percent_decode(value: &str) -> String {
    let hex = |byte: u8| (byte as char).to_digit(16).map(|digit| digit as u8);
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) { out.push(high << 4 | low); i += 3; continue; }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// IP desta máquina na rede local (a rota padrão), sem enviar nada.
fn lan_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then_some(ip)
}

fn qr(url: &str) -> Result<(usize, String), String> {
    let code = qrcode::QrCode::new(url.as_bytes()).map_err(|_| "QR inválido.".to_string())?;
    let size = code.width();
    let modules = code.to_colors().iter().map(|color| if *color == qrcode::Color::Dark { '1' } else { '0' }).collect();
    Ok((size, modules))
}

impl Shelf {
    pub fn new(dir: PathBuf) -> Self {
        let items: Vec<Item> = std::fs::read(dir.join("shelf.json")).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
        // Só lista o que ainda existe no disco.
        let items = items.into_iter().filter(|item| dir.join("files").join(&item.id).join(&item.name).is_file()).collect();
        Self { inner: Arc::new(Mutex::new(Inner { items, session: None, received: Vec::new() })), dir, thumbs: Mutex::new(Default::default()) }
    }
    pub fn items(&self) -> Vec<Item> { self.inner.lock().map(|inner| inner.items.clone()).unwrap_or_default() }
    pub fn path_of(&self, id: &str) -> Option<PathBuf> {
        let inner = self.inner.lock().ok()?;
        inner.items.iter().find(|item| item.id == id).map(|item| self.dir.join("files").join(&item.id).join(&item.name))
    }
    /// Arquivo vindo da interface (bytes) ou arrastado do Explorador (caminho).
    pub fn add_bytes(&self, app: &AppHandle, name: &str, bytes: &[u8]) -> Result<Item, String> {
        if bytes.len() > MAX_INLINE { return Err("Arquivo grande demais; arraste-o para o notch.".into()); }
        let item = store(&self.dir, name, &mut &bytes[..], bytes.len() as u64).map_err(|error| error.to_string())?;
        insert(&self.inner, &self.dir, app, item)
    }
    pub fn add_path(&self, app: &AppHandle, path: &Path) -> Result<Item, String> {
        let meta = std::fs::metadata(path).map_err(|_| "Arquivo não encontrado.".to_string())?;
        if !meta.is_file() { return Err("Pastas ainda não entram na prateleira.".into()); }
        if meta.len() > MAX_FILE { return Err("Arquivo maior que 2 GB.".into()); }
        let name = path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
        let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
        let item = store(&self.dir, &name, &mut file, meta.len()).map_err(|error| error.to_string())?;
        // Mantém a marca "veio da internet" do original (SmartScreen, Office em modo protegido).
        mark_from_internet(&self.dir.join("files").join(&item.id).join(&item.name), Some(path));
        insert(&self.inner, &self.dir, app, item)
    }
    /// Miniatura do Windows (foto, vídeo, PDF ou ícone do tipo) como data URL.
    pub fn thumbnail(&self, id: &str) -> Option<String> {
        if let Some(cached) = self.thumbs.lock().ok()?.get(id) { return cached.clone(); }
        let path = self.path_of(id)?;
        let thumb = thumbnail_of(&path).map(|(kind, bytes)| format!("data:{kind};base64,{}", base64_of(&bytes)));
        if let Ok(mut thumbs) = self.thumbs.lock() { thumbs.insert(id.to_string(), thumb.clone()); }
        thumb
    }
    /// Para arrastar o arquivo para fora: caminho real e uma imagem para o cursor
    /// (a miniatura do Windows, ou o ícone do app).
    pub fn drag_info(&self, id: &str) -> Option<(PathBuf, PathBuf)> {
        let path = self.path_of(id)?;
        let icons = self.dir.join("drag");
        std::fs::create_dir_all(&icons).ok()?;
        let icon = match thumbnail_of(&path) {
            Some((kind, bytes)) => { let file = icons.join(format!("{id}.{}", if kind.contains("png") { "png" } else { "jpg" })); std::fs::write(&file, bytes).ok()?; file }
            None => { let file = icons.join("heydesk.png"); if !file.exists() { std::fs::write(&file, include_bytes!("../icons/icon.png")).ok()?; } file }
        };
        Some((path, icon))
    }
    pub fn remove(&self, id: &str) -> Result<Vec<Item>, String> {
        let mut inner = self.inner.lock().map_err(|_| "Prateleira indisponível.".to_string())?;
        if !id.chars().all(|c| c.is_ascii_hexdigit()) { return Err("Item inválido.".into()); }
        inner.items.retain(|item| item.id != id);
        let _ = std::fs::remove_dir_all(self.dir.join("files").join(id));
        persist(&self.dir, &inner.items)?;
        Ok(inner.items.clone())
    }

    pub fn start(&self, app: AppHandle) -> Result<ReceiveInfo, String> {
        let mut inner = self.inner.lock().map_err(|_| "Prateleira indisponível.".to_string())?;
        if let Some(session) = &inner.session {
            if !session.stop.load(Ordering::Relaxed) { return Ok(session.info.clone()); }
        }
        let ip = lan_ip().ok_or("Sem rede local. Conecte o PC ao Wi-Fi ou cabo.")?;
        let listener = TcpListener::bind((ip, 0)).map_err(|error| format!("Não foi possível abrir a porta: {error}"))?;
        listener.set_nonblocking(true).map_err(|error| error.to_string())?;
        let port = listener.local_addr().map_err(|error| error.to_string())?.port();
        let token = random_hex(16)?;
        let url = format!("http://{ip}:{port}/{token}");
        let (qr_size, qr) = qr(&url)?;
        let info = ReceiveInfo { url, qr_size, qr, expires_at: now_ms() + IDLE.as_millis() as i64 };
        let stop = Arc::new(AtomicBool::new(false));
        let touched = Arc::new(Mutex::new(Instant::now()));
        inner.session = Some(Session { info: info.clone(), stop: stop.clone() });
        inner.received.clear();
        drop(inner);
        let (shared, dir) = (self.inner.clone(), self.dir.clone());
        thread::Builder::new().name("heydesk-shelf".into()).spawn(move || serve(listener, token, stop, touched, shared, dir, app)).map_err(|error| error.to_string())?;
        Ok(info)
    }
    pub fn stop(&self) {
        if let Ok(mut inner) = self.inner.lock() { if let Some(session) = inner.session.take() { session.stop.store(true, Ordering::Relaxed); } }
    }
    pub fn receiving(&self) -> Option<ReceiveInfo> {
        let inner = self.inner.lock().ok()?;
        inner.session.as_ref().filter(|session| !session.stop.load(Ordering::Relaxed)).map(|session| session.info.clone())
    }
}
impl Drop for Shelf { fn drop(&mut self) { self.stop(); } }

/// Grava `length` bytes de `source` numa pasta própria do item.
fn store(dir: &Path, raw_name: &str, source: &mut dyn Read, length: u64) -> std::io::Result<Item> {
    let name = safe_name(raw_name);
    let id = random_hex(8).map_err(std::io::Error::other)?;
    let folder = dir.join("files").join(&id);
    std::fs::create_dir_all(&folder)?;
    let result = (|| {
        let mut file = std::fs::File::create(folder.join(&name))?;
        let copied = std::io::copy(&mut source.take(length), &mut file)?;
        if copied != length { return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "cópia incompleta")); }
        file.sync_all()
    })();
    if let Err(error) = result { let _ = std::fs::remove_dir_all(&folder); return Err(error); }
    Ok(Item { id, name, size: length, added_at: now_ms() })
}

/// Põe o item no topo, respeita o limite (os mais antigos saem com seus arquivos) e avisa.
fn insert(shared: &Mutex<Inner>, dir: &Path, app: &AppHandle, item: Item) -> Result<Item, String> {
    let mut inner = shared.lock().map_err(|_| "Prateleira indisponível.".to_string())?;
    inner.items.insert(0, item.clone());
    while inner.items.len() > MAX_ITEMS { if let Some(old) = inner.items.pop() { let _ = std::fs::remove_dir_all(dir.join("files").join(&old.id)); } }
    persist(dir, &inner.items)?;
    drop(inner);
    let _ = app.emit(CHANGED_EVENT, item.clone());
    Ok(item)
}

#[cfg(windows)]
fn base64_of(bytes: &[u8]) -> String { crate::desktop_context::base64(bytes) }
#[cfg(not(windows))]
fn base64_of(_: &[u8]) -> String { String::new() }

#[cfg(windows)]
fn thumbnail_of(path: &Path) -> Option<(String, Vec<u8>)> {
    use ::windows::{core::HSTRING, Storage::{FileProperties::{ThumbnailMode, ThumbnailOptions}, StorageFile, Streams::DataReader}};
    macro_rules! wait {
        ($operation:expr) => {{
            let operation = $operation.ok()?;
            let deadline = Instant::now() + Duration::from_secs(5);
            while operation.Status().ok()?.0 == 0 { if Instant::now() >= deadline { let _ = operation.Cancel(); return None; } thread::sleep(Duration::from_millis(15)); }
            operation.GetResults().ok()?
        }};
    }
    let file = wait!(StorageFile::GetFileFromPathAsync(&HSTRING::from(path.as_os_str())));
    let thumb = wait!(file.GetThumbnailAsync(ThumbnailMode::SingleItem, 192, ThumbnailOptions::ResizeThumbnail));
    let size = u32::try_from(thumb.Size().ok()?).ok().filter(|size| *size > 0 && *size <= 2 * 1024 * 1024)?;
    let kind = thumb.ContentType().ok().map(|kind| kind.to_string()).filter(|kind| kind.starts_with("image/")).unwrap_or_else(|| "image/png".into());
    let reader = DataReader::CreateDataReader(&thumb).ok()?;
    let loaded = wait!(reader.LoadAsync(size));
    let mut bytes = vec![0u8; loaded as usize];
    reader.ReadBytes(&mut bytes).ok()?;
    Some((kind, bytes))
}
#[cfg(not(windows))]
fn thumbnail_of(_: &Path) -> Option<(String, Vec<u8>)> { None }

/// `Content-Disposition` com nome ASCII de reserva e o nome real em UTF-8 (RFC 5987).
pub(crate) fn disposition(name: &str) -> String {
    let ascii: String = name.chars().map(|c| if c.is_ascii_graphic() && c != '"' && c != '\\' || c == ' ' { c } else { '_' }).collect();
    let encoded: String = name.bytes().map(|byte| if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) { (byte as char).to_string() } else { format!("%{byte:02X}") }).collect();
    format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{encoded}")
}

fn persist(dir: &Path, items: &[Item]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec_pretty(items).map_err(|error| error.to_string())?;
    crate::settings::atomic_write(&dir.join("shelf.json"), &bytes).map_err(|error| format!("Não foi possível salvar: {error}"))
}

fn serve(listener: TcpListener, token: String, stop: Arc<AtomicBool>, touched: Arc<Mutex<Instant>>, shared: Arc<Mutex<Inner>>, dir: PathBuf, app: AppHandle) {
    while !stop.load(Ordering::Relaxed) {
        if touched.lock().map(|at| at.elapsed() > IDLE).unwrap_or(true) { break; }
        match listener.accept() {
            Ok((stream, _)) => {
                let (token, touched, shared, dir, app) = (token.clone(), touched.clone(), shared.clone(), dir.clone(), app.clone());
                let _ = thread::Builder::new().name("heydesk-shelf-conn".into()).spawn(move || { let _ = handle(stream, &token, &touched, &shared, &dir, &app); });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(60)),
            Err(_) => thread::sleep(Duration::from_millis(200)),
        }
    }
    stop.store(true, Ordering::Relaxed);
    if let Ok(mut inner) = shared.lock() { if inner.session.as_ref().is_some_and(|session| session.stop.load(Ordering::Relaxed)) { inner.session = None; } }
    let _ = app.emit(CHANGED_EVENT, ());
}

fn respond(stream: &mut TcpStream, status: &str, kind: &str, body: &[u8]) -> std::io::Result<()> {
    write!(stream, "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n", body.len())?;
    stream.write_all(body)
}

fn handle(mut stream: TcpStream, token: &str, touched: &Mutex<Instant>, shared: &Mutex<Inner>, dir: &Path, app: &AppHandle) -> std::io::Result<()> {
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    let mut buffer = Vec::with_capacity(8192);
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        let read = stream.read(&mut chunk)?;
        if read == 0 { return Ok(()); }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(at) = buffer.windows(4).position(|window| window == b"\r\n\r\n") { break at + 4; }
        if buffer.len() > 16 * 1024 { return respond(&mut stream, "431 Request Header Fields Too Large", "text/plain", b""); }
    };
    let head = String::from_utf8_lossy(&buffer[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let mut request = lines.next().unwrap_or("").split(' ');
    let (method, path) = (request.next().unwrap_or(""), request.next().unwrap_or(""));
    let header = |name: &str| head.split("\r\n").skip(1).find_map(|line| line.split_once(':').filter(|(key, _)| key.trim().eq_ignore_ascii_case(name)).map(|(_, value)| value.trim().to_string()));
    let page = format!("/{token}");
    let upload = format!("/{token}/up");
    if method == "GET" && path == page {
        if let Ok(mut at) = touched.lock() { *at = Instant::now(); }
        return respond(&mut stream, "200 OK", "text/html; charset=utf-8", PAGE.as_bytes());
    }
    if method == "GET" && path == format!("/{token}/list") {
        // O celular vê só o que ele mesmo mandou nesta sessão, não a prateleira inteira do PC.
        let items: Vec<Item> = shared.lock().map(|inner| inner.items.iter().filter(|item| inner.received.contains(&item.id)).cloned().collect()).unwrap_or_default();
        let body = serde_json::to_vec(&items).unwrap_or_default();
        return respond(&mut stream, "200 OK", "application/json", &body);
    }
    if let Some(id) = path.strip_prefix(&format!("/{token}/f/")).filter(|_| method == "GET") {
        let found = shared.lock().ok().and_then(|inner| inner.items.iter().find(|item| item.id == id && inner.received.iter().any(|received| received == id)).cloned());
        let Some(item) = found else { return respond(&mut stream, "404 Not Found", "text/plain", b"") };
        let mut file = std::fs::File::open(dir.join("files").join(&item.id).join(&item.name))?;
        let length = file.metadata()?.len();
        write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {length}\r\nContent-Disposition: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n", disposition(&item.name))?;
        if let Ok(mut at) = touched.lock() { *at = Instant::now(); }
        std::io::copy(&mut file, &mut stream)?;
        return Ok(());
    }
    if method != "POST" || path != upload { return respond(&mut stream, "404 Not Found", "text/plain", b""); }
    let Some(length) = header("content-length").and_then(|value| value.parse::<u64>().ok()) else { return respond(&mut stream, "411 Length Required", "text/plain", b"") };
    if length > MAX_FILE { return respond(&mut stream, "413 Payload Too Large", "text/plain", "Arquivo maior que 2 GB.".as_bytes()); }
    let name = percent_decode(&header("x-name").unwrap_or_default());
    // O corpo começa no que já veio junto do cabeçalho e segue no socket.
    let first = buffer[head_end..].to_vec();
    struct Body<'a> { first: std::io::Cursor<Vec<u8>>, stream: &'a mut TcpStream, touched: &'a Mutex<Instant> }
    impl Read for Body<'_> {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            let read = self.first.read(out)?;
            if read > 0 { return Ok(read); }
            if let Ok(mut at) = self.touched.lock() { *at = Instant::now(); }
            self.stream.read(out)
        }
    }
    let stored = store(dir, &name, &mut Body { first: std::io::Cursor::new(first), stream: &mut stream, touched }, length);
    let Ok(item) = stored else { let _ = respond(&mut stream, "400 Bad Request", "text/plain", b""); return Ok(()) };
    mark_from_internet(&dir.join("files").join(&item.id).join(&item.name), None);
    let id = item.id.clone();
    if insert(shared, dir, app, item).is_err() { return respond(&mut stream, "500 Internal Server Error", "text/plain", b""); }
    if let Ok(mut inner) = shared.lock() { inner.received.push(id); inner.received.truncate(200); }
    respond(&mut stream, "200 OK", "application/json", b"{\"ok\":true}")
}

/// Página que o celular abre: escolher arquivos e enviar um por vez, com progresso.
const PAGE: &str = r#"<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Heydesk</title>
<style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;gap:16px;padding:28px 20px;box-sizing:border-box;background:#000;color:#e5e5e5;font:16px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
h1{margin:0;font-size:20px;font-weight:650}h2{align-self:stretch;max-width:360px;margin:12px auto 0;width:100%;font-size:13px;font-weight:600;color:#8a8a8a;text-transform:uppercase;letter-spacing:.04em}
label{display:flex;align-items:center;justify-content:center;width:min(360px,100%);height:52px;border-radius:14px;background:#e5e5e5;color:#171717;font-weight:650;cursor:pointer}
input{display:none}ul{list-style:none;margin:0;padding:0;width:min(360px,100%);display:flex;flex-direction:column;gap:8px}
li{padding:10px 12px;border-radius:12px;background:#121212;box-shadow:inset 0 0 0 1px #2c2c2e;font-size:14px}
li a{display:flex;justify-content:space-between;gap:8px;color:inherit;text-decoration:none}li a span{color:#8a8a8a;flex:none}
.n{display:flex;justify-content:space-between;gap:8px}.n b,li a b{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.n span{color:#8a8a8a;flex:none}
.bar{height:4px;margin-top:8px;border-radius:4px;background:#2c2c2e;overflow:hidden}.bar i{display:block;height:100%;width:0;background:#e5e5e5;transition:width .15s}
.ok .bar i{background:#34c759}.err .bar i{background:#ff453a}.empty{color:#8a8a8a;background:none;box-shadow:none;text-align:center}</style></head>
<body><h1>Heydesk</h1>
<h2>Enviar para o PC</h2><label>Escolher arquivos<input id="f" type="file" multiple></label><ul id="l"></ul>
<h2>Baixar do PC</h2><ul id="d"><li class="empty">Carregando…</li></ul>
<script>
const base=location.pathname,list=document.getElementById('l'),down=document.getElementById('d'),size=n=>n<1024?n+' B':n<1048576?Math.round(n/1024)+' KB':(n/1048576).toFixed(1)+' MB';
let queue=Promise.resolve(),seen='';
function refresh(){fetch(base+'/list',{cache:'no-store'}).then(r=>r.json()).then(items=>{const key=items.map(i=>i.id).join();if(key===seen)return;seen=key;down.innerHTML='';
if(!items.length){down.innerHTML='<li class="empty">Nada na prateleira do PC.</li>';return}
for(const i of items){const li=document.createElement('li'),a=document.createElement('a');a.href=base+'/f/'+i.id;a.download=i.name;a.innerHTML='<b></b><span></span>';a.querySelector('b').textContent=i.name;a.querySelector('span').textContent=size(i.size)+' ↓';li.append(a);down.append(li)}}).catch(()=>{})}
refresh();setInterval(refresh,3000);
document.getElementById('f').addEventListener('change',e=>{for(const file of e.target.files){const li=document.createElement('li');li.innerHTML='<div class="n"><b></b><span></span></div><div class="bar"><i></i></div>';li.querySelector('b').textContent=file.name;li.querySelector('span').textContent=size(file.size);list.prepend(li);
queue=queue.then(()=>new Promise(done=>{const x=new XMLHttpRequest();x.open('POST',base+'/up');x.setRequestHeader('X-Name',encodeURIComponent(file.name));
x.upload.onprogress=p=>{if(p.lengthComputable)li.querySelector('i').style.width=(p.loaded/p.total*100)+'%'};
x.onload=()=>{li.className=x.status==200?'ok':'err';li.querySelector('i').style.width='100%';li.querySelector('span').textContent=x.status==200?'Enviado':'Falhou';done();refresh()};
x.onerror=()=>{li.className='err';li.querySelector('span').textContent='Falhou';done()};x.send(file)}))}e.target.value=''});
</script></body></html>"#;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names_are_made_safe() {
        assert_eq!(safe_name("..\\..\\Windows\\evil.exe"), "evil.exe");
        assert_eq!(safe_name("foto: 1?.jpg"), "foto_ 1_.jpg");
        assert_eq!(safe_name("   "), "arquivo");
        assert_eq!(safe_name("CON.txt"), "arquivo_CON.txt");
        assert_eq!(safe_name(&"a".repeat(300)).len(), 120);
    }
    #[test]
    fn percent_decoding_handles_utf8_and_bad_escapes() {
        assert_eq!(percent_decode("Relat%C3%B3rio%20final.pdf"), "Relatório final.pdf");
        assert_eq!(percent_decode("100%.txt"), "100%.txt");
    }
    #[test]
    fn download_name_keeps_utf8() {
        assert_eq!(disposition("Relatório final.pdf"), "attachment; filename=\"Relat_rio final.pdf\"; filename*=UTF-8''Relat%C3%B3rio%20final.pdf");
    }
    #[test]
    fn store_copies_exact_length() {
        let dir = std::env::temp_dir().join(format!("heydesk-shelf-{}", random_hex(4).unwrap()));
        let item = store(&dir, "a/b.txt", &mut &b"hello world"[..], 5).unwrap();
        assert_eq!((item.name.as_str(), item.size), ("b.txt", 5));
        assert_eq!(std::fs::read(dir.join("files").join(&item.id).join("b.txt")).unwrap(), b"hello");
        assert!(store(&dir, "x", &mut &b"abc"[..], 10).is_err(), "corpo curto falha e não deixa sobra");
        assert_eq!(std::fs::read_dir(dir.join("files")).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn qr_encodes_url() {
        let (size, modules) = qr("http://192.168.0.10:51234/0123456789abcdef0123456789abcdef").unwrap();
        assert_eq!(modules.len(), size * size);
        assert!(size >= 21);
    }
}

/// Marca de origem do Windows (Mark-of-the-Web, fluxo `Zone.Identifier`). Com `original`,
/// copia a marca do arquivo de origem se ele tiver; sem, marca como vindo da rede (zona 3).
fn mark_from_internet(path: &Path, original: Option<&Path>) {
    #[cfg(windows)]
    {
        let stream = |file: &Path| { let mut name = file.as_os_str().to_owned(); name.push(":Zone.Identifier"); PathBuf::from(name) };
        let content = match original {
            Some(source) => match std::fs::read(stream(source)) { Ok(bytes) => bytes, Err(_) => return },
            None => b"[ZoneTransfer]\r\nZoneId=3\r\n".to_vec(),
        };
        let _ = std::fs::write(stream(path), content);
    }
    #[cfg(not(windows))]
    { let _ = (path, original); }
}
