//! Atomic on-disk store for installed source packages, rollback versions, and per-source KV state.

use super::manifest::{
    is_safe_id, semver_gt, SourceCapabilities, SourceCatalogConfig, SourceLinksConfig, SourcePackage,
};
use super::verify::SignatureInfo;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSourceSummary {
    pub id: String,
    pub name: String,
    pub version: String,
    pub previous_version: Option<String>,
    pub description: String,
    pub author: String,
    pub api_version: String,
    pub runtime_kind: String,
    pub origins: Vec<String>,
    pub capabilities: SourceCapabilities,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog: Option<SourceCatalogConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub links: Option<SourceLinksConfig>,
    pub update_urls: Vec<String>,
    pub signature: SignatureInfo,
    pub installed_at: u64,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStateSnapshot {
    pub active_source_id: Option<String>,
    pub allow_untrusted: bool,
    pub sources: Vec<InstalledSourceSummary>,
}

fn default_allow_untrusted() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RegistryFile {
    active_source_id: Option<String>,
    #[serde(default = "default_allow_untrusted")]
    allow_untrusted: bool,
    records: HashMap<String, StoredRecord>,
}

impl Default for RegistryFile {
    fn default() -> Self {
        Self {
            active_source_id: None,
            allow_untrusted: true,
            records: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredRecord {
    id: String,
    name: String,
    version: String,
    previous_version: Option<String>,
    description: String,
    author: String,
    api_version: String,
    runtime_kind: String,
    origins: Vec<String>,
    capabilities: SourceCapabilities,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    catalog: Option<SourceCatalogConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    links: Option<SourceLinksConfig>,
    update_urls: Vec<String>,
    signature: SignatureInfo,
    installed_at: u64,
}

struct Inner {
    root: Option<PathBuf>,
    registry: RegistryFile,
    /// In-memory cache of installed packages keyed by `(id, version)` (also supports unbound tests).
    packages: HashMap<(String, String), SourcePackage>,
    /// Per-source isolated key-value storage.
    kv: HashMap<String, HashMap<String, String>>,
}

pub struct SourceStore {
    inner: RwLock<Inner>,
    kv_io_lock: Mutex<()>,
}

fn unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

static WRITE_SEQ: AtomicU64 = AtomicU64::new(0);

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建视频源目录失败：{e}"))?;
    }
    let seq = WRITE_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("tmp.{seq}"));
    fs::write(&tmp, bytes).map_err(|e| format!("写入临时文件失败：{e}"))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("原子落盘失败：{e}")
    })
}

