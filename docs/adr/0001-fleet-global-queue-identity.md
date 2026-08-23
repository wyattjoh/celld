# Use fleet-global literal queue cell scopes

Queue names resolve to the literal reserved scope `.queue:<name>` rather than a script-scoped hashed Durable Object ID. This preserves Cloudflare's queue identity across producer and consumer bindings, leaves cross-script resolution open for a later slice, and keeps a future shard suffix (`.queue:<name>:<shard>`) addressable by the reserved `.queue` class; strict Cloudflare queue-name validation prevents the name from colliding with that syntax.
