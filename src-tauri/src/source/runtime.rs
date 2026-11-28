//! QuickJS sandbox runtime with capability-scoped Rust host primitives
//! (`host.fetch`, `host.htmlQuery`, `host.crypto`, `host.storage`, `host.info`).

use super::manifest::SourcePackage;
use super::store::SourceStore;
use base64::engine::general_purpose::{STANDARD as B64_STD, URL_SAFE_NO_PAD as B64_URL};
use base64::Engine;
use dom_query::Document;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::agreement::{self, EphemeralPrivateKey, UnparsedPublicKey, ECDH_P256};
use ring::hkdf::{self, HKDF_SHA256};
use ring::hmac;
use ring::rand::{SecureRandom, SystemRandom};
use rquickjs::{CatchResultExt, Context, Function, Object, Runtime};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

const MAX_MEMORY_BYTES: usize = 16 * 1024 * 1024;
const MAX_STACK_BYTES: usize = 512 * 1024;
const DEFAULT_TIMEOUT_SECS: u64 = 12;
const MAX_REQUEST_BODY_BYTES: usize = 256 * 1024;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_HTML_BYTES: usize = 2 * 1024 * 1024;
const MAX_HTML_RESULTS: usize = 200;
const MAX_REDIRECTS: usize = 5;
const MAX_EPHEMERAL_KEYS: usize = 16;

struct KeyLen(usize);
impl hkdf::KeyType for KeyLen {
    fn len(&self) -> usize {
        self.0
    }
}

fn origin_string(u: &url::Url) -> String {
    u.origin().ascii_serialization()
}

fn origin_allowed(target: &url::Url, allowed: &[String]) -> bool {
    let target_origin = origin_string(target);
    allowed.iter().any(|entry| {
        url::Url::parse(entry)
            .ok()
            .is_some_and(|u| origin_string(&u).eq_ignore_ascii_case(&target_origin))
    })
}

fn is_forbidden_header(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "host" | "connection" | "keep-alive" | "transfer-encoding" | "upgrade" | "proxy-authorization" | "cookie"
    )
}

async fn send_host_attempt(
    method_upper: &str,
    target: &url::Url,
    headers: &HashMap<String, String>,
    body: Option<&str>,
    timeout: Duration,
    public_dns: bool,
) -> Result<reqwest::Response, (String, bool)> {
    let (pinned_url, client) = crate::net::client_for_dns(target.as_str(), public_dns)
        .await
        .map_err(|e| (e, true))?;
    let req_method = reqwest::Method::from_bytes(method_upper.as_bytes())
        .map_err(|_| ("无效的 HTTP 方法".to_string(), true))?;
    let mut req = client.request(req_method, pinned_url).timeout(timeout);
    for (k, v) in headers {
        if !is_forbidden_header(k) {
            req = req.header(k.as_str(), v.as_str());
        }
    }
    if let Some(b) = body {
        if matches!(method_upper, "POST" | "PUT" | "DELETE") {
            req = req.body(b.to_string());
        }
    }
    req.send().await.map_err(|e| {
        let pre_connect = e.is_connect();
        let msg = crate::net::err_text(&e);
        let safe_before_request = pre_connect
            || msg.contains("InvalidContentType")
            || msg.contains("corrupt message")
            || msg.contains("handshake")
            || msg.contains("DNS")
            || msg.contains("dns");
        (msg, safe_before_request)
    })
}

