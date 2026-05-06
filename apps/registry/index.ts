import fastify from 'fastify';
import { AssetManifest } from '@a2a/types';

const server = fastify({ logger: true });

// Mock Database (Replace with pg + pgvector in Phase 1.2)
const registry: AssetManifest[] = [];

server.post<{ Body: AssetManifest }>('/registry/announce', async (request, reply) => {
  const asset = request.body;
  registry.push(asset);
  return { status: 'registered', asset_id: asset.asset_id };
});

server.get('/registry/search', async (request, reply) => {
  return registry;
});

const start = async () => {
  try {
    await server.listen({ port: 3000 });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
