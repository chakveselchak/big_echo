const DISALLOWED_TOKEN_CHARS: [char; 3] = ['\u{2028}', '\u{2029}', '\u{FEFF}'];

pub fn contains_disallowed_token_chars(value: &str) -> bool {
    value.chars().any(|c| c.is_control() || DISALLOWED_TOKEN_CHARS.contains(&c))
}

pub fn validate_secret_token(value: &str) -> Result<&str, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Token must not be empty".to_string());
    }
    if contains_disallowed_token_chars(trimmed) {
        return Err("Token must not contain control characters".to_string());
    }
    Ok(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_secret_token_rejects_newlines_and_unicode_separators() {
        for token in ["token\nvalue", "token\rvalue", "token\u{2028}value", "token\u{2029}value", "\u{FEFF}token"] {
            let err = validate_secret_token(token).expect_err("token should be rejected");
            assert_eq!(err, "Token must not contain control characters");
        }
    }

    #[test]
    fn validate_secret_token_accepts_normal_tokens() {
        assert_eq!(
            validate_secret_token("  abc123-token_value  ").expect("valid token"),
            "abc123-token_value"
        );
    }
}
