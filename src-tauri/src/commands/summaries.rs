#[tauri::command]
pub async fn shogun_memory_summary_get(
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let target_id = payload
        .get("targetId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "targetId is required".to_string())?
        .to_string();
    let target_kind = payload
        .get("targetKind")
        .and_then(|v| v.as_str())
        .unwrap_or("item")
        .to_string();
    let lang = payload
        .get("lang")
        .and_then(|v| v.as_str())
        .unwrap_or("en")
        .to_string();

    // 1. cache lookup (lang-aware: mismatched language → cache miss → regen)
    if let Some(cached) = crate::summarizer_store::get_cached(&target_kind, &target_id, &lang)? {
        return Ok(serde_json::json!({ "summary": cached.to_json(), "cached": true }));
    }

    // 2. generate (Phase 1 は item のみサポート)
    if target_kind != "item" {
        return Err(format!(
            "target_kind={} not supported in Phase 1",
            target_kind
        ));
    }

    let item = payload
        .get("item")
        .cloned()
        .ok_or_else(|| "item payload required when cache miss".to_string())?;

    let summary = crate::summarizer::summarize_item(&item, &lang).await?;
    crate::summarizer_store::upsert(&summary)?;

    Ok(serde_json::json!({ "summary": summary.to_json(), "cached": false }))
}

#[tauri::command]
pub async fn shogun_memory_summary_batch(
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let items = payload
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .ok_or_else(|| "items array required".to_string())?;
    let lang = payload
        .get("lang")
        .and_then(|v| v.as_str())
        .unwrap_or("en")
        .to_string();

    if items.is_empty() {
        return Ok(serde_json::json!({ "ok": [], "failed": [], "heuristicUsed": 0 }));
    }

    // 1. cache lookup for all ids at once
    let ids: Vec<String> = items
        .iter()
        .filter_map(|it| it.get("id").and_then(|v| v.as_str()).map(String::from))
        .collect();
    let cached = crate::summarizer_store::get_cached_many("item", &ids, &lang)?;
    let cached_ids: std::collections::HashSet<String> =
        cached.iter().map(|s| s.target_id.clone()).collect();

    let mut ok_results: Vec<serde_json::Value> = cached.iter().map(|s| s.to_json()).collect();
    let mut failed_results: Vec<serde_json::Value> = Vec::new();
    let mut heuristic_used: u32 = 0;

    // 2. 未キャッシュの item を並列要約 (max 5 並列)
    let to_generate: Vec<serde_json::Value> = items
        .iter()
        .filter(|it| {
            it.get("id")
                .and_then(|v| v.as_str())
                .map_or(false, |id| !cached_ids.contains(id))
        })
        .cloned()
        .collect();

    for chunk in to_generate.chunks(5) {
        let futures: Vec<_> = chunk
            .iter()
            .map(|item| {
                let item_clone = item.clone();
                let lang_clone = lang.clone();
                async move {
                    let target_id = item_clone
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                        .to_string();
                    match crate::summarizer::summarize_item(&item_clone, &lang_clone).await {
                        Ok(s) => {
                            if let Err(e) = crate::summarizer_store::upsert(&s) {
                                log::warn!("summary upsert failed for {}: {}", target_id, e);
                            }
                            Ok(s)
                        }
                        Err(e) => Err((target_id, e)),
                    }
                }
            })
            .collect();

        let results = futures::future::join_all(futures).await;
        for r in results {
            match r {
                Ok(s) => {
                    if s.model == "heuristic" || s.model == "heuristic_prefilter" {
                        heuristic_used += 1;
                    }
                    ok_results.push(s.to_json());
                }
                Err((id, e)) => {
                    failed_results.push(serde_json::json!({ "targetId": id, "error": e }));
                }
            }
        }
    }

    Ok(serde_json::json!({
      "ok": ok_results,
      "failed": failed_results,
      "heuristicUsed": heuristic_used,
    }))
}

#[tauri::command]
pub fn shogun_memory_summary_invalidate(
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let target_id = payload
        .get("targetId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "targetId required".to_string())?;
    let target_kind = payload
        .get("targetKind")
        .and_then(|v| v.as_str())
        .unwrap_or("item");
    let deleted = crate::summarizer_store::delete(target_kind, target_id)?;
    Ok(serde_json::json!({ "deleted": deleted }))
}

#[tauri::command]
pub fn shogun_memory_summary_snooze(
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let target_id = payload
        .get("targetId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "targetId required".to_string())?;
    let target_kind = payload
        .get("targetKind")
        .and_then(|v| v.as_str())
        .unwrap_or("item");
    let until_ms: Option<i64> = match payload.get("untilMs") {
        Some(v) if v.is_null() => None,
        Some(v) => Some(
            v.as_i64()
                .ok_or_else(|| "untilMs must be a number or null".to_string())?,
        ),
        None => None,
    };
    let updated = crate::summarizer_store::set_snoozed(target_kind, target_id, until_ms)?;
    Ok(serde_json::json!({ "updated": updated, "untilMs": until_ms }))
}

#[tauri::command]
pub async fn shogun_memory_entity_rollup_get(
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let entity_id = payload
        .get("entityId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "entityId is required".to_string())?
        .to_string();
    let entity_label = payload
        .get("entityLabel")
        .and_then(|v| v.as_str())
        .unwrap_or(&entity_id)
        .to_string();
    let lang = payload
        .get("lang")
        .and_then(|v| v.as_str())
        .unwrap_or("en")
        .to_string();
    let regenerate = payload
        .get("regenerate")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if !regenerate {
        if let Some(cached) =
            crate::summarizer_store::get_cached("entity_rollup", &entity_id, &lang)?
        {
            return Ok(serde_json::json!({ "rollup": cached.to_json(), "cached": true }));
        }
    }

    let rollup =
        crate::summarizer::summarize_entity_rollup(&entity_id, &entity_label, &lang).await?;
    crate::summarizer_store::upsert(&rollup)?;
    Ok(serde_json::json!({ "rollup": rollup.to_json(), "cached": false }))
}

#[tauri::command]
pub fn shogun_memory_summary_acknowledge(
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let items = payload
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .ok_or_else(|| "items array required".to_string())?;
    let acknowledged = payload
        .get("acknowledged")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let ack_ms: Option<i64> = if acknowledged {
        Some(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
        )
    } else {
        None
    };

    let pairs_owned: Vec<(String, String)> = items
        .iter()
        .filter_map(|it| {
            let id = it.get("targetId").and_then(|v| v.as_str())?.to_string();
            let kind = it
                .get("targetKind")
                .and_then(|v| v.as_str())
                .unwrap_or("item")
                .to_string();
            Some((kind, id))
        })
        .collect();
    let pairs_ref: Vec<(&str, &str)> = pairs_owned
        .iter()
        .map(|(k, i)| (k.as_str(), i.as_str()))
        .collect();
    let updated = if let Some(ms) = ack_ms {
        crate::summarizer_store::acknowledge_many(&pairs_ref, ms)?
    } else {
        let mut n: u64 = 0;
        for (k, id) in &pairs_ref {
            if crate::summarizer_store::set_acknowledged(k, id, None)? {
                n += 1;
            }
        }
        n
    };
    Ok(serde_json::json!({ "updated": updated, "acknowledged": acknowledged }))
}

#[tauri::command]
pub async fn shogun_memory_rollup_get(
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let week_start_ms = payload
        .get("weekStartMs")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| "weekStartMs is required".to_string())?;
    let lang = payload
        .get("lang")
        .and_then(|v| v.as_str())
        .unwrap_or("en")
        .to_string();
    let regenerate = payload
        .get("regenerate")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let week_id = crate::summarizer::format_week_id(week_start_ms);
    let week_end_ms = week_start_ms + 7 * 24 * 3600 * 1000;

    if !regenerate {
        if let Some(cached) = crate::summarizer_store::get_cached("week_rollup", &week_id, &lang)? {
            let stale_quiet = cached
                .key_points
                .iter()
                .any(|p| p.contains("No activity") || p.contains("アクティビティなし"));
            let indexed =
                crate::memory_store::count_items_in_window(week_start_ms, week_end_ms).unwrap_or(0);
            if !(stale_quiet && indexed > 0) {
                return Ok(serde_json::json!({ "rollup": cached.to_json(), "cached": true }));
            }
        }
    }

    let rollup = crate::summarizer::summarize_week_rollup(week_start_ms, &lang).await?;
    crate::summarizer_store::upsert(&rollup)?;
    Ok(serde_json::json!({ "rollup": rollup.to_json(), "cached": false }))
}

#[tauri::command]
pub async fn shogun_memory_day_rollup_get(
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let day_start_ms = payload
        .get("dayStartMs")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| "dayStartMs is required".to_string())?;
    let lang = payload
        .get("lang")
        .and_then(|v| v.as_str())
        .unwrap_or("en")
        .to_string();
    let regenerate = payload
        .get("regenerate")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let day_id = crate::summarizer::format_week_id(day_start_ms); // YYYY-MM-DD

    if !regenerate {
        if let Some(cached) = crate::summarizer_store::get_cached("day_rollup", &day_id, &lang)? {
            return Ok(serde_json::json!({ "rollup": cached.to_json(), "cached": true }));
        }
    }

    let rollup = crate::summarizer::summarize_day_rollup(day_start_ms, &lang).await?;
    crate::summarizer_store::upsert(&rollup)?;
    Ok(serde_json::json!({ "rollup": rollup.to_json(), "cached": false }))
}

#[tauri::command]
pub async fn shogun_memory_month_rollup_get(
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let month_start_ms = payload
        .get("monthStartMs")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| "monthStartMs is required".to_string())?;
    let lang = payload
        .get("lang")
        .and_then(|v| v.as_str())
        .unwrap_or("en")
        .to_string();
    let regenerate = payload
        .get("regenerate")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let month_id = crate::summarizer::format_month_id(month_start_ms);

    if !regenerate {
        if let Some(cached) = crate::summarizer_store::get_cached("month_rollup", &month_id, &lang)?
        {
            return Ok(serde_json::json!({ "rollup": cached.to_json(), "cached": true }));
        }
    }

    let rollup = crate::summarizer::summarize_month_rollup(month_start_ms, &lang).await?;
    crate::summarizer_store::upsert(&rollup)?;
    Ok(serde_json::json!({ "rollup": rollup.to_json(), "cached": false }))
}

#[tauri::command]
pub async fn shogun_memory_year_rollup_get(
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let year_start_ms = payload
        .get("yearStartMs")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| "yearStartMs is required".to_string())?;
    let lang = payload
        .get("lang")
        .and_then(|v| v.as_str())
        .unwrap_or("en")
        .to_string();
    let regenerate = payload
        .get("regenerate")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let year_id = crate::summarizer::format_year_id(year_start_ms);

    if !regenerate {
        if let Some(cached) = crate::summarizer_store::get_cached("year_rollup", &year_id, &lang)? {
            return Ok(serde_json::json!({ "rollup": cached.to_json(), "cached": true }));
        }
    }

    let rollup = crate::summarizer::summarize_year_rollup(year_start_ms, &lang).await?;
    crate::summarizer_store::upsert(&rollup)?;
    Ok(serde_json::json!({ "rollup": rollup.to_json(), "cached": false }))
}

#[tauri::command]
pub fn shogun_memory_summary_set_priority(
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let target_id = payload
        .get("targetId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "targetId required".to_string())?;
    let target_kind = payload
        .get("targetKind")
        .and_then(|v| v.as_str())
        .unwrap_or("item");
    // priority: either a string ('high'|'medium'|'low') to set, or explicit
    // null / missing key to clear the override.
    let priority_opt: Option<String> = match payload.get("priority") {
        Some(v) if v.is_null() => None,
        Some(v) => Some(
            v.as_str()
                .ok_or_else(|| "priority must be a string or null".to_string())?
                .to_string(),
        ),
        None => None,
    };
    let updated = crate::summarizer_store::set_user_priority(
        target_kind,
        target_id,
        priority_opt.as_deref(),
    )?;
    Ok(serde_json::json!({ "updated": updated, "userPriority": priority_opt }))
}
