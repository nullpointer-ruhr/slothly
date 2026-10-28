// Start: Konfiguration, Migrationen, Server; sauberes Beenden bei SIGTERM.
import { loadConfig } from './config.ts';
import { createPool, migrate } from './db.ts';
import { buildApp } from './server.ts';

const cfg = loadConfig();
const db = createPool(cfg.databaseUrl);
await migrate(db, m => console.log(m));
const app = await buildApp(cfg, db);
await app.listen({ port: cfg.port, host: cfg.host });

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, async () => {
    app.log.info(`${sig}: beende`);
    await app.close();
    await db.end();
    process.exit(0);
  });
}
