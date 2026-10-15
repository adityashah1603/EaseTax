import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { loadBaseline } from './baseline/baseline.ts';
import { EventStore } from './events/store.ts';
import { Workpaper } from './workpaper.ts';
import { registerRoutes } from './api/routes.ts';
import { registerStream } from './realtime/stream.ts';
import { registerViewRoutes } from './api/views.ts';
import { registerFilingRoutes } from './api/filing.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const packetPath = process.env.PACKET_PATH ?? resolve(root, 'okafor_lindqvist_2025_packet.json');
const dbPath = process.env.DB_PATH ?? resolve(root, 'var/easetax.db');
const port = Number(process.env.PORT ?? 8787);

const baseline = loadBaseline(packetPath);
const store = new EventStore(dbPath);
const knownHash = store.getMeta('packet_hash');
if (knownHash && knownHash !== baseline.hash) {
  console.warn(`Packet hash changed since this database was created (${knownHash.slice(0, 12)} → ${baseline.hash.slice(0, 12)}).`);
}
store.setMeta('packet_hash', baseline.hash);

const wp = new Workpaper(baseline, store);
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' } });
await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });
registerRoutes(app, wp);
registerStream(app, wp);
registerViewRoutes(app, wp);
registerFilingRoutes(app, wp);

const webDist = resolve(root, 'web/dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api') ? reply.status(404).send({ ok: false, error: 'not found' }) : reply.sendFile('index.html')));
}

await app.listen({ port, host: '0.0.0.0' });
console.log(`EaseTax workpaper on http://localhost:${port}  (packet ${baseline.hash.slice(0, 12)}, ${store.lastSeq()} events)`);
