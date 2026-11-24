//! Upstream `dx150-edge-v1` encrypted edge gateway client (ECDH P-256 + HKDF-SHA256 + AES-256-GCM).

use base64::engine::general_purpose::{STANDARD as B64_STD, URL_SAFE_NO_PAD as B64_URL};
use base64::Engine;
use once_cell::sync::Lazy;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::agreement::{self, EphemeralPrivateKey, UnparsedPublicKey, ECDH_P256};
use ring::hkdf::{self, HKDF_SHA256};
use ring::rand::SystemRandom;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex as AsyncMutex;

const PROTOCOL: &str = "dx150-edge-v1";
const MAX_SEQUENCE: u32 = 16_384;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EdgeScope {
    Public,
    Dynamic,
    Playback,
    User,
}

impl EdgeScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Dynamic => "dynamic",
            Self::Playback => "playback",
            Self::User => "user",
        }
    }

    pub fn endpoint_path(self) -> &'static str {
        match self {
            Self::Public => "/api/public/request",
            Self::Dynamic => "/api/dynamic/request",
            Self::Playback => "/api/playback/request",
            Self::User => "/api/user/request",
        }
    }
}

fn is_digits(segment: &str) -> bool {
    !segment.is_empty() && segment.bytes().all(|b| b.is_ascii_digit())
}

fn has_random_sort(query: &str) -> bool {
    url::form_urlencoded::parse(query.as_bytes()).any(|(k, v)| {
        k == "sort" && matches!(v.trim().to_ascii_lowercase().as_str(), "random" | "rand")
    })
}

/// Map `(method, path?query)` to upstream's `dx150-edge-v1` scope.
pub fn scope_for(method: &str, path_with_query: &str) -> EdgeScope {
    let m = if method.eq_ignore_ascii_case("HEAD") {
        "GET"
    } else {
        method
    };
    let (pathname, query) = match path_with_query.split_once('?') {
        Some((p, q)) => (p, q),
        None => (path_with_query, ""),
    };
    let segs: Vec<&str> = pathname.split('/').filter(|s| !s.is_empty()).collect();

    // Playback scope
    let is_playback = match segs.as_slice() {
        ["api", "videos", id, "episodes", ep, "playback"]
            if m.eq_ignore_ascii_case("POST") && is_digits(id) && is_digits(ep) =>
        {
            true
        }
        ["api", "videos", id, "playback"] if m.eq_ignore_ascii_case("POST") && is_digits(id) => {
            true
        }
        ["api", "videos", id, "play"] if m.eq_ignore_ascii_case("GET") && is_digits(id) => true,
        ["api", "posts", id, "playback"] if m.eq_ignore_ascii_case("POST") && is_digits(id) => true,
        ["api", "media", "playback", "previews"] if m.eq_ignore_ascii_case("POST") => true,
        ["api", "media", "prerolls", id, "playback"]
            if m.eq_ignore_ascii_case("POST") && is_digits(id) =>
        {
            true
        }
        _ => false,
    };
    if is_playback {
        return EdgeScope::Playback;
    }

    // User scope
    let is_user = match segs.as_slice() {
        ["api", "account", ..] => true,
        ["api", "users", "me", ..] => true,
        ["api", "videos", "following"] if m.eq_ignore_ascii_case("GET") => true,
        ["api", "ai-wish"] if m.eq_ignore_ascii_case("POST") => true,
        ["api", "users", id, "follow"] if is_digits(id) => true,
        ["api", "videos", id, "like" | "collect" | "feedback" | "rating" | "report" | "interaction-state"]
            if is_digits(id) =>
        {
            true
        }
        ["api", "videos", id, "comments"] if m.eq_ignore_ascii_case("POST") && is_digits(id) => {
            true
        }
        ["api", "videos", id, "comments", "liked" | "state"] if is_digits(id) => true,
        ["api", "videos", id, "comments", cid, "like" | "guest-like"]
            if is_digits(id) && is_digits(cid) =>
        {
            true
        }
        ["api", "videos", id, "guest-comments" | "guest-like" | "guest-liked"]
            if is_digits(id) =>
        {
            true
        }
        ["api", "posts", id, "like" | "collect" | "visit" | "guest-comments" | "guest-like" | "guest-liked"]
            if is_digits(id) =>
        {
            true
        }
        ["api", "posts", id, "comments"] if m.eq_ignore_ascii_case("POST") && is_digits(id) => true,
        ["api", "posts", id, "comments", "liked"] if is_digits(id) => true,
        ["api", "posts", id, "comments", cid, "like" | "guest-like"]
            if is_digits(id) && is_digits(cid) =>
        {
            true
        }
        _ => false,
    };
    if is_user {
        return EdgeScope::User;
    }

    // Public scope (GET/HEAD only; sort=random|rand promoted to Dynamic)
    if m.eq_ignore_ascii_case("GET") {
        let is_public = match segs.as_slice() {
            ["api", "users"] => true,
            ["api", "videos"]
            | ["api", "videos", "long" | "report-reasons"]
            | ["api", "topics"]
            | ["api", "tags"]
            | ["api", "posts"]
            | ["api", "feed", "post", "today"]
            | ["api", "feed", "recommend" | "today"]
            | ["api", "home", "latest" | "recommends"]
            | ["api", "search", "hot" | "suggest"]
            | ["api", "search", "tags", "hot"]
            | ["api", "site", "categories", "post" | "video"]
            | ["api", "site", "sorts", "video"]
            | ["api", "site", "config" | "links" | "menus" | "meta" | "pages" | "transit" | "watermark"] => {
                true
            }
            ["api", "videos", "category" | "tag" | "sort", _]
            | ["api", "posts", "category" | "tag", _]
            | ["api", "ranks", _]
            | ["api", "topics", _]
            | ["api", "site", "pages", _] => true,
            ["api", "videos", "user", id]
            | ["api", "videos", id, "related"]
            | ["api", "posts", "user", id]
            | ["api", "posts", id, "adjacent" | "related"]
            | ["api", "users", id, "stats"]
                if is_digits(id) =>
            {
                true
            }
            _ => false,
        };
        if is_public {
            return if has_random_sort(query) {
                EdgeScope::Dynamic
            } else {
                EdgeScope::Public
            };
        }
    }

    EdgeScope::Dynamic
}

/// Stable-sort query parameters by key name, matching `URLSearchParams.sort()` in `edge-cache-runtime.js`.
pub fn sort_public_path(path_with_query: &str) -> String {
    let Some((pathname, query)) = path_with_query.split_once('?') else {
        return path_with_query.to_owned();
    };
    if query.is_empty() {
        return pathname.to_owned();
    }
    let mut pairs: Vec<(String, String)> = url::form_urlencoded::parse(query.as_bytes())
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    pairs.sort_by(|a, b| a.0.cmp(&b.0));
    let mut ser = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in pairs {
        ser.append_pair(&k, &v);
    }
    let sorted = ser.finish();
    if sorted.is_empty() {
        pathname.to_owned()
    } else {
        format!("{pathname}?{sorted}")
    }
}

struct KeyLen(usize);
impl hkdf::KeyType for KeyLen {
    fn len(&self) -> usize {
        self.0
    }
}

fn derive_aes_key(prk: &hkdf::Prk, info: &str) -> Result<LessSafeKey, String> {
    let slices = [info.as_bytes()];
    let okm = prk
        .expand(&slices, KeyLen(32))
        .map_err(|_| "派生加密会话密钥失败")?;
    let mut raw = [0u8; 32];
    okm.fill(&mut raw).map_err(|_| "读取加密会话密钥失败")?;
    let unbound = UnboundKey::new(&AES_256_GCM, &raw).map_err(|_| "初始化加密密钥失败")?;
    Ok(LessSafeKey::new(unbound))
}

fn nonce_for(seq: u32) -> Nonce {
    let mut iv = [0u8; 12];
    iv[8..12].copy_from_slice(&seq.to_be_bytes());
    Nonce::assume_unique_for_key(iv)
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn valid_id(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn valid_site(value: &str) -> bool {
    (1..=256).contains(&value.len())
        && value.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'.' | b':' | b'[' | b']' | b'-')
        })
}

#[derive(Deserialize)]
struct HelloResponse {
    v: u32,
    #[serde(rename = "type")]
    kind: String,
    kid: String,
    sid: String,
    site: String,
    server_pub: String,
    salt: String,
    server_time: i64,
    expires_at: i64,
}

#[derive(Deserialize)]
struct CallResultEnvelope {
    v: u32,
    #[serde(rename = "type")]
    kind: String,
    kid: String,
    sid: String,
    seq: u32,
    ts: i64,
    ciphertext: String,
}

#[derive(Deserialize)]
struct InnerResponse {
    status: u16,
    headers: HashMap<String, Vec<String>>,
    #[serde(default)]
    body: String,
}

pub struct EdgeSession {
    info: String,
    pub kid: String,
    pub sid: String,
    clock_offset: i64,
    expires_at: i64,
    sequence: AtomicU32,
    req_key: LessSafeKey,
    res_key: LessSafeKey,
}

pub struct PendingHandshake {
    priv_key: EphemeralPrivateKey,
    pub hello_payload: Value,
}

impl PendingHandshake {
    pub fn begin() -> Result<Self, String> {
        let rng = SystemRandom::new();
        let priv_key =
            EphemeralPrivateKey::generate(&ECDH_P256, &rng).map_err(|_| "生成加密握手密钥失败")?;
        let pub_key = priv_key
            .compute_public_key()
            .map_err(|_| "导出握手公钥失败")?;
        let hello_payload = json!({
            "v": 1,
            "type": "hello",
            "client_pub": B64_URL.encode(pub_key.as_ref()),
        });
        Ok(Self {
            priv_key,
            hello_payload,
        })
    }

    pub fn finish(self, scope: EdgeScope, response_text: &str) -> Result<EdgeSession, String> {
        let hello: HelloResponse =
            serde_json::from_str(response_text).map_err(|_| "加密握手响应格式无效")?;
        if hello.v != 1
            || hello.kind != "hello"
            || !valid_id(&hello.kid, 1, 64)
            || !valid_id(&hello.sid, 16, 128)
            || !valid_site(&hello.site)
            || hello.expires_at <= hello.server_time
            || hello.expires_at - hello.server_time > 600
        {
            return Err("加密握手响应参数无效".into());
        }
        let server_pub = B64_URL
            .decode(&hello.server_pub)
            .map_err(|_| "加密握手公钥编码无效")?;
        let salt = B64_URL
            .decode(&hello.salt)
            .map_err(|_| "加密握手盐值编码无效")?;
        if salt.len() != 32 {
            return Err("加密握手盐值长度无效".into());
        }
        let info = format!(
            "{PROTOCOL}\n{}\n{}\n{}\n{}",
            scope.as_str(),
            hello.site,
            hello.kid,
            hello.sid
        );
        let peer = UnparsedPublicKey::new(&ECDH_P256, &server_pub);
        let (req_key, res_key) = agreement::agree_ephemeral(self.priv_key, &peer, |shared| {
            let prk = hkdf::Salt::new(HKDF_SHA256, &salt).extract(shared);
            let req = derive_aes_key(&prk, &format!("{info}\nreq"))?;
            let res = derive_aes_key(&prk, &format!("{info}\nres"))?;
            Ok::<(LessSafeKey, LessSafeKey), String>((req, res))
        })
        .map_err(|_| "加密握手密钥协商失败")??;

        let local_time = unix_now();
        Ok(EdgeSession {
            info,
            kid: hello.kid,
            sid: hello.sid,
            clock_offset: hello.server_time - local_time,
            expires_at: local_time + (hello.expires_at - hello.server_time),
            sequence: AtomicU32::new(0),
            req_key,
            res_key,
        })
    }
}

pub struct EncryptedCall {
    pub seq: u32,
    pub ts: i64,
    pub payload: Value,
}

pub struct DecryptedResponse {
    pub status: u16,
    pub content_type: String,
    pub body: String,
}

impl EdgeSession {
    pub fn is_fresh(&self) -> bool {
        self.expires_at > unix_now() + 5 && self.sequence.load(Ordering::Relaxed) < MAX_SEQUENCE
    }

    pub fn encrypt_call(
        &self,
        scope: EdgeScope,
        envelope: &Value,
        token: Option<&str>,
    ) -> Result<EncryptedCall, String> {
        let prev = self.sequence.fetch_add(1, Ordering::Relaxed);
        let seq = prev.saturating_add(1);
        if seq > MAX_SEQUENCE {
            return Err("session_expired".into());
        }
        let ts = unix_now() + self.clock_offset;
        let mut packet = json!({ "request": envelope });
        if scope != EdgeScope::Public {
            if let Some(t) = token.filter(|t| !t.is_empty()) {
                packet["authorization"] = json!(format!("Bearer {t}"));
            }
        }
        let mut buf = serde_json::to_vec(&packet).map_err(|e| e.to_string())?;
        let aad = Aad::from(format!("{}\nreq\n{seq}\n{ts}", self.info));
        self.req_key
            .seal_in_place_append_tag(nonce_for(seq), aad, &mut buf)
            .map_err(|_| "加密接口请求失败")?;
        let payload = json!({
            "v": 1,
            "type": "call",
            "kid": self.kid,
            "sid": self.sid,
            "seq": seq,
            "ts": ts,
            "ciphertext": B64_URL.encode(&buf),
        });
        Ok(EncryptedCall { seq, ts, payload })
    }

    pub fn decrypt_result(
        &self,
        method: &str,
        seq: u32,
        ts: i64,
        response_text: &str,
    ) -> Result<DecryptedResponse, String> {
        let env: CallResultEnvelope =
            serde_json::from_str(response_text).map_err(|_| "加密接口响应格式无效")?;
        if env.v != 1
            || env.kind != "result"
            || env.sid != self.sid
            || env.kid != self.kid
            || env.seq != seq
            || env.ts != ts
        {
            return Err("加密接口响应不匹配".into());
        }
        let mut buf = B64_URL
            .decode(&env.ciphertext)
            .map_err(|_| "加密响应编码无效")?;
        let aad = Aad::from(format!("{}\nres\n{seq}\n{ts}", self.info));
        let plain = self
            .res_key
            .open_in_place(nonce_for(seq), aad, &mut buf)
            .map_err(|_| "加密响应解密失败")?;
        let inner: InnerResponse =
            serde_json::from_slice(plain).map_err(|_| "加密接口内层响应无效")?;
        if !(200..=599).contains(&inner.status) {
            return Err("加密接口内层状态码无效".into());
        }
        let content_type = inner
            .headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
            .and_then(|(_, values)| values.first())
            .cloned()
            .unwrap_or_default();
        let no_body = method.eq_ignore_ascii_case("HEAD")
            || matches!(inner.status, 204 | 205 | 304)
            || inner.body.is_empty();
        let body = if no_body {
            String::new()
        } else {
            let raw = B64_STD
                .decode(&inner.body)
                .map_err(|_| "加密响应体解码失败")?;
            String::from_utf8(raw).map_err(|_| "加密响应体不是有效 UTF-8")?
        };
        Ok(DecryptedResponse {
            status: inner.status,
            content_type,
            body,
        })
    }
}

type SessionSlot = Arc<AsyncMutex<Option<Arc<EdgeSession>>>>;

static SESSION_SLOTS: Lazy<StdMutex<HashMap<(String, EdgeScope), SessionSlot>>> =
    Lazy::new(|| StdMutex::new(HashMap::new()));

pub fn session_slot(origin: &str, scope: EdgeScope) -> SessionSlot {
    let mut map = SESSION_SLOTS
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    map.entry((origin.to_owned(), scope))
        .or_insert_with(|| Arc::new(AsyncMutex::new(None)))
        .clone()
}

pub async fn invalidate_session(origin: &str, scope: EdgeScope, sid: &str) {
    let slot = session_slot(origin, scope);
    let mut guard = slot.lock().await;
    if guard.as_ref().is_some_and(|s| s.sid == sid) {
        *guard = None;
    }
}

pub fn is_session_expired_error(body: &str) -> bool {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_owned))
        .is_some_and(|err| err == "session_expired")
}

