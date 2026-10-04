import 'server-only';
import { Pool, type PoolClient } from 'pg';
import { env } from '@/lib/env';
import { connectionConfig } from './connection';
import type { Db, Row } from './types';

export type { Db, Row } from './types';

const globalForDb = globalThis as unknown as { __ttmPool?: Pool };

function pool(): Pool {
  if (!globalForDb.__ttmPool) {
    globalForDb.__ttmPool = new Pool({
      ...connectionConfig(env().DATABASE_URL),
      // Serverless: keep the per-instance pool small and use the Supabase pooler URL.
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return globalForDb.__ttmPool;
}

function clientDb(client: PoolClient): Db {
  const self: Db = {
    async query<T = Row>(text: string, params: unknown[] = []) {
      const res = await client.query(text, params);
      return res.rows as T[];
    },
    tx: (fn) => fn(self),
  };
  return self;
}

export const db: Db = {
  async query<T = Row>(text: string, params: unknown[] = []) {
    const res = await pool().query(text, params);
    return res.rows as T[];
  },
  async tx(fn) {
    const client = await pool().connect();
    try {
      await client.query('begin');
      const out = await fn(clientDb(client));
      await client.query('commit');
      return out;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },
};
