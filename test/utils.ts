import IORedis from "ioredis";
import { RedisMemoryServer } from "redis-memory-server";
import { afterAll } from "vitest";

const servers: Array<RedisMemoryServer> = [];

export const GetRedisInstanceServer = async () => {
  const memoryServer = new RedisMemoryServer({});

  servers.push(memoryServer);

  const [host, port] = await Promise.all([memoryServer.getHost(), memoryServer.getPort()]);

  return new IORedis({
    host,
    port,
  });
};

afterAll(async () => {
  for (const server of servers) {
    await server.stop();
  }
});
