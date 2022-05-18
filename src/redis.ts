import type { ExecutionResult } from "graphql";
import type { Redis } from "ioredis";
import type RedLock from "redlock";
import type { Lock, Settings } from "redlock";
import type { Cache } from "./plugin";

export type BuildRedisEntityId = (typename: string, id: number | string) => string;
export type BuildRedisOperationResultCacheKey = (responseId: string) => string;

export type RedisCacheParameter = {
  /**
   * Redis instance
   * @see Redis.Redis https://github.com/luin/ioredis
   */
  redis: Redis;

  /**
   * Enable and customize redlock
   */
  redlock?: {
    client: RedLock;
    duration: number;
    settings?: Partial<Settings>;
  } | null;
  /**
   * Customize how the cache entity id is built.
   * By default the typename is concatenated with the id e.g. `User:1`
   */
  buildRedisEntityId?: BuildRedisEntityId;
  /**
   * Customize how the cache key that stores the operations associated with the response is built.
   * By default `operations` is concatenated with the responseId e.g. `operations:arZm3tCKgGmpu+a5slrpSH9vjSQ=`
   */
  buildRedisOperationResultCacheKey?: BuildRedisOperationResultCacheKey;
};

function gracefullyFail(err: unknown) {
  console.error(err);
  return null;
}

export const createRedisCache = (params: RedisCacheParameter): Cache => {
  const store = params.redis;
  const redLock = params.redlock?.client;
  const lockSettings = params.redlock?.settings;
  const lockDuration = params.redlock?.duration ?? 5000;

  const buildRedisEntityId = params?.buildRedisEntityId ?? defaultBuildRedisEntityId;
  const buildRedisOperationResultCacheKey =
    params?.buildRedisOperationResultCacheKey ?? defaultBuildRedisOperationResultCacheKey;

  async function buildEntityInvalidationsKeys(entity: string): Promise<string[]> {
    const keysToInvalidate: string[] = [entity];

    // find the responseIds for the entity
    const responseIds = await store.smembers(entity).catch(gracefullyFail);

    // and add each response to be invalidated since they contained the entity data
    for (const responseId of responseIds || []) {
      keysToInvalidate.push(responseId);
      keysToInvalidate.push(buildRedisOperationResultCacheKey(responseId));
    }

    // if invalidating an entity like Comment, then also invalidate Comment:1, Comment:2, etc
    if (!entity.includes(":")) {
      const entityKeys = await store.keys(`${entity}:*`).catch(gracefullyFail);
      await Promise.all(
        (entityKeys || []).map(async (entityKey) => {
          // and invalidate any responses in each of those entity keys
          const entityResponseIds = await store.smembers(entityKey).catch(gracefullyFail);
          // if invalidating an entity check for associated operations containing that entity
          // and invalidate each response since they contained the entity data
          for (const responseId of entityResponseIds || []) {
            keysToInvalidate.push(responseId);
            keysToInvalidate.push(buildRedisOperationResultCacheKey(responseId));
          }

          // then the entityKeys like Comment:1, Comment:2 etc to be invalidated
          keysToInvalidate.push(entityKey);
        })
      );
    }

    return keysToInvalidate;
  }

  const responseIdLocks: Record<string, Lock | null> = {};
  const ConcurrentLoadingCache: Record<string, Promise<unknown> | null> = {};

  function ConcurrentCachedCall<T>(key: string, cb: () => Promise<T>) {
    const concurrentLoadingValueCache = ConcurrentLoadingCache[key];

    if (concurrentLoadingValueCache) {
      return concurrentLoadingValueCache as Promise<Awaited<T>>;
    }

    return (ConcurrentLoadingCache[key] = cb()).finally(() => {
      ConcurrentLoadingCache[key] = null;
    }) as Promise<Awaited<T>>;
  }

  function getFromRedis<T>(responseId: string) {
    return ConcurrentCachedCall<[T | null, boolean]>(responseId, async () => {
      let ok = true;
      const result = await store.get(responseId).catch((err) => {
        ok = false;
        return gracefullyFail(err);
      });

      if (result != null) return [JSON.parse(result), ok];

      return [null, ok];
    });
  }

  return {
    onSkipCache(responseId) {
      const lock = responseIdLocks[responseId];

      if (lock) {
        lock.release().catch(console.error);
        responseIdLocks[responseId] = null;
      }
    },
    async set(responseId, result, collectedEntities, ttl) {
      try {
        const pipeline = store.pipeline();

        if (ttl === Infinity) {
          pipeline.set(responseId, JSON.stringify(result));
        } else {
          // set the ttl in milliseconds
          pipeline.set(responseId, JSON.stringify(result), "PX", ttl);
        }

        const responseKey = buildRedisOperationResultCacheKey(responseId);

        for (const { typename, id } of collectedEntities) {
          // Adds a key for the typename => response
          pipeline.sadd(typename, responseId);
          // Adds a key for the operation => typename
          pipeline.sadd(responseKey, typename);

          if (id) {
            const entityId = buildRedisEntityId(typename, id);
            // Adds a key for the typename:id => response
            pipeline.sadd(entityId, responseId);
            // Adds a key for the operation => typename:id
            pipeline.sadd(responseKey, entityId);
          }
        }

        await pipeline.exec().catch(gracefullyFail);
      } catch (err) {
        console.error(err);
      }

      const lock = responseIdLocks[responseId];

      if (!lock) return;

      lock.release().catch(console.error);
      responseIdLocks[responseId] = null;
    },
    async get(responseId) {
      const [firstTry, redisOk] = await getFromRedis<ExecutionResult>(responseId);

      if (!redisOk) return null;

      if (firstTry) return firstTry;

      const lock = await redLock?.acquire(["lock:" + responseId], lockDuration, lockSettings).then(
        (lock) => {
          if (lock.attempts.length === 1) {
            return (responseIdLocks[responseId] = lock);
          }

          return lock;
        },
        (err) => {
          console.error(err);
          return null;
        }
      );

      // Any lock that took more than 1 attempt should be released right away for the other readers
      if (lock && lock.attempts.length > 1) lock.release().catch(console.error);
      // If the lock was first attempt, skip the second get try, and go right to execute
      else if (lock?.attempts.length === 1) return null;

      return getFromRedis<ExecutionResult>(responseId).then((v) => v[0]);
    },
    async invalidate(entitiesToRemove) {
      const invalidationKeys: string[] = [];

      await Promise.all(
        Array.from(entitiesToRemove).map(async ({ typename, id }) => {
          invalidationKeys.push(
            ...(await buildEntityInvalidationsKeys(
              id != null ? buildRedisEntityId(typename, id) : typename
            ))
          );
        })
      );

      if (invalidationKeys.length > 0) {
        await store.del(invalidationKeys).catch(gracefullyFail);
      }
    },
  };
};

export const defaultBuildRedisEntityId: BuildRedisEntityId = (typename, id) => `${typename}:${id}`;
export const defaultBuildRedisOperationResultCacheKey: BuildRedisOperationResultCacheKey = (
  responseId
) => `operations:${responseId}`;