pub fn should_fallback_public_json_to_crypto(status: u16, public_json_header: bool, body: &str) -> bool {
    if status != 400 || public_json_header {
        return false;
    }
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_owned))
        .is_some_and(|err| matches!(err.as_str(), "invalid_request" | "unsupported_version"))
}

pub struct HttpReply {
    pub status: u16,
    pub ctype: String,
    pub gateway: &'static str,
    pub public_json: bool,
    pub target_host: String,
    pub headers_ms: u64,
    pub text: String,
}

/// Run one `dx150-edge-v1` call with single-flight session caching and 1-time `session_expired` retry.
/// Returns `Err(LegacyFallback)` when outer `/api/{scope}/request` returns 404/405 (unmigrated mirror).
pub enum CryptoCallError {
    LegacyFallback,
    Outer(HttpReply),
    Transport(String),
}

async fn get_or_open_session<F, Fut>(
    origin: &str,
    scope: EdgeScope,
    post: &mut F,
) -> Result<Arc<EdgeSession>, CryptoCallError>
where
    F: FnMut(Value) -> Fut,
    Fut: std::future::Future<Output = Result<HttpReply, String>>,
{
    let slot = session_slot(origin, scope);
    let mut guard = slot.lock().await;
    if let Some(existing) = guard.as_ref() {
        if existing.is_fresh() {
            return Ok(existing.clone());
        }
    }
    let handshake = PendingHandshake::begin().map_err(CryptoCallError::Transport)?;
    let reply = post(handshake.hello_payload.clone())
        .await
        .map_err(CryptoCallError::Transport)?;
    if matches!(reply.status, 404 | 405) {
        return Err(CryptoCallError::LegacyFallback);
    }
    if !(200..300).contains(&reply.status) {
        return Err(CryptoCallError::Outer(reply));
    }
    let session = Arc::new(
        handshake
            .finish(scope, &reply.text)
            .map_err(CryptoCallError::Transport)?,
    );
    *guard = Some(session.clone());
    Ok(session)
}

