use crate::app_state::AppDirs;
use crate::settings::secret_store::get_secret;
use serde::{Deserialize, Serialize};
use tauri::State;

const BALANCE_URL: &str = "https://api.nexara.ru/api/v1/billing/balance";
const NEXARA_API_KEY: &str = "NEXARA_API_KEY";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NexaraBalance {
    pub balance: f64,
    pub currency: String,
    pub rate_per_min: f64,
}

#[tauri::command]
pub async fn get_nexara_balance(dirs: State<'_, AppDirs>) -> Result<NexaraBalance, String> {
    let api_key = get_secret(&dirs.app_data_dir, NEXARA_API_KEY)
        .map_err(|_| "Nexara API key is not configured".to_string())?;
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return Err("Nexara API key is not configured".to_string());
    }

    let client = reqwest::Client::new();
    let res = client
        .get(BALANCE_URL)
        .bearer_auth(trimmed)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("Nexara balance request failed: {status} {body}"));
    }

    res.json::<NexaraBalance>()
        .await
        .map_err(|e| format!("Failed to parse Nexara balance response: {e}"))
}
