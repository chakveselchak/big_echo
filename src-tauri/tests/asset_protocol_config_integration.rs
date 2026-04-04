use serde_json::Value;

#[test]
fn tauri_config_enables_asset_protocol_for_session_audio() {
    let config_path = concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json");
    let body = std::fs::read_to_string(config_path).expect("read tauri.conf.json");
    let json: Value = serde_json::from_str(&body).expect("parse tauri.conf.json");

    let asset_protocol = json
        .get("app")
        .and_then(|value| value.get("security"))
        .and_then(|value| value.get("assetProtocol"))
        .expect("assetProtocol config");

    assert_eq!(
        asset_protocol.get("enable").and_then(Value::as_bool),
        Some(true),
        "assetProtocol.enable must be true for inline session audio playback"
    );

    let scope = asset_protocol
        .get("scope")
        .and_then(Value::as_array)
        .expect("assetProtocol.scope array");
    assert!(
        !scope.is_empty(),
        "assetProtocol.scope must allow session audio file locations"
    );
}