/// Strictly validated HTTP fetch shared by `host.fetch` and `source_import` / `source_check_update`.
pub(crate) async fn host_http_request(
    method: &str,
    raw_url: &str,
    headers: &HashMap<String, String>,
    body: Option<&str>,
    allowed_origins: Option<&[String]>,
    max_response_bytes: usize,
    timeout_secs: u64,
) -> Result<Value, String> {
    let method_upper = method.trim().to_ascii_uppercase();
    if !matches!(method_upper.as_str(), "GET" | "POST" | "HEAD" | "PUT" | "DELETE") {
        return Err(format!("不支持的 HTTP 方法：{method_upper}"));
    }
    if let Some(b) = body {
        if b.len() > MAX_REQUEST_BODY_BYTES {
            return Err("请求体超出上限（256 KB）".into());
        }
    }

    let mut current = crate::network_policy::parse_target(raw_url)?;
    if current.scheme() != "https" && crate::network_policy::strict_security() {
        return Err("严格模式下仅允许 https:// 请求".into());
    }
    if let Some(origins) = allowed_origins {
        if !origin_allowed(&current, origins) {
            return Err(format!(
                "目标域名未在视频源 manifest.network 白名单内：{}",
                origin_string(&current)
            ));
        }
    }

    let strict = crate::network_policy::strict_security();
    let is_idempotent = matches!(method_upper.as_str(), "GET" | "HEAD");
    let timeout = Duration::from_secs(timeout_secs.clamp(2, 20));
    for hop in 0..=MAX_REDIRECTS {
        let host = current
            .host_str()
            .ok_or_else(|| "URL 缺少主机名".to_string())?
            .to_string();
        if current.scheme() != "https" && strict {
            return Err("严格模式下仅允许 https:// 请求".into());
        }
        let proxy_active = crate::net::proxy_active(&current);
        let use_public_dns = !proxy_active && crate::net::prefers_public_dns(&host);
        let mut resp = match send_host_attempt(
            &method_upper,
            &current,
            headers,
            body,
            timeout,
            use_public_dns,
        )
        .await
        {
            Ok(r) => {
                if use_public_dns {
                    crate::net::mark_public_dns(&host, true);
                }
                r
            }
            Err((first_err, safe_pre_connect)) => {
                if use_public_dns {
                    crate::net::mark_public_dns(&host, false);
                }
                crate::net::heal_client(&first_err);
                let can_fallback = !proxy_active
                    && crate::media_dns::eligible(&current, &first_err)
                    && (is_idempotent || safe_pre_connect);
                if can_fallback {
                    let retry_public = !use_public_dns;
                    match send_host_attempt(
                        &method_upper,
                        &current,
                        headers,
                        body,
                        timeout,
                        retry_public,
                    )
                    .await
                    {
                        Ok(r) => {
                            if retry_public {
                                crate::net::mark_public_dns(&host, true);
                            }
                            r
                        }
                        Err((retry_err, _)) => {
                            if retry_public {
                                crate::net::mark_public_dns(&host, false);
                            }
                            if retry_public && retry_err.contains("备用 DNS") {
                                return Err(first_err);
                            }
                            return Err(retry_err);
                        }
                    }
                } else {
                    return Err(first_err);
                }
            }
        };
        let status = resp.status().as_u16();
        if matches!(status, 301 | 302 | 303 | 307 | 308) {
            if hop == MAX_REDIRECTS {
                return Err("重定向次数超出上限".into());
            }
            let loc = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| "重定向缺少 Location 头".to_string())?;
            let next = crate::network_policy::redirect_target(&current, loc)?;
            if let Some(origins) = allowed_origins {
                if !origin_allowed(&next, origins) {
                    return Err(format!(
                        "重定向目标不在 manifest.network 白名单内：{}",
                        origin_string(&next)
                    ));
                }
            }
            current = next;
            continue;
        }

        let mut resp_headers = serde_json::Map::new();
        for (k, v) in resp.headers() {
            let name = k.as_str().to_ascii_lowercase();
            if name == "set-cookie" {
                continue;
            }
            if let Ok(val) = v.to_str() {
                resp_headers.insert(name, json!(val));
            }
        }

        let mut bytes = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(|e| crate::net::err_text(&e))? {
            if bytes.len() + chunk.len() > max_response_bytes {
                return Err(format!("响应体超出上限（{} KB）", max_response_bytes / 1024));
            }
            bytes.extend_from_slice(&chunk);
        }
        let text = String::from_utf8_lossy(&bytes).into_owned();
        return Ok(json!({
            "ok": (200..300).contains(&status),
            "status": status,
            "url": current.as_str(),
            "headers": resp_headers,
            "text": text,
        }));
    }
    Err("重定向异常终止".into())
}

fn run_html_query(html: &str, selector: &str) -> Result<Value, String> {
    if html.len() > MAX_HTML_BYTES {
        return Err("HTML 文本超出解析上限（2 MB）".into());
    }
    if selector.trim().is_empty() || selector.len() > 256 {
        return Err("CSS 选择器无效".into());
    }
    let doc = Document::from(html);
    let mut items = Vec::new();
    for node in doc.select(selector).iter().take(MAX_HTML_RESULTS) {
        let mut attrs = serde_json::Map::new();
        if let Some(el) = node.nodes().first() {
            for attr in el.attrs() {
                attrs.insert(attr.name.local.to_string(), json!(attr.value.to_string()));
            }
        }
        items.push(json!({
            "text": node.text().to_string(),
            "html": node.inner_html().to_string(),
            "attrs": attrs,
        }));
    }
    Ok(Value::Array(items))
}

struct CryptoVault {
    next_id: u64,
    keys: HashMap<u64, EphemeralPrivateKey>,
}

impl CryptoVault {
    fn new() -> Self {
        Self {
            next_id: 1,
            keys: HashMap::new(),
        }
    }
}

fn run_crypto_op(vault: &RefCell<CryptoVault>, req: &Value) -> Result<Value, String> {
    let op = req
        .get("op")
        .and_then(Value::as_str)
        .ok_or_else(|| "crypto 缺少 op".to_string())?;
    let rng = SystemRandom::new();
    match op {
        "sha256Hex" => {
            let text = req.get("text").and_then(Value::as_str).unwrap_or("");
            let digest = ring::digest::digest(&ring::digest::SHA256, text.as_bytes());
            let mut hex = String::with_capacity(64);
            for b in digest.as_ref() {
                use std::fmt::Write;
                let _ = write!(&mut hex, "{b:02x}");
            }
            Ok(json!({ "hex": hex }))
        }
        "randomBytes" => {
            let len = req
                .get("len")
                .and_then(Value::as_u64)
                .unwrap_or(16)
                .clamp(1, 256) as usize;
            let mut buf = vec![0u8; len];
            rng.fill(&mut buf).map_err(|_| "生成随机字节失败")?;
            Ok(json!({
                "b64": B64_STD.encode(&buf),
                "b64url": B64_URL.encode(&buf),
            }))
        }
        "base64Encode" => {
            let text = req.get("text").and_then(Value::as_str).unwrap_or("");
            Ok(json!({
                "b64": B64_STD.encode(text.as_bytes()),
                "b64url": B64_URL.encode(text.as_bytes()),
            }))
        }
        "base64Decode" => {
            let raw = req.get("b64").and_then(Value::as_str).unwrap_or("");
            let bytes = B64_STD
                .decode(raw.as_bytes())
                .or_else(|_| B64_URL.decode(raw.as_bytes()))
                .map_err(|_| "Base64 解码失败")?;
            Ok(json!({ "text": String::from_utf8_lossy(&bytes) }))
        }
        "ecdhP256Create" => {
            let mut v = vault.borrow_mut();
            if v.keys.len() >= MAX_EPHEMERAL_KEYS {
                return Err("单次执行临时密钥数量超出上限".into());
            }
            let priv_key = EphemeralPrivateKey::generate(&ECDH_P256, &rng)
                .map_err(|_| "生成 ECDH P-256 密钥失败")?;
            let pub_key = priv_key
                .compute_public_key()
                .map_err(|_| "导出 ECDH 公钥失败")?;
            let handle = v.next_id;
            v.next_id += 1;
            v.keys.insert(handle, priv_key);
            Ok(json!({
                "handle": handle,
                "publicKeyB64Url": B64_URL.encode(pub_key.as_ref()),
                "publicKeyB64": B64_STD.encode(pub_key.as_ref()),
            }))
        }
        "ecdhP256Derive" => {
            let handle = req
                .get("handle")
                .and_then(Value::as_u64)
                .ok_or_else(|| "缺少 handle".to_string())?;
            let peer_raw = req
                .get("peerPubB64Url")
                .and_then(Value::as_str)
                .ok_or_else(|| "缺少 peerPubB64Url".to_string())?;
            let salt_raw = req
                .get("saltB64Url")
                .and_then(Value::as_str)
                .ok_or_else(|| "缺少 saltB64Url".to_string())?;
            let infos: Vec<String> = req
                .get("infos")
                .and_then(Value::as_array)
                .ok_or_else(|| "缺少 infos 数组".to_string())?
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect();
            if infos.is_empty() || infos.len() > 8 {
                return Err("infos 数量无效（1..=8）".into());
            }
            let priv_key = vault
                .borrow_mut()
                .keys
                .remove(&handle)
                .ok_or_else(|| "ECDH handle 无效或已消费".to_string())?;
            let peer_bytes = B64_URL
                .decode(peer_raw.as_bytes())
                .or_else(|_| B64_STD.decode(peer_raw.as_bytes()))
                .map_err(|_| "对端公钥编码无效")?;
            let salt_bytes = B64_URL
                .decode(salt_raw.as_bytes())
                .or_else(|_| B64_STD.decode(salt_raw.as_bytes()))
                .map_err(|_| "盐值编码无效")?;
            let peer = UnparsedPublicKey::new(&ECDH_P256, &peer_bytes);
            let derived = agreement::agree_ephemeral(priv_key, &peer, |shared| {
                let prk = hkdf::Salt::new(HKDF_SHA256, &salt_bytes).extract(shared);
                let mut out = Vec::with_capacity(infos.len());
                for info in &infos {
                    let slices = [info.as_bytes()];
                    let okm = prk
                        .expand(&slices, KeyLen(32))
                        .map_err(|_| "HKDF expand 失败")?;
                    let mut raw = [0u8; 32];
                    okm.fill(&mut raw).map_err(|_| "HKDF 读取密钥失败")?;
                    out.push(B64_STD.encode(raw));
                }
                Ok::<Vec<String>, String>(out)
            })
            .map_err(|_| "ECDH 协商失败")??;
            Ok(json!({ "keysB64": derived }))
        }
        "aes256GcmEncrypt" => {
            let key_bytes = B64_STD
                .decode(req.get("keyB64").and_then(Value::as_str).unwrap_or(""))
                .map_err(|_| "AES 密钥编码无效")?;
            let nonce_bytes = B64_STD
                .decode(req.get("nonceB64").and_then(Value::as_str).unwrap_or(""))
                .map_err(|_| "Nonce 编码无效")?;
            let nonce_arr: [u8; 12] = nonce_bytes
                .try_into()
                .map_err(|_| "AES-GCM Nonce 必须为 12 字节")?;
            let mut buf = if let Some(b64) = req.get("plaintextB64").and_then(Value::as_str) {
                B64_STD.decode(b64.as_bytes()).map_err(|_| "明文 Base64 无效")?
            } else {
                req.get("plaintextUtf8")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .as_bytes()
                    .to_vec()
            };
            let aad = req.get("aadUtf8").and_then(Value::as_str).unwrap_or("");
            let unbound = UnboundKey::new(&AES_256_GCM, &key_bytes).map_err(|_| "AES-256 密钥长度无效")?;
            let key = LessSafeKey::new(unbound);
            key.seal_in_place_append_tag(
                Nonce::assume_unique_for_key(nonce_arr),
                Aad::from(aad.as_bytes()),
                &mut buf,
            )
            .map_err(|_| "AES-256-GCM 加密失败")?;
            Ok(json!({
                "ciphertextB64": B64_STD.encode(&buf),
                "ciphertextB64Url": B64_URL.encode(&buf),
            }))
        }
        "aes256GcmDecrypt" => {
            let key_bytes = B64_STD
                .decode(req.get("keyB64").and_then(Value::as_str).unwrap_or(""))
                .map_err(|_| "AES 密钥编码无效")?;
            let nonce_bytes = B64_STD
                .decode(req.get("nonceB64").and_then(Value::as_str).unwrap_or(""))
                .map_err(|_| "Nonce 编码无效")?;
            let nonce_arr: [u8; 12] = nonce_bytes
                .try_into()
                .map_err(|_| "AES-GCM Nonce 必须为 12 字节")?;
            let mut buf = if let Some(b64u) = req.get("ciphertextB64Url").and_then(Value::as_str) {
                B64_URL.decode(b64u.as_bytes()).map_err(|_| "密文 Base64URL 无效")?
            } else {
                B64_STD
                    .decode(req.get("ciphertextB64").and_then(Value::as_str).unwrap_or(""))
                    .map_err(|_| "密文 Base64 无效")?
            };
            let aad = req.get("aadUtf8").and_then(Value::as_str).unwrap_or("");
            let unbound = UnboundKey::new(&AES_256_GCM, &key_bytes).map_err(|_| "AES-256 密钥长度无效")?;
            let key = LessSafeKey::new(unbound);
            let plain = key
                .open_in_place(
                    Nonce::assume_unique_for_key(nonce_arr),
                    Aad::from(aad.as_bytes()),
                    &mut buf,
                )
                .map_err(|_| "AES-256-GCM 解密校验失败")?;
            Ok(json!({
                "plaintextB64": B64_STD.encode(&*plain),
                "plaintextUtf8": String::from_utf8_lossy(plain),
            }))
        }
        "hmacSha256" => {
            let key_bytes = B64_STD
                .decode(req.get("keyB64").and_then(Value::as_str).unwrap_or(""))
                .map_err(|_| "HMAC 密钥编码无效")?;
            let data = if let Some(b64) = req.get("dataB64").and_then(Value::as_str) {
                B64_STD.decode(b64.as_bytes()).map_err(|_| "HMAC 数据编码无效")?
            } else {
                req.get("dataUtf8")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .as_bytes()
                    .to_vec()
            };
            let key = hmac::Key::new(hmac::HMAC_SHA256, &key_bytes);
            let tag = hmac::sign(&key, &data);
            let mut hex = String::with_capacity(64);
            for b in tag.as_ref() {
                use std::fmt::Write;
                let _ = write!(&mut hex, "{b:02x}");
            }
            Ok(json!({ "b64": B64_STD.encode(tag.as_ref()), "hex": hex }))
        }
        other => Err(format!("不支持的 crypto 操作：{other}")),
    }
}

