import IORedis from "ioredis";
import { RedisMemoryServer } from "redis-memory-server";

export const GetRedisInstanceServer = async () => {
  const memoryServer = new RedisMemoryServer({});

  const [host, port] = await Promise.all([memoryServer.getHost(), memoryServer.getPort()]);

  return new IORedis({
    host,
    port,
  });
};
