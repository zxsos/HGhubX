use crate::api::Api;
use serde_json::Value;
use tauri::State;

/// Author directory: `/api/users?sort=followers` for the search hot-author list and the all-authors page.
#[tauri::command]
pub async fn api_popular_authors(
    state: State<'_, Api>,
    page: u32,
    size: u32,
) -> Result<Value, String> {
    let page = page.max(1);
    let size = size.clamp(1, 100);
    state
        .get(&format!("/api/users?page={page}&size={size}&sort=followers"))
        .await
}
