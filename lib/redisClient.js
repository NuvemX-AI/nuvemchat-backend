import Redis from 'ioredis';

let redis;

if (process.env.KV_URL) { // Vercel KV (Upstash) usa KV_URL
  console.log('[Redis Client] Conectando ao Vercel KV (Upstash)...');
  redis = new Redis(process.env.KV_URL, { 
    tls: {}, // Necessário para conexões seguras com Upstash/Vercel KV
    maxRetriesPerRequest: 3
  });
} else if (process.env.REDIS_URL) {
  console.log('[Redis Client] Conectando usando REDIS_URL...');
  redis = new Redis(process.env.REDIS_URL);
} else {
  const redisHost = process.env.REDIS_HOST || '127.0.0.1';
  const redisPort = process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379;
  const redisPassword = process.env.REDIS_PASSWORD || undefined;
  console.log(`[Redis Client] Conectando a ${redisHost}:${redisPort}...`);
  redis = new Redis({
    host: redisHost,
    port: redisPort,
    password: redisPassword,
    maxRetriesPerRequest: 3
  });
}

redis.on('connect', () => {
  console.log('[Redis Client] Conectado com sucesso!');
});

redis.on('error', (err) => {
  console.error('[Redis Client] Erro de conexão:', err);
});

export { redis }; 