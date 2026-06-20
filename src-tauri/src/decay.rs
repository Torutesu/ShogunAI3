//! Decay model for the KIOKU graph layer (Phase 2 Stage 1).
//!
//! Pure functions and constants. No DB access, no IO. The grid-search
//! framework lives here so weight retuning in Stage 3 can use the existing
//! `kioku_eval` scoring utilities without pulling in retrieval.
//!
//! Spec: `docs/memory-architecture/target-design.md` §5.

// Stage 1 ships only pure helpers + frozen consts; the live wiring (decay
// recompute on access, daily centrality batch, threshold filter in retrieval)
// arrives in Stage 3. Suppress the produce-only-for-now lints.
#![allow(dead_code)]

// ── Constants (initial values, frozen for Stage 1) ─────────────────────────
//
// Per `migration-plan.md` §Stage 1.3 the initial weights are kept and re-tuned
// once retrieval lands in Stage 3. The grid search framework below produces
// the candidate sweep but live eval only runs against fixtures with retrieval
// in place; for Stage 1 these are the operative constants.

/// recency weight
pub const DECAY_W1: f32 = 0.4;
/// access-boost weight
pub const DECAY_W2: f32 = 0.2;
/// centrality weight
pub const DECAY_W3: f32 = 0.3;
/// confidence weight
pub const DECAY_W4: f32 = 0.1;

/// Wide-net cutoff: nodes with `decay_score < DECAY_THRESHOLD` do not seed
/// vector entry retrieval (graph traversal can still reach them).
pub const DECAY_THRESHOLD: f64 = 0.05;

/// Recency half-life characteristic time: 7 days expressed in milliseconds.
pub const DECAY_RECENCY_TAU_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// Access-count saturation point. log10(1 + 100) ≈ 2.0 anchors normalization.
pub const DECAY_ACCESS_COUNT_CAP: f64 = 100.0;

// ── Weight grid enumeration (Stage 1.3 framework, runs against fixtures) ───

/// A candidate weight set for the decay model. `is_valid` enforces the
/// "non-negative components summing to 1.0" constraint within `tol`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WeightSet {
    pub w1: f32,
    pub w2: f32,
    pub w3: f32,
    pub w4: f32,
}

impl WeightSet {
    pub fn is_valid(&self, tol: f32) -> bool {
        let nonneg = self.w1 >= 0.0 && self.w2 >= 0.0 && self.w3 >= 0.0 && self.w4 >= 0.0;
        if !nonneg {
            return false;
        }
        ((self.w1 + self.w2 + self.w3 + self.w4) - 1.0).abs() <= tol
    }
}

/// Enumerate all `WeightSet` combinations on a `step` grid in `[0, 1]` whose
/// components sum to 1.0 within `step / 4`. Step must satisfy `0 < step ≤ 1`
/// and divide 1.0 cleanly (e.g. 0.1, 0.2, 0.25, 0.5, 1.0).
pub fn enumerate_weight_grid(step: f32) -> Vec<WeightSet> {
    if !(step.is_finite() && step > 0.0 && step <= 1.0) {
        return Vec::new();
    }
    // Work in integer "units" of step to avoid floating-point drift in the loop:
    // n = round(1.0 / step). step must divide 1.0 cleanly.
    let n_f = 1.0 / step;
    let n = n_f.round() as i32;
    if n <= 0 || (n_f - n as f32).abs() > 1e-3 {
        return Vec::new();
    }
    let mut out = Vec::new();
    for i in 0..=n {
        for j in 0..=(n - i) {
            for k in 0..=(n - i - j) {
                let l = n - i - j - k;
                // Reconstruct components from integer units; quantize to `step`.
                out.push(WeightSet {
                    w1: (i as f32) * step,
                    w2: (j as f32) * step,
                    w3: (k as f32) * step,
                    w4: (l as f32) * step,
                });
            }
        }
    }
    out
}

// ── Pure helpers (TDD red phase) ────────────────────────────────────────────

/// Clamp a real number into `[0, 1]`. NaN maps to 0.0 to keep the score finite.
pub fn clamp01(x: f64) -> f64 {
    if x.is_nan() {
        0.0
    } else if x < 0.0 {
        0.0
    } else if x > 1.0 {
        1.0
    } else {
        x
    }
}

