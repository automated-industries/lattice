/**
 * Stable lattice-internal Postgres advisory-lock IDs.
 *
 * Postgres advisory locks are namespaced by a single bigint identifier. We
 * pick a fixed constant for the migration runner so concurrent app boots
 * (Railway rolling deploys, two laptops booting at once against a shared
 * dev DB) serialize on the same lock.
 *
 * The constant must be:
 *   - bigint (the SQL function expects int8)
 *   - stable across releases — changing it would let two app instances
 *     running different lattice versions race on different lock IDs
 *   - unlikely to collide with application-level advisory locks the
 *     consumer may use independently
 *
 * The chosen value is the high-bit-padded ASCII codepoints of "LATTICE",
 * trimmed to 63 bits so it always fits a positive bigint regardless of
 * how the driver materializes the wire format. Hex: 0x4C41545449434500.
 */
export const LATTICE_MIGRATION_LOCK_ID = 0x4c41545449434500n;
