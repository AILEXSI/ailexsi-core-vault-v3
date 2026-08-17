//! AILEXSI Core Vault V3 — Tauri shell
//!
//! Bridge path:
//!   Frontend invoke(memory_*)
//!     → Rust HTTP proxy
//!     → DesktopHost bridge (127.0.0.1:17890)
//!     → long-lived createCoreRuntime → PostgresEventStore
//!
//! No InMemory fallback. Host must be running (npm run desktop:host).

use serde_json::{json, Value};


fn host_base() -> String {
  std::env::var("DESKTOP_HOST_URL")
    .unwrap_or_else(|_| "http://127.0.0.1:17890".to_string())
    .trim_end_matches('/')
    .to_string()
}

fn proxy_get(path: &str) -> Result<Value, String> {
  let url = format!("{}{}", host_base(), path);
  let resp = ureq::get(&url)
    .timeout(std::time::Duration::from_secs(10))
    .call()
    .map_err(|e| format!("DesktopHost unreachable at {url}: {e}"))?;
  resp
    .into_json()
    .map_err(|e| format!("invalid DesktopHost JSON: {e}"))
}

fn proxy_post(path: &str, body: Value) -> Result<Value, String> {
  let url = format!("{}{}", host_base(), path);
  let resp = ureq::post(&url)
    .timeout(std::time::Duration::from_secs(30))
    .send_json(body)
    .map_err(|e| format!("DesktopHost command failed at {url}: {e}"))?;
  resp
    .into_json()
    .map_err(|e| format!("invalid DesktopHost JSON: {e}"))
}

fn ensure_host() -> Result<Value, String> {
  let health = proxy_get("/health")?;
  let ok = health
    .get("ok")
    .and_then(|v| v.as_bool())
    .unwrap_or(false);
  if !ok {
    return Err(
      "DesktopHost not ready. Start: npm run desktop:host (CORE_DATABASE_URL required). No InMemory fallback."
        .into(),
    );
  }
  Ok(health)
}

#[tauri::command]
fn desktop_host_status() -> Result<Value, String> {
  ensure_host()
}

#[tauri::command]
fn desktop_attach_host() -> Result<Value, String> {
  // Probe + report — host is external long-lived process
  let health = ensure_host()?;
  Ok(json!({
    "attached": true,
    "health": health,
    "path": "Tauri → HTTP → DesktopHost → PostgresEventStore"
  }))
}

#[tauri::command]
fn memory_create(payload: Value) -> Result<Value, String> {
  ensure_host()?;
  proxy_post("/commands/memory.create", payload)
}

#[tauri::command]
fn memory_get(memory_id: String) -> Result<Value, String> {
  ensure_host()?;
  proxy_post(
    "/commands/memory.get",
    json!({ "memoryId": memory_id }),
  )
}

#[tauri::command]
fn memory_list(payload: Option<Value>) -> Result<Value, String> {
  ensure_host()?;
  proxy_post(
    "/commands/memory.list",
    payload.unwrap_or_else(|| json!({ "includeArchived": true })),
  )
}

#[tauri::command]
fn memory_update(payload: Value) -> Result<Value, String> {
  ensure_host()?;
  proxy_post("/commands/memory.update", payload)
}

#[tauri::command]
fn memory_archive(payload: Value) -> Result<Value, String> {
  ensure_host()?;
  proxy_post("/commands/memory.archive", payload)
}

#[tauri::command]
fn memory_restore(payload: Value) -> Result<Value, String> {
  ensure_host()?;
  proxy_post("/commands/memory.restore", payload)
}

#[tauri::command]
fn memory_history(memory_id: String) -> Result<Value, String> {
  ensure_host()?;
  proxy_post(
    "/commands/memory.history",
    json!({ "memoryId": memory_id }),
  )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .invoke_handler(tauri::generate_handler![
      desktop_attach_host,
      desktop_host_status,
      memory_create,
      memory_get,
      memory_list,
      memory_update,
      memory_archive,
      memory_restore,
      memory_history,
    ])
    .run(tauri::generate_context!())
    .expect("error while running AILEXSI Core Vault V3");
}
