import IORedis from "ioredis";
import { RedisMemoryServer } from "redis-memory-server";
import { afterAll } from "vitest";
import type { LoggedEvents } from "../src";

export const logEverything: Required<LoggedEvents> = {
  CONCURRENT_CACHED_CALL_HIT: true,
  INVALIDATE_KEY_SCAN: true,
  INVALIDATED_KEYS: true,
  REDIS_GET: true,
  REDIS_GET_TIMED_OUT: true,
  REDIS_SET: true,
  REDLOCK_ACQUIRED: true,
  REDLOCK_GET_AFTER_ACQUIRE: true,
  REDLOCK_RELEASED: true,
};

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