/// Recency factor: `exp(-Δt / τ)` clipped to `[0, 1]`. Negative `delta_ms`
/// (clock skew) is treated as 0 (= score 1.0). Returns 0 when `tau_ms <= 0`.
pub fn recency(delta_ms: i64, tau_ms: i64) -> f64 {
    if tau_ms <= 0 {
        return 0.0;
    }
    let dt = delta_ms.max(0) as f64;
    let tau = tau_ms as f64;
    clamp01((-dt / tau).exp())
}

/// Access-count boost normalized to `[0, 1]`. Uses `log10(1 + count)`
/// divided by `log10(1 + cap)` so a node hit `cap` times scores 1.0.
pub fn access_boost(count: i64, cap: f64) -> f64 {
    if count <= 0 || cap <= 0.0 {
        return 0.0;
    }
    let denom = (1.0 + cap).log10();
    if denom <= 0.0 {
        return 0.0;
    }
    let raw = ((1.0 + count as f64).log10()) / denom;
    clamp01(raw)
}

/// Confidence term: `Some(c)` clamped to `[0, 1]`, `None` ⇒ 0.5 default.
pub fn confidence_term(value: Option<f64>) -> f64 {
    match value {
        None => 0.5,
        Some(v) if v.is_nan() => 0.5,
        Some(v) => clamp01(v),
    }
}