impl SourceStore {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(Inner {
                root: None,
                registry: RegistryFile::default(),
                packages: HashMap::new(),
                kv: HashMap::new(),
            }),
            kv_io_lock: Mutex::new(()),
        }
    }

    pub fn bind(&self, app_data_dir: &Path) {
        let root = app_data_dir.join("sources");
        let _ = fs::create_dir_all(&root);
        let reg_path = root.join("registry.json");
        let registry: RegistryFile = fs::read(&reg_path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();

        let mut packages = HashMap::new();
        let mut kv = HashMap::new();
        for rec in registry.records.values() {
            for ver in std::iter::once(&rec.version).chain(rec.previous_version.iter()) {
                let pkg_path = root.join(&rec.id).join("releases").join(ver).join("package.json");
                if let Ok(bytes) = fs::read(&pkg_path) {
                    if let Ok(pkg) = serde_json::from_slice::<SourcePackage>(&bytes) {
                        packages.insert((rec.id.clone(), ver.clone()), pkg);
                    }
                }
            }
            let kv_path = root.join(&rec.id).join("state.json");
            if let Ok(bytes) = fs::read(&kv_path) {
                if let Ok(map) = serde_json::from_slice::<HashMap<String, String>>(&bytes) {
                    kv.insert(rec.id.clone(), map);
                }
            }
        }

        let mut g = self.inner.write().unwrap_or_else(|e| e.into_inner());
        g.root = Some(root);
        g.registry = registry;
        g.packages = packages;
        g.kv = kv;
    }

    fn save_registry(inner: &Inner) -> Result<(), String> {
        let Some(root) = &inner.root else { return Ok(()) };
        let bytes = serde_json::to_vec_pretty(&inner.registry)
            .map_err(|e| format!("序列化注册表失败：{e}"))?;
        write_atomic(&root.join("registry.json"), &bytes)
    }

    fn save_package_file(inner: &Inner, pkg: &SourcePackage) -> Result<(), String> {
        let Some(root) = &inner.root else { return Ok(()) };
        let path = root
            .join(&pkg.manifest.id)
            .join("releases")
            .join(&pkg.manifest.version)
            .join("package.json");
        let bytes = serde_json::to_vec_pretty(pkg).map_err(|e| format!("序列化包文件失败：{e}"))?;
        write_atomic(&path, &bytes)
    }

    fn summary_of(rec: &StoredRecord, active_id: Option<&str>) -> InstalledSourceSummary {
        InstalledSourceSummary {
            id: rec.id.clone(),
            name: rec.name.clone(),
            version: rec.version.clone(),
            previous_version: rec.previous_version.clone(),
            description: rec.description.clone(),
            author: rec.author.clone(),
            api_version: rec.api_version.clone(),
            runtime_kind: rec.runtime_kind.clone(),
            origins: rec.origins.clone(),
            capabilities: rec.capabilities.clone(),
            catalog: rec.catalog.clone(),
            links: rec.links.clone(),
            update_urls: rec.update_urls.clone(),
            signature: rec.signature.clone(),
            installed_at: rec.installed_at,
            active: active_id == Some(rec.id.as_str()),
        }
    }

    pub fn snapshot(&self) -> SourceStateSnapshot {
        let g = self.inner.read().unwrap_or_else(|e| e.into_inner());
        let active = g.registry.active_source_id.as_deref();
        let mut sources: Vec<InstalledSourceSummary> = g
            .registry
            .records
            .values()
            .map(|r| Self::summary_of(r, active))
            .collect();
        sources.sort_by(|a, b| b.active.cmp(&a.active).then_with(|| a.name.cmp(&b.name)));
        SourceStateSnapshot {
            active_source_id: g.registry.active_source_id.clone(),
            allow_untrusted: g.registry.allow_untrusted,
            sources,
        }
    }

    pub fn allow_untrusted(&self) -> bool {
        self.inner
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .registry
            .allow_untrusted
    }

    pub fn set_allow_untrusted(&self, allow: bool) -> Result<SourceStateSnapshot, String> {
        let mut g = self.inner.write().unwrap_or_else(|e| e.into_inner());
        g.registry.allow_untrusted = allow;
        Self::save_registry(&g)?;
        drop(g);
        Ok(self.snapshot())
    }

    pub fn active_package(&self) -> Option<SourcePackage> {
        let g = self.inner.read().unwrap_or_else(|e| e.into_inner());
        let id = g.registry.active_source_id.as_ref()?;
        let rec = g.registry.records.get(id)?;
        g.packages.get(&(id.clone(), rec.version.clone())).cloned()
    }

    pub fn get_package(&self, id: &str) -> Option<SourcePackage> {
        let g = self.inner.read().unwrap_or_else(|e| e.into_inner());
        let rec = g.registry.records.get(id)?;
        g.packages.get(&(rec.id.clone(), rec.version.clone())).cloned()
    }

    pub fn install(
        &self,
        pkg: SourcePackage,
        signature: SignatureInfo,
        activate_if_none: bool,
    ) -> Result<InstalledSourceSummary, String> {
        let id = pkg.manifest.id.clone();
        if !is_safe_id(&id) {
            return Err("视频源 id 非法".into());
        }
        let mut g = self.inner.write().unwrap_or_else(|e| e.into_inner());
        let prev_ver = g.registry.records.get(&id).map(|old| {
            if old.version != pkg.manifest.version {
                Some(old.version.clone())
            } else {
                old.previous_version.clone()
            }
        }).flatten();

        // Write new release atomically BEFORE mutating registry so failed writes leave old version intact.
        Self::save_package_file(&g, &pkg)?;

        let rec = StoredRecord {
            id: id.clone(),
            name: pkg.manifest.name.trim().to_string(),
            version: pkg.manifest.version.clone(),
            previous_version: prev_ver,
            description: pkg.manifest.description.clone(),
            author: pkg.manifest.author.clone(),
            api_version: pkg.manifest.api_version.clone(),
            runtime_kind: pkg.manifest.runtime.kind.clone(),
            origins: pkg.manifest.network.origins.clone(),
            capabilities: pkg.manifest.capabilities.clone(),
            catalog: pkg.manifest.catalog.clone(),
            links: pkg.manifest.links.clone(),
            update_urls: pkg.update_urls.clone(),
            signature,
            installed_at: unix_secs(),
        };

        g.packages.insert((id.clone(), pkg.manifest.version.clone()), pkg);
        g.registry.records.insert(id.clone(), rec.clone());
        if activate_if_none && g.registry.active_source_id.is_none() {
            // Keep active source unset until user explicitly activates, unless caller opts in.
            g.registry.active_source_id = Some(id.clone());
        }
        Self::save_registry(&g)?;
        let active_id = g.registry.active_source_id.clone();
        Ok(Self::summary_of(&rec, active_id.as_deref()))
    }

    pub fn activate(&self, id: Option<String>) -> Result<SourceStateSnapshot, String> {
        let mut g = self.inner.write().unwrap_or_else(|e| e.into_inner());
        if let Some(ref target) = id {
            if !g.registry.records.contains_key(target) {
                return Err("目标视频源不存在".into());
            }
        }
        g.registry.active_source_id = id;
        Self::save_registry(&g)?;
        drop(g);
        Ok(self.snapshot())
    }

    pub fn rollback(&self, id: &str) -> Result<InstalledSourceSummary, String> {
        let mut g = self.inner.write().unwrap_or_else(|e| e.into_inner());
        let rec = g
            .registry
            .records
            .get(id)
            .ok_or_else(|| "视频源不存在".to_string())?
            .clone();
        let prev = rec
            .previous_version
            .clone()
            .ok_or_else(|| "没有可回滚的上一版本".to_string())?;
        let prev_pkg = g
            .packages
            .get(&(id.to_string(), prev.clone()))
            .ok_or_else(|| "上一版本包文件已丢失，无法回滚".to_string())?
            .clone();

        let rolled = StoredRecord {
            id: rec.id.clone(),
            name: prev_pkg.manifest.name.trim().to_string(),
            version: prev_pkg.manifest.version.clone(),
            previous_version: Some(rec.version),
            description: prev_pkg.manifest.description.clone(),
            author: prev_pkg.manifest.author.clone(),
            api_version: prev_pkg.manifest.api_version.clone(),
            runtime_kind: prev_pkg.manifest.runtime.kind.clone(),
            origins: prev_pkg.manifest.network.origins.clone(),
            capabilities: prev_pkg.manifest.capabilities.clone(),
            catalog: prev_pkg.manifest.catalog.clone(),
            links: prev_pkg.manifest.links.clone(),
            update_urls: prev_pkg.update_urls.clone(),
            signature: rec.signature,
            installed_at: unix_secs(),
        };
        g.registry.records.insert(id.to_string(), rolled.clone());
        Self::save_registry(&g)?;
        let active_id = g.registry.active_source_id.clone();
        Ok(Self::summary_of(&rolled, active_id.as_deref()))
    }

    pub fn remove(&self, id: &str) -> Result<SourceStateSnapshot, String> {
        let mut g = self.inner.write().unwrap_or_else(|e| e.into_inner());
        if g.registry.records.remove(id).is_none() {
            return Err("视频源不存在".into());
        }
        if g.registry.active_source_id.as_deref() == Some(id) {
            g.registry.active_source_id = None;
        }
        g.packages.retain(|(k, _), _| k != id);
        g.kv.remove(id);
        if let Some(root) = &g.root {
            let _ = fs::remove_dir_all(root.join(id));
        }
        Self::save_registry(&g)?;
        drop(g);
        Ok(self.snapshot())
    }

    pub fn remove_many(&self, ids: &[String]) -> Result<(SourceStateSnapshot, usize), String> {
        if ids.is_empty() {
            return Err("请至少选择一个视频源".into());
        }
        let mut g = self.inner.write().unwrap_or_else(|e| e.into_inner());
        let mut removed = Vec::new();
        for id in ids {
            if g.registry.records.remove(id.as_str()).is_some() {
                removed.push(id.clone());
            }
        }
        if removed.is_empty() {
            return Err("视频源不存在".into());
        }
        if let Some(active) = g.registry.active_source_id.as_ref() {
            if removed.iter().any(|id| id == active) {
                g.registry.active_source_id = None;
            }
        }
        for id in &removed {
            g.packages.retain(|(k, _), _| k != id);
            g.kv.remove(id);
            if let Some(root) = &g.root {
                let _ = fs::remove_dir_all(root.join(id));
            }
        }
        Self::save_registry(&g)?;
        let count = removed.len();
        drop(g);
        Ok((self.snapshot(), count))
    }

    pub fn is_newer_than_installed(&self, id: &str, version: &str) -> bool {
        let g = self.inner.read().unwrap_or_else(|e| e.into_inner());
        match g.registry.records.get(id) {
            Some(rec) => semver_gt(version, &rec.version),
            None => true,
        }
    }

    pub fn kv_get(&self, source_id: &str, key: &str) -> Option<String> {
        let g = self.inner.read().unwrap_or_else(|e| e.into_inner());
        g.kv.get(source_id).and_then(|m| m.get(key)).cloned()
    }

    pub fn kv_set(&self, source_id: &str, key: &str, val: Option<String>) -> Result<(), String> {
        if key.len() > 128 {
            return Err("storage key 过长".into());
        }
        if val.as_deref().is_some_and(|v| v.len() > 32 * 1024) {
            return Err("storage value 超出上限（32 KB）".into());
        }
        let has_root = {
            let mut g = self.inner.write().unwrap_or_else(|e| e.into_inner());
            let map = g.kv.entry(source_id.to_string()).or_default();
            if map.get(key) == val.as_ref() {
                return Ok(());
            }
            if map.len() >= 64 && !map.contains_key(key) {
                return Err("单源本地存储键数量超出上限（64）".into());
            }
            match val {
                Some(v) => { map.insert(key.to_string(), v); }
                None => { map.remove(key); }
            }
            g.root.is_some()
        };
        if has_root {
            let _io_guard = self.kv_io_lock.lock().unwrap_or_else(|e| e.into_inner());
            let snapshot = {
                let g = self.inner.read().unwrap_or_else(|e| e.into_inner());
                g.root.as_ref().map(|root| {
                    let bytes = g
                        .kv
                        .get(source_id)
                        .map(serde_json::to_vec)
                        .unwrap_or_else(|| Ok(b"{}".to_vec()));
                    (root.join(source_id).join("state.json"), bytes)
                })
            };
            if let Some((path, bytes_res)) = snapshot {
                let bytes = bytes_res.map_err(|e| format!("保存源状态失败：{e}"))?;
                write_atomic(&path, &bytes)?;
            }
        }
        Ok(())
    }
}
