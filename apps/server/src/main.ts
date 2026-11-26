import { buildServer } from './server.js';

/** 入口：PORT（默认 8787）、HOST（默认 0.0.0.0） */
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';

const app = await buildServer({ logger: true });

const shutdown = (): void => {
  app.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port, host });