const HOST_SHIM_JS: &str = r#"
(function() {
  const raw = globalThis.__HOST_BRIDGE__;
  function unwrap(jsonStr) {
    const res = JSON.parse(jsonStr);
    if (res && res.__hostError) {
      const err = new Error(String(res.__hostError));
      err.__isHostError = true;
      throw err;
    }
    return res;
  }
  globalThis.host = Object.freeze({
    info: Object.freeze(JSON.parse(raw.infoJson)),
    auth: Object.freeze({ token: raw.authToken || null }),
    fetch(req) {
      return unwrap(raw.fetch(JSON.stringify(req || {})));
    },
    htmlQuery(html, selector) {
      return unwrap(raw.htmlQuery(String(html ?? ""), String(selector ?? "")));
    },
    crypto: Object.freeze({
      sha256Hex(text) { return unwrap(raw.crypto(JSON.stringify({ op: "sha256Hex", text: String(text ?? "") }))).hex; },
      randomBytes(len) { return unwrap(raw.crypto(JSON.stringify({ op: "randomBytes", len: len || 16 }))); },
      base64Encode(text) { return unwrap(raw.crypto(JSON.stringify({ op: "base64Encode", text: String(text ?? "") }))); },
      base64Decode(b64) { return unwrap(raw.crypto(JSON.stringify({ op: "base64Decode", b64: String(b64 ?? "") }))).text; },
      ecdhP256Create() { return unwrap(raw.crypto(JSON.stringify({ op: "ecdhP256Create" }))); },
      ecdhP256Derive(handle, peerPubB64Url, saltB64Url, infos) {
        return unwrap(raw.crypto(JSON.stringify({ op: "ecdhP256Derive", handle, peerPubB64Url, saltB64Url, infos }))).keysB64;
      },
      aes256GcmEncrypt(opts) { return unwrap(raw.crypto(JSON.stringify(Object.assign({ op: "aes256GcmEncrypt" }, opts)))); },
      aes256GcmDecrypt(opts) { return unwrap(raw.crypto(JSON.stringify(Object.assign({ op: "aes256GcmDecrypt" }, opts)))); },
      hmacSha256(opts) { return unwrap(raw.crypto(JSON.stringify(Object.assign({ op: "hmacSha256" }, opts)))); },
    }),
    storage: Object.freeze({
      get(key) {
        const res = unwrap(raw.storageGet(String(key ?? "")));
        return res.value ?? null;
      },
      set(key, val) {
        unwrap(raw.storageSet(String(key ?? ""), val === null || val === undefined ? "" : String(val), val === null || val === undefined));
      },
    }),
  });
  delete globalThis.__HOST_BRIDGE__;
})();
"#;