pub async fn call_encrypted<F, Fut>(
    origin: &str,
    scope: EdgeScope,
    method: &str,
    envelope: &Value,
    token: Option<&str>,
    mut post: F,
) -> Result<HttpReply, CryptoCallError>
where
    F: FnMut(Value) -> Fut,
    Fut: std::future::Future<Output = Result<HttpReply, String>>,
{
    for retry in 0..2 {
        let session = get_or_open_session(origin, scope, &mut post).await?;
        let call = match session.encrypt_call(scope, envelope, token) {
            Ok(c) => c,
            Err(err) if err == "session_expired" && retry == 0 => {
                invalidate_session(origin, scope, &session.sid).await;
                continue;
            }
            Err(err) => return Err(CryptoCallError::Transport(err)),
        };
        let reply = post(call.payload)
            .await
            .map_err(CryptoCallError::Transport)?;
        if matches!(reply.status, 404 | 405) {
            return Err(CryptoCallError::LegacyFallback);
        }
        if !(200..300).contains(&reply.status) {
            if is_session_expired_error(&reply.text) {
                invalidate_session(origin, scope, &session.sid).await;
                if retry == 0 {
                    continue;
                }
            }
            return Err(CryptoCallError::Outer(reply));
        }
        let dec = session
            .decrypt_result(method, call.seq, call.ts, &reply.text)
            .map_err(CryptoCallError::Transport)?;
        return Ok(HttpReply {
            status: dec.status,
            ctype: dec.content_type,
            gateway: reply.gateway,
            public_json: false,
            target_host: reply.target_host,
            headers_ms: reply.headers_ms,
            text: dec.body,
        });
    }
    Err(CryptoCallError::Transport("加密会话重建失败".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_map_to_expected_upstream_scopes() {
        assert_eq!(scope_for("GET", "/api/videos?page=1&size=20"), EdgeScope::Public);
        assert_eq!(scope_for("GET", "/api/videos?sort=random&page=1"), EdgeScope::Dynamic);
        assert_eq!(scope_for("GET", "/api/videos/category/ai-duanju?sort=rand"), EdgeScope::Dynamic);
        assert_eq!(scope_for("GET", "/api/videos/category/ai-duanju?sort=hot"), EdgeScope::Public);
        assert_eq!(scope_for("GET", "/api/tags"), EdgeScope::Public);
        assert_eq!(scope_for("GET", "/api/topics/weekly?page=1"), EdgeScope::Public);
        assert_eq!(scope_for("GET", "/api/ranks/hot"), EdgeScope::Public);
        assert_eq!(scope_for("GET", "/api/videos/12345"), EdgeScope::Dynamic);
        assert_eq!(scope_for("GET", "/api/videos/12345/comments?ep=1"), EdgeScope::Dynamic);
        assert_eq!(scope_for("GET", "/api/search?q=test&page=1"), EdgeScope::Dynamic);
        assert_eq!(scope_for("GET", "/api/posts/99"), EdgeScope::Dynamic);
        assert_eq!(scope_for("POST", "/api/videos/123/episodes/1/playback"), EdgeScope::Playback);
        assert_eq!(scope_for("GET", "/api/videos/123/play?ep=1"), EdgeScope::Playback);
        assert_eq!(scope_for("POST", "/api/posts/99/playback"), EdgeScope::Playback);
        assert_eq!(scope_for("POST", "/api/account/loginByPassword"), EdgeScope::User);
        assert_eq!(scope_for("GET", "/api/account/me"), EdgeScope::User);
        assert_eq!(scope_for("GET", "/api/users/me/history?page=1"), EdgeScope::User);
        assert_eq!(scope_for("GET", "/api/videos/following?page=1"), EdgeScope::User);
        assert_eq!(scope_for("POST", "/api/videos/123/like?ep=1"), EdgeScope::User);
        assert_eq!(scope_for("DELETE", "/api/videos/123/collect"), EdgeScope::User);
        assert_eq!(scope_for("POST", "/api/videos/123/comments"), EdgeScope::User);
        assert_eq!(scope_for("POST", "/api/users/42/follow"), EdgeScope::User);
        assert_eq!(scope_for("GET", "/api/users/42/stats"), EdgeScope::Public);
        assert_eq!(scope_for("GET", "/api/users?page=1&size=100&sort=followers"), EdgeScope::Public);
        assert_eq!(scope_for("GET", "/api/users/42"), EdgeScope::Dynamic);
    }

    #[test]
    fn public_query_params_sort_stably_by_key() {
        assert_eq!(
            sort_public_path("/api/videos?size=20&page=1&sort=hot"),
            "/api/videos?page=1&size=20&sort=hot"
        );
        assert_eq!(sort_public_path("/api/tags"), "/api/tags");
    }

    #[test]
    fn ecdh_hkdf_aes_gcm_roundtrip_matches_dx150_edge_v1() {
        let rng = SystemRandom::new();
        let handshake = PendingHandshake::begin().unwrap();
        let client_pub_b64 = handshake.hello_payload["client_pub"].as_str().unwrap();
        let client_pub = B64_URL.decode(client_pub_b64).unwrap();
        assert_eq!(client_pub.len(), 65);

        // Simulate upstream server ECDH + HKDF
        let server_priv = EphemeralPrivateKey::generate(&ECDH_P256, &rng).unwrap();
        let server_pub = server_priv.compute_public_key().unwrap();
        let salt = [7u8; 32];
        let now = unix_now();
        let kid = "k1";
        let sid = "session_1234567890abcdef";
        let site = "huangguoai.com";
        let scope = EdgeScope::Dynamic;
        let info = format!("{PROTOCOL}\n{}\n{site}\n{kid}\n{sid}", scope.as_str());

        let (srv_req_key, srv_res_key) = agreement::agree_ephemeral(
            server_priv,
            &UnparsedPublicKey::new(&ECDH_P256, &client_pub),
            |shared| {
                let prk = hkdf::Salt::new(HKDF_SHA256, &salt).extract(shared);
                let req = derive_aes_key(&prk, &format!("{info}\nreq")).unwrap();
                let res = derive_aes_key(&prk, &format!("{info}\nres")).unwrap();
                (req, res)
            },
        )
        .unwrap();

        let hello_json = json!({
            "v": 1, "type": "hello", "kid": kid, "sid": sid, "site": site,
            "server_pub": B64_URL.encode(server_pub.as_ref()),
            "salt": B64_URL.encode(salt),
            "server_time": now,
            "expires_at": now + 300,
        })
        .to_string();
        let session = handshake.finish(scope, &hello_json).unwrap();
        assert!(session.is_fresh());

        let envelope = json!({"method": "GET", "path": "/api/videos/42", "body": "", "content_type": ""});
        let call = session.encrypt_call(scope, &envelope, Some("tok123")).unwrap();
        assert_eq!(call.seq, 1);

        // Server decrypts request
        let mut req_ct = B64_URL
            .decode(call.payload["ciphertext"].as_str().unwrap())
            .unwrap();
        let req_aad = Aad::from(format!("{info}\nreq\n{}\n{}", call.seq, call.ts));
        let req_plain = srv_req_key
            .open_in_place(nonce_for(call.seq), req_aad, &mut req_ct)
            .unwrap();
        let req_obj: Value = serde_json::from_slice(req_plain).unwrap();
        assert_eq!(req_obj["authorization"], "Bearer tok123");
        assert_eq!(req_obj["request"]["path"], "/api/videos/42");

        // Server encrypts response
        let inner = json!({
            "status": 200,
            "headers": { "Content-Type": ["application/json"] },
            "body": B64_STD.encode(br#"{"status":1,"data":{"id":42}}"#),
        });
        let mut res_buf = serde_json::to_vec(&inner).unwrap();
        let res_aad = Aad::from(format!("{info}\nres\n{}\n{}", call.seq, call.ts));
        srv_res_key
            .seal_in_place_append_tag(nonce_for(call.seq), res_aad, &mut res_buf)
            .unwrap();
        let result_json = json!({
            "v": 1, "type": "result", "kid": kid, "sid": sid,
            "seq": call.seq, "ts": call.ts,
            "ciphertext": B64_URL.encode(&res_buf),
        })
        .to_string();

        let decrypted = session
            .decrypt_result("GET", call.seq, call.ts, &result_json)
            .unwrap();
        assert_eq!(decrypted.status, 200);
        assert_eq!(decrypted.content_type, "application/json");
        assert_eq!(decrypted.body, r#"{"status":1,"data":{"id":42}}"#);
    }

    #[tokio::test]
    #[ignore = "联网测试：验证真实官网 dx150-edge-v1 四作用域通道，手动用 --ignored 运行"]
    async fn live_dx150_edge_all_four_scopes() {
        let origin = "https://huangguoai.com";
        let feed = crate::net::edge(origin, "GET", "/api/videos?page=1&size=2", None, None)
            .await
            .expect("public feed");
        let items = feed["items"].as_array().expect("feed items");
        assert!(!items.is_empty(), "feed should return videos");
        let vid = items[0]["id"].as_i64().expect("video id");
        eprintln!("LIVE public OK: feed items={}, first vid={vid}", items.len());

        let detail = crate::net::edge(origin, "GET", &format!("/api/videos/{vid}"), None, None)
            .await
            .expect("dynamic video detail");
        assert_eq!(detail["id"].as_i64(), Some(vid));
        eprintln!("LIVE dynamic(detail) OK: vid={vid}");

        let search = crate::net::edge(origin, "GET", "/api/search?q=%E9%83%BD%E5%B8%82&page=1&size=2", None, None)
            .await
            .expect("dynamic search");
        assert!(search["items"].is_array());
        eprintln!("LIVE dynamic(search) OK: items={}", search["items"].as_array().unwrap().len());

        let play = crate::net::edge(
            origin,
            "POST",
            &format!("/api/videos/{vid}/episodes/1/playback"),
            Some(json!({})),
            None,
        )
        .await
        .expect("playback endpoint");
        assert!(play.is_object(), "playback object");
        eprintln!("LIVE playback OK: has_streams={}", play.get("streams").is_some() || play.get("video_url").is_some());

        let me = crate::net::edge(origin, "GET", "/api/account/me", None, None).await;
        assert_eq!(me.unwrap_err(), "401", "user scope should decrypt real 401 instead of 503");
        eprintln!("LIVE user scope OK: decrypted 401 cleanly");
    }
}