/// Composite decay score:
///
/// ```text
/// w1 * recency_term + w2 * access_term + w3 * centrality_term + w4 * confidence_term
/// ```
///
/// Each input must already be in `[0, 1]`; weights are not required to sum to
/// 1.0 here (the grid enumeration enforces that constraint separately) so
/// callers can experiment with rebalanced sums.
pub fn decay_score(
    recency_term: f64,
    access_term: f64,
    centrality_term: f64,
    confidence_term: f64,
    w1: f64,
    w2: f64,
    w3: f64,
    w4: f64,
) -> f64 {
    w1 * recency_term + w2 * access_term + w3 * centrality_term + w4 * confidence_term
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── clamp01 ───────────────────────────────────────────────────────────────
    #[test]
    fn clamp01_in_range_passes_through() {
        assert!((clamp01(0.0) - 0.0).abs() < 1e-12);
        assert!((clamp01(0.5) - 0.5).abs() < 1e-12);
        assert!((clamp01(1.0) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn clamp01_below_zero_floors_to_zero() {
        assert_eq!(clamp01(-0.1), 0.0);
        assert_eq!(clamp01(-1e6), 0.0);
    }

    #[test]
    fn clamp01_above_one_caps_to_one() {
        assert_eq!(clamp01(1.5), 1.0);
        assert_eq!(clamp01(1e6), 1.0);
    }

    #[test]
    fn clamp01_nan_maps_to_zero() {
        assert_eq!(clamp01(f64::NAN), 0.0);
    }

    // ── recency ───────────────────────────────────────────────────────────────
    #[test]
    fn recency_zero_delta_returns_one() {
        assert!((recency(0, DECAY_RECENCY_TAU_MS) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn recency_negative_delta_treated_as_zero() {
        // Clock skew: last_accessed_at slightly in the future.
        assert!((recency(-1000, DECAY_RECENCY_TAU_MS) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn recency_one_tau_decays_to_e_inverse() {
        let tau = DECAY_RECENCY_TAU_MS;
        let r = recency(tau, tau);
        let expected = (-1.0_f64).exp();
        assert!(
            (r - expected).abs() < 1e-9,
            "got {}, expected {}",
            r,
            expected
        );
    }

    #[test]
    fn recency_far_future_approaches_zero() {
        let tau = DECAY_RECENCY_TAU_MS;
        let r = recency(tau * 50, tau);
        assert!(r < 1e-12, "got {}", r);
    }

    #[test]
    fn recency_invalid_tau_returns_zero() {
        assert_eq!(recency(1_000, 0), 0.0);
        assert_eq!(recency(1_000, -1), 0.0);
    }

    // ── access_boost ──────────────────────────────────────────────────────────
    #[test]
    fn access_boost_zero_returns_zero() {
        assert!((access_boost(0, DECAY_ACCESS_COUNT_CAP) - 0.0).abs() < 1e-12);
    }

    #[test]
    fn access_boost_at_cap_returns_one() {
        let v = access_boost(100, DECAY_ACCESS_COUNT_CAP);
        assert!((v - 1.0).abs() < 1e-9, "got {}", v);
    }

    #[test]
    fn access_boost_above_cap_clipped_to_one() {
        let v = access_boost(10_000, DECAY_ACCESS_COUNT_CAP);
        assert!((v - 1.0).abs() < 1e-9, "got {}", v);
    }

    #[test]
    fn access_boost_grows_monotonically() {
        let a = access_boost(1, DECAY_ACCESS_COUNT_CAP);
        let b = access_boost(5, DECAY_ACCESS_COUNT_CAP);
        let c = access_boost(50, DECAY_ACCESS_COUNT_CAP);
        assert!(0.0 < a && a < b && b < c && c < 1.0, "{a} {b} {c}");
    }

    #[test]
    fn access_boost_handles_negative_count_as_zero() {
        // Defensive: counts shouldn't go negative, but if they do don't blow up.
        assert_eq!(access_boost(-3, DECAY_ACCESS_COUNT_CAP), 0.0);
    }

    // ── confidence_term ───────────────────────────────────────────────────────
    #[test]
    fn confidence_term_none_returns_default_half() {
        assert!((confidence_term(None) - 0.5).abs() < 1e-12);
    }

    #[test]
    fn confidence_term_some_in_range_passes() {
        assert!((confidence_term(Some(0.8)) - 0.8).abs() < 1e-12);
        assert!((confidence_term(Some(0.0)) - 0.0).abs() < 1e-12);
        assert!((confidence_term(Some(1.0)) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn confidence_term_some_out_of_range_clamps() {
        assert_eq!(confidence_term(Some(-0.5)), 0.0);
        assert_eq!(confidence_term(Some(1.5)), 1.0);
    }

    #[test]
    fn confidence_term_some_nan_falls_back_to_default() {
        // NaN extraction confidence is treated like the absent case.
        assert!((confidence_term(Some(f64::NAN)) - 0.5).abs() < 1e-12);
    }

    // ── decay_score ───────────────────────────────────────────────────────────
    #[test]
    fn decay_score_pure_recency() {
        // w1 = 1.0, others 0.0 → score = recency only.
        let s = decay_score(0.7, 0.5, 0.4, 0.9, 1.0, 0.0, 0.0, 0.0);
        assert!((s - 0.7).abs() < 1e-12);
    }

    #[test]
    fn decay_score_combination_matches_formula() {
        // w1*r + w2*a + w3*c + w4*conf with default weights.
        let r = 0.6;
        let a = 0.3;
        let c = 0.5;
        let conf = 0.8;
        let expected = 0.4 * r + 0.2 * a + 0.3 * c + 0.1 * conf;
        let s = decay_score(r, a, c, conf, 0.4, 0.2, 0.3, 0.1);
        assert!((s - expected).abs() < 1e-12);
    }

    #[test]
    fn decay_score_threshold_relative_check() {
        // A node with poor recency, no access, low centrality, default confidence
        // should score below DECAY_THRESHOLD with the official initial weights.
        let s = decay_score(
            0.01, // recency: ~7×τ old
            0.0,  // access_boost: never hit
            0.05, // centrality: nearly orphan
            0.0,  // confidence: lowest
            DECAY_W1 as f64,
            DECAY_W2 as f64,
            DECAY_W3 as f64,
            DECAY_W4 as f64,
        );
        assert!(
            s < DECAY_THRESHOLD,
            "expected weak node to fall below threshold, got {} (threshold {})",
            s,
            DECAY_THRESHOLD,
        );
    }

    #[test]
    fn decay_score_strong_node_above_threshold() {
        // Recently-accessed, frequently used, central, high confidence.
        let s = decay_score(
            1.0,
            0.8,
            0.9,
            0.95,
            DECAY_W1 as f64,
            DECAY_W2 as f64,
            DECAY_W3 as f64,
            DECAY_W4 as f64,
        );
        assert!(s > 0.85, "strong node should score high, got {}", s);
    }

    // ── WeightSet ─────────────────────────────────────────────────────────────
    #[test]
    fn weight_set_is_valid_sums_to_one() {
        let w = WeightSet {
            w1: 0.4,
            w2: 0.2,
            w3: 0.3,
            w4: 0.1,
        };
        assert!(w.is_valid(1e-6));
    }

    #[test]
    fn weight_set_invalid_when_sum_off() {
        let w = WeightSet {
            w1: 0.5,
            w2: 0.5,
            w3: 0.5,
            w4: 0.0,
        };
        assert!(!w.is_valid(1e-6));
    }

    #[test]
    fn weight_set_invalid_when_negative_component() {
        let w = WeightSet {
            w1: 1.5,
            w2: -0.5,
            w3: 0.0,
            w4: 0.0,
        };
        assert!(!w.is_valid(1e-6));
    }

    #[test]
    fn weight_set_tolerance_allows_floating_drift() {
        // Grid values 0.1+0.2+0.3+0.4 may drift slightly under f32 add.
        let w = WeightSet {
            w1: 0.1,
            w2: 0.2,
            w3: 0.3,
            w4: 0.4,
        };
        assert!(w.is_valid(1e-3));
    }

    // ── enumerate_weight_grid ─────────────────────────────────────────────────
    #[test]
    fn grid_step_one_yields_four_corner_sets() {
        // Only (1,0,0,0) / (0,1,0,0) / (0,0,1,0) / (0,0,0,1) sum to 1 with step=1.
        let grid = enumerate_weight_grid(1.0);
        assert_eq!(grid.len(), 4);
        for w in &grid {
            assert!(w.is_valid(1e-3), "{:?} should be valid", w);
        }
    }

    #[test]
    fn grid_step_half_includes_two_third_combos() {
        // step = 0.5 → values ∈ {0.0, 0.5, 1.0}. Combos summing to 1.0:
        //   permutations of (1,0,0,0)         = 4
        //   permutations of (0.5,0.5,0,0)     = C(4,2) = 6
        // Total = 10.
        let grid = enumerate_weight_grid(0.5);
        assert_eq!(grid.len(), 10, "got {:?}", grid.len());
        for w in &grid {
            assert!(w.is_valid(1e-3));
        }
    }

    #[test]
    fn grid_step_tenth_contains_initial_weights() {
        // The repo's frozen initial choice (0.4, 0.2, 0.3, 0.1) must survive a
        // 0.1-step grid sweep so we can compare it against neighbors.
        let grid = enumerate_weight_grid(0.1);
        let initial = WeightSet {
            w1: DECAY_W1,
            w2: DECAY_W2,
            w3: DECAY_W3,
            w4: DECAY_W4,
        };
        assert!(
            grid.iter().any(|w| (w.w1 - initial.w1).abs() < 1e-4
                && (w.w2 - initial.w2).abs() < 1e-4
                && (w.w3 - initial.w3).abs() < 1e-4
                && (w.w4 - initial.w4).abs() < 1e-4),
            "initial weights {:?} not in step-0.1 grid",
            initial,
        );
    }

    #[test]
    fn grid_step_tenth_has_only_valid_sets() {
        let grid = enumerate_weight_grid(0.1);
        for w in &grid {
            assert!(w.is_valid(1e-3), "{:?} invalid", w);
        }
        // Total combinations summing to 1.0 with 4 components in step 0.1 is
        // C(13, 3) = 286 (stars and bars).
        assert_eq!(grid.len(), 286, "got {}", grid.len());
    }

    #[test]
    fn grid_invalid_step_returns_empty() {
        assert!(enumerate_weight_grid(0.0).is_empty());
        assert!(enumerate_weight_grid(-0.1).is_empty());
        assert!(enumerate_weight_grid(1.5).is_empty());
    }

    // ── const sanity ─────────────────────────────────────────────────────────
    #[test]
    fn weights_sum_to_one() {
        let total = (DECAY_W1 + DECAY_W2 + DECAY_W3 + DECAY_W4) as f64;
        assert!((total - 1.0).abs() < 1e-6, "got {}", total);
    }

    #[test]
    fn recency_tau_is_seven_days() {
        assert_eq!(DECAY_RECENCY_TAU_MS, 7 * 24 * 60 * 60 * 1000);
    }
}