/// Execute one method on a QuickJS source package in a bounded, isolated sandbox.
pub async fn invoke_source(
    store: Arc<SourceStore>,
    pkg: SourcePackage,
    method: &str,
    input: Value,
    timeout_secs: Option<u64>,
) -> Result<Value, String> {
    invoke_source_with_ctx(store, pkg, method, input, None, None, timeout_secs).await
}

pub async fn invoke_source_with_ctx(
    store: Arc<SourceStore>,
    pkg: SourcePackage,
    method: &str,
    input: Value,
    auth_token: Option<String>,
    base_override: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<Value, String> {
    let method_owned = method.to_string();
    let input_json = serde_json::to_string(&input).map_err(|e| format!("序列化输入失败：{e}"))?;
    let handle = tokio::runtime::Handle::current();
    let timeout = timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS).clamp(1, 20);

    tokio::task::spawn_blocking(move || {
        let rt = Runtime::new().map_err(|e| format!("初始化 QuickJS 运行时失败：{e}"))?;
        rt.set_memory_limit(MAX_MEMORY_BYTES);
        rt.set_max_stack_size(MAX_STACK_BYTES);
        let deadline = Instant::now() + Duration::from_secs(timeout);
        rt.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));

        let ctx = Context::full(&rt).map_err(|e| format!("初始化 QuickJS 上下文失败：{e}"))?;
        let mut allowed_origins = pkg.manifest.network.origins.clone();
        allowed_origins.extend(pkg.manifest.network.publish_origins.clone());
        allowed_origins.extend(crate::lines::trusted_mirrors_snapshot());
        let active_line = base_override.unwrap_or_else(crate::net::base);
        if pkg.manifest.capabilities.lines && !active_line.is_empty() {
            if !allowed_origins.iter().any(|o| o.eq_ignore_ascii_case(&active_line)) {
                allowed_origins.push(active_line.clone());
            }
        }
        let base_url = if !active_line.is_empty()
            && url::Url::parse(&active_line)
                .ok()
                .is_some_and(|u| origin_allowed(&u, &allowed_origins))
        {
            active_line
        } else {
            pkg.manifest
                .network
                .origins
                .first()
                .cloned()
                .unwrap_or_default()
        };

        let info_json = json!({
            "sourceId": pkg.manifest.id,
            "name": pkg.manifest.name,
            "version": pkg.manifest.version,
            "baseUrl": base_url,
            "origins": pkg.manifest.network.origins,
            "mediaOrigins": pkg.manifest.network.media_origins,
            "publishOrigins": pkg.manifest.network.publish_origins,
            "limits": {
                "maxHtmlBytes": MAX_HTML_BYTES,
                "maxResponseBytes": MAX_RESPONSE_BYTES,
                "timeoutMs": timeout * 1000,
            }
        })
        .to_string();

        let source_id = pkg.manifest.id.clone();
        let allowed_rc = Rc::new(allowed_origins);
        let crypto_vault = Rc::new(RefCell::new(CryptoVault::new()));

        ctx.with(|ctx| -> Result<Value, String> {
            let globals = ctx.globals();
            let bridge = Object::new(ctx.clone()).map_err(|e| format!("创建桥接对象失败：{e}"))?;
            bridge
                .set("infoJson", info_json)
                .map_err(|e| format!("写入 infoJson 失败：{e}"))?;
            bridge
                .set("authToken", auth_token.unwrap_or_default())
                .map_err(|e| format!("写入 authToken 失败：{e}"))?;

            let fetch_origins = Rc::clone(&allowed_rc);
            let fetch_handle = handle.clone();
            let fetch_fn = Function::new(ctx.clone(), move |req_json: String| -> String {
                let parsed: Value = match serde_json::from_str(&req_json) {
                    Ok(v) => v,
                    Err(e) => return json!({ "__hostError": format!("fetch 参数无效：{e}") }).to_string(),
                };
                let url = parsed.get("url").and_then(Value::as_str).unwrap_or("");
                let method = parsed.get("method").and_then(Value::as_str).unwrap_or("GET");
                let body = parsed.get("body").and_then(Value::as_str);
                let timeout_ms = parsed.get("timeoutMs").and_then(Value::as_u64).unwrap_or(10_000);
                let mut headers = HashMap::new();
                if let Some(obj) = parsed.get("headers").and_then(Value::as_object) {
                    for (k, v) in obj {
                        if let Some(s) = v.as_str() {
                            headers.insert(k.clone(), s.to_string());
                        }
                    }
                }
                let origins = fetch_origins.as_slice();
                match fetch_handle.block_on(host_http_request(
                    method,
                    url,
                    &headers,
                    body,
                    Some(origins),
                    MAX_RESPONSE_BYTES,
                    (timeout_ms / 1000).max(2),
                )) {
                    Ok(v) => v.to_string(),
                    Err(e) => json!({ "__hostError": e }).to_string(),
                }
            })
            .map_err(|e| format!("注册 host.fetch 失败：{e}"))?;
            bridge
                .set("fetch", fetch_fn)
                .map_err(|e| format!("绑定 host.fetch 失败：{e}"))?;

            let html_fn = Function::new(ctx.clone(), |html: String, selector: String| -> String {
                match run_html_query(&html, &selector) {
                    Ok(v) => v.to_string(),
                    Err(e) => json!({ "__hostError": e }).to_string(),
                }
            })
            .map_err(|e| format!("注册 host.htmlQuery 失败：{e}"))?;
            bridge
                .set("htmlQuery", html_fn)
                .map_err(|e| format!("绑定 host.htmlQuery 失败：{e}"))?;

            let crypto_ref = Rc::clone(&crypto_vault);
            let crypto_fn = Function::new(ctx.clone(), move |op_json: String| -> String {
                let parsed: Value = match serde_json::from_str(&op_json) {
                    Ok(v) => v,
                    Err(e) => return json!({ "__hostError": format!("crypto 参数无效：{e}") }).to_string(),
                };
                match run_crypto_op(&crypto_ref, &parsed) {
                    Ok(v) => v.to_string(),
                    Err(e) => json!({ "__hostError": e }).to_string(),
                }
            })
            .map_err(|e| format!("注册 host.crypto 失败：{e}"))?;
            bridge
                .set("crypto", crypto_fn)
                .map_err(|e| format!("绑定 host.crypto 失败：{e}"))?;

            let st_get_store = Arc::clone(&store);
            let st_get_id = source_id.clone();
            let storage_get = Function::new(ctx.clone(), move |key: String| -> String {
                let val = st_get_store.kv_get(&st_get_id, &key);
                json!({ "value": val }).to_string()
            })
            .map_err(|e| format!("注册 host.storage.get 失败：{e}"))?;
            bridge
                .set("storageGet", storage_get)
                .map_err(|e| format!("绑定 storageGet 失败：{e}"))?;

            let st_set_store = Arc::clone(&store);
            let st_set_id = source_id.clone();
            let storage_set = Function::new(
                ctx.clone(),
                move |key: String, val: String, clear: bool| -> String {
                    match st_set_store.kv_set(&st_set_id, &key, (!clear).then_some(val)) {
                        Ok(()) => json!({ "ok": true }).to_string(),
                        Err(e) => json!({ "__hostError": e }).to_string(),
                    }
                },
            )
            .map_err(|e| format!("注册 host.storage.set 失败：{e}"))?;
            bridge
                .set("storageSet", storage_set)
                .map_err(|e| format!("绑定 storageSet 失败：{e}"))?;

            globals
                .set("__HOST_BRIDGE__", bridge)
                .map_err(|e| format!("注入宿主桥接失败：{e}"))?;

            ctx.eval::<(), _>(HOST_SHIM_JS)
                .catch(&ctx)
                .map_err(|e| format!("初始化宿主桥接脚本失败：{e}"))?;

            // Load source.js inside a CommonJS-like module wrapper.
            let wrapped = format!(
                "const __mod = {{ exports: {{}} }};\n(function(module, exports, host) {{\n{}\n}})(__mod, __mod.exports, globalThis.host);\nglobalThis.__SOURCE__ = (__mod.exports && Object.keys(__mod.exports).length) ? __mod.exports : (globalThis.source || __mod.exports);\n",
                pkg.code
            );
            ctx.eval::<(), _>(wrapped)
                .catch(&ctx)
                .map_err(|e| format!("加载视频源脚本失败：{e}"))?;

            globals
                .set("__CALL_METHOD__", method_owned)
                .map_err(|e| format!("写入方法名失败：{e}"))?;
            globals
                .set("__CALL_INPUT__", input_json)
                .map_err(|e| format!("写入方法参数失败：{e}"))?;

            let invoke_script = r#"
                (function() {
                  const src = globalThis.__SOURCE__;
                  if (!src || typeof src !== "object") {
                    throw new Error("视频源未导出有效对象（module.exports）");
                  }
                  const method = globalThis.__CALL_METHOD__;
                  const fn = src[method];
                  if (typeof fn !== "function") {
                    if (method === "init") return JSON.stringify({ ok: true });
                    return JSON.stringify({ __unsupported: true, method });
                  }
                  const input = JSON.parse(globalThis.__CALL_INPUT__);
                  try {
                    const out = fn.call(src, input, globalThis.host);
                    return JSON.stringify(out === undefined ? null : out);
                  } catch (err) {
                    const msg = err && typeof err === "object" && "message" in err
                      ? String(err.message ?? "")
                      : String(err ?? "");
                    const trimmed = msg.trim();
                    const status = err && typeof err === "object" && "status" in err
                      ? Number(err.status)
                      : NaN;
                    if (trimmed === "401" || status === 401 || /^HTTP 401\b/.test(trimmed)) {
                      return JSON.stringify({ __authError: 401 });
                    }
                    if (/^HTTP \d{3}\b/.test(trimmed)) {
                      return JSON.stringify({ __httpError: trimmed });
                    }
                    if (err && typeof err === "object" && err.__isHostError) {
                      return JSON.stringify({ __hostError: trimmed });
                    }
                    const name = err && typeof err === "object" && "name" in err && err.name && err.name !== "Error"
                      ? String(err.name) + ": "
                      : "";
                    return JSON.stringify({ __sourceError: (name + trimmed).trim() || "未知脚本异常" });
                  }
                })()
            "#;

            let result_json: String = ctx
                .eval(invoke_script)
                .catch(&ctx)
                .map_err(|e| {
                    let msg = e.to_string();
                    if msg.contains("interrupted") {
                        "视频源脚本执行超时，已强制中止".to_string()
                    } else {
                        let first_line = msg.lines().next().unwrap_or(&msg).trim();
                        format!("视频源执行失败：{first_line}")
                    }
                })?;

            let parsed: Value = serde_json::from_str(&result_json)
                .map_err(|e| format!("视频源返回 JSON 无效：{e}"))?;
            if parsed.get("__authError").and_then(Value::as_u64) == Some(401) {
                return Err("401".to_string());
            }
            if let Some(http_err) = parsed.get("__httpError").and_then(Value::as_str) {
                return Err(http_err.to_string());
            }
            if let Some(host_err) = parsed.get("__hostError").and_then(Value::as_str) {
                return Err(host_err.to_string());
            }
            if let Some(source_err) = parsed.get("__sourceError").and_then(Value::as_str) {
                return Err(format!("视频源执行失败：{source_err}"));
            }
            if parsed.get("__unsupported").and_then(Value::as_bool) == Some(true) {
                return Err(format!(
                    "当前视频源未实现该方法：{}",
                    parsed.get("method").and_then(Value::as_str).unwrap_or("unknown")
                ));
            }
            Ok(parsed)
        })
    })
    .await
    .map_err(|e| format!("视频源沙箱线程异常：{e}"))?
}
