//! Structured observability events for the context / LLM / ingest / sync hot
//! paths. Every event is a single line with `target = "shogun::memory_obs"`,
//! formatted as `event=<name> key1=value1 key2=value2 ...`. Sensitive text
//! (raw queries, snippets, titles) is never emitted — only lengths, counts,
//! and optional `*_preview` fields clipped to 40 characters.

/// Format a single event line. Values that contain a space, `=`, or `"` are
/// wrapped in double quotes; embedded quotes inside such values are escaped
/// as `\"`. Fields are emitted in the order given.
pub fn format_event(event: &str, fields: &[(&'static str, String)]) -> String {
    let mut out = format!("event={}", event);
    for (k, v) in fields {
        out.push(' ');
        out.push_str(k);
        out.push('=');
        if v.contains(' ') || v.contains('=') || v.contains('"') {
            out.push('"');
            out.push_str(&v.replace('"', "\\\""));
            out.push('"');
        } else {
            out.push_str(v);
        }
    }
    out
}

/// Emit an event at INFO level under `target = "shogun::memory_obs"`.
pub fn emit(event: &str, fields: &[(&'static str, String)]) {
    let msg = format_event(event, fields);
    log::info!(target: "shogun::memory_obs", "{}", msg);
}

/// Clip a string for a `*_preview` field: take the first 40 **characters**
/// (not bytes) and collapse newlines so one event is one line.
pub fn clip_preview(s: &str) -> String {
    s.chars()
        .take(40)
        .collect::<String>()
        .replace('\n', " ")
        .replace('\r', " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_event_emits_event_key_first() {
        let out = format_event("assemble_hits_begin", &[]);
        assert_eq!(out, "event=assemble_hits_begin");
    }

    #[test]
    fn format_event_appends_fields_in_order() {
        let out = format_event(
            "assemble_hits_done",
            &[
                ("hits", "7".to_string()),
                ("elapsed_ms", "14".to_string()),
            ],
        );
        assert_eq!(out, "event=assemble_hits_done hits=7 elapsed_ms=14");
    }

    #[test]
    fn format_event_quotes_values_with_spaces() {
        let out = format_event("probe", &[("error", "bad request".to_string())]);
        assert_eq!(out, "event=probe error=\"bad request\"");
    }

    #[test]
    fn format_event_quotes_values_with_equals() {
        let out = format_event("probe", &[("k", "a=b".to_string())]);
        assert_eq!(out, "event=probe k=\"a=b\"");
    }

    #[test]
    fn format_event_escapes_embedded_quotes() {
        let out = format_event("probe", &[("msg", "he said \"hi\"".to_string())]);
        assert_eq!(out, "event=probe msg=\"he said \\\"hi\\\"\"");
    }

    #[test]
    fn clip_preview_caps_at_40_chars_and_drops_newlines() {
        let long = "a".repeat(100);
        assert_eq!(clip_preview(&long).chars().count(), 40);
        let multi = "line1\nline2\rline3";
        assert_eq!(clip_preview(multi), "line1 line2 line3");
    }

    #[test]
    fn clip_preview_counts_chars_not_bytes() {
        // 3 Japanese chars = 9 bytes in UTF-8, but we cap by char count.
        let s = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん";
        let out = clip_preview(s);
        assert_eq!(out.chars().count(), 40);
    }

    #[test]
    fn emit_routes_to_log_with_memory_obs_target() {
        testing_logger::setup();
        emit("unit_probe", &[("k", "v".to_string())]);
        testing_logger::validate(|logs| {
            let found = logs
                .iter()
                .find(|l| l.target == "shogun::memory_obs");
            let f = found.expect("no shogun::memory_obs event captured");
            assert_eq!(f.body, "event=unit_probe k=v");
            assert_eq!(f.level, log::Level::Info);
        });
    }
}
