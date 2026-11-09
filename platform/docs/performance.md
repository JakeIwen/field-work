# State refresh and task history

Global state projects lightweight task summaries rather than posting bodies, raw protocol logs and hydrated transcripts. Detail views load bounded history on demand. Stored tasks, exports and backups retain complete evidence.

Store-derived parts are deep-frozen and cached by per-kind write versions. Rollbacks and external commits invalidate them. JSON fragments reuse those parts with output equivalent to ordinary serialization. Filesystem-, clock- and runtime-dependent projections remain request-scoped because database versions cannot validate them.

State encoding negotiates Brotli, gzip or identity. Native compression concurrency is bounded, and only byte-identical in-flight encodings are shared. Whole snapshots are not cached as if runtime inputs never changed.

The client shares one event stream across tabs through a Web Lock and BroadcastChannel. Reconnect refreshes state with bounded backoff. Hidden tabs mark themselves stale and refresh when visible. Visible event refetches are spaced to prevent invalidation storms; mutation and explicit navigation reads remain immediate.

Automatic exports track dirty record kinds and reuse validated fragments before atomic assembly. Full task logs are reattached one task at a time. Failures force safe serialization/retry behavior; SQLite remains authoritative and a crash can leave the secondary snapshot behind.

Synthetic latency and memory scripts are opt-in measurements. No private record counts, production timings or historical measurement reports are included, and this snapshot makes no live performance claim.
