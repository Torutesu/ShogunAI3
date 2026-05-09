# Phase 2.1.4 Follow-ups

Items intentionally deferred from the Cloud Mirror MVP. None block the T5 PR.

## 1. Device-name default = hostname (was IMP-1 from T5 review)

**Current**: every newly onboarded device defaults to "My Mac".
**Spec**: design § 3 wanted `<hostname>` from `os::hostname`.
**Why deferred**: requires a new IPC (`system_hostname`) or extending `mirror_status`'s response shape. Out of T5's purely-frontend scope.
**Next step**: small backend task to add the IPC, then plumb into MirrorOnboardingModal step 3 placeholder.

## 2. Real zxcvbn-style passphrase strength meter (was IMP-2 from T5 review)

**Current**: heuristic length × charset variety scoring. Scores `Password1234!` as Strong (4/4).
**Spec**: U3 calls for client-side zxcvbn-style with min level 3.
**Why deferred**: vendoring zxcvbn-ts adds ~12KB and a build dep; would change the script-load profile.
**Next step**: either vendor zxcvbn-ts under `hifi/vendor/`, or add a deny-list of top-200 common patterns inline.

## 3. Sync-interval dropdown (was IMP-6 from T5 review)

**Current**: fixed 5-minute interval; UI says "configurable in 2.1.5+".
**Spec**: U10 enumerates 30s / 5min / 30min / 6h / manual only.
**Why deferred**: requires a new `mirror_set_sync_interval` IPC + sync-engine config persistence + scheduler reload. Multi-file backend work.
**Next step**: small backend ticket; the UI dropdown is already sketched in the design doc § 5.4.
