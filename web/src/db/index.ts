import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { getRequiredEnv } from '@/lib/web-config';

let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (dbInstance) return dbInstance;

  const connectionString = getRequiredEnv('DATABASE_URL');
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }

  const client = postgres(connectionString, { prepare: false });
  dbInstance = drizzle(client, { schema });
  return dbInstance;
}
