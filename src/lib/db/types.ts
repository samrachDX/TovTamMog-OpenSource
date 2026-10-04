export type Row = Record<string, unknown>;

/**
 * Minimal database interface. Production uses node-postgres against Supabase;
 * tests use PGlite. Both speak the same SQL with $1-style parameters.
 */
export interface Db {
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
  /** Runs fn in a transaction. Nested calls join the outer transaction. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}
