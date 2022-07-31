import type { ExecutionResult } from "graphql";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type RedLock from "redlock";
import type { Lock, Settings } from "redlock";
import type { Cache } from "./plugin";

import { setTimeout } from "timers/promises";

export type BuildRedisEntityId = (typename: string, id: number | string) => string;
export type BuildRedisOperationResultCacheKey = (responseId: string) => string;

export const RedisCacheEvents = {
  REDIS_GET: "REDIS_GET",
  REDIS_GET_TIMED_OUT: "REDIS_GET_TIMED_OUT",
  REDIS_SET: "REDIS_SET",
  INVALIDATE_KEY_SCAN: "INVALIDATE_KEY_SCAN",
  INVALIDATED_KEYS: "INVALIDATED_KEYS",
  CONCURRENT_CACHED_CALL_HIT: "CONCURRENT_CACHED_CALL_HIT",
} as const;

export type RedisCacheEvents = typeof RedisCacheEvents[keyof typeof RedisCacheEvents];

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
    /**
     * @default 5000 ms
     */
    duration?: number;
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
  /**
   * Debug TTL of existing cache results
   *
   * @default false
   */
  debugTtl?: boolean;

  /**
   * Pino logger instance
   */
  logger: Logger;

  /**
   * Enable and/or customize events logs
   *
   * @default
   *  { "REDIS_GET_TIMED_OUT": true }
   */
  logEvents?: Partial<Record<RedisCacheEvents, string | boolean | null>>;

  redisGetTimeout?: number;
};

const RedisGetTimedOut = Symbol.for("RedisGetTimedOut");

export const createRedisCache = (params: RedisCacheParameter): Cache => {
  const redLock = params.redlock?.client;
  const lockSettings = params.redlock?.settings;
  const lockDuration = params.redlock?.duration ?? 5000;
  const lockRetryDelay = params.redlock?.settings?.retryDelay ?? 250;
  const lockRetryCount = lockSettings?.retryCount ?? (lockDuration / lockRetryDelay) * 2;

  const { logEvents, logger, debugTtl = false, redis: store, redisGetTimeout } = params;

  function gracefullyFail(err: unknown) {
    logger.error(err);
    return null;
  }

  const buildRedisEntityId = params?.buildRedisEntityId ?? defaultBuildRedisEntityId;
  const buildRedisOperationResultCacheKey =
    params?.buildRedisOperationResultCacheKey ?? defaultBuildRedisOperationResultCacheKey;

  function logMessage(
    code: RedisCacheEvents,
    paramsObject: Record<string, string | number | boolean | undefined>
  ) {
    let codeValue = logEvents?.[code];

    if (!codeValue) return;

    if (typeof codeValue !== "string") codeValue = RedisCacheEvents[code];

    let params = "";

    for (const key in paramsObject) {
      const value = paramsObject[key];

      if (value === undefined) continue;

      params += " " + key + "=" + paramsObject[key];
    }

    logger.info(`[${codeValue}]${params}`);
  }

  function getTracing() {
    const start = performance.now();

    return () => `${(performance.now() - start).toFixed()}ms`;
  }

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
      const tracing = logEvents?.INVALIDATE_KEY_SCAN ? getTracing() : null;

      const key = `${entity}:*`;
      const entityKeys = await store.keys(key).catch(gracefullyFail);

      if (tracing && entityKeys) {
        logMessage("INVALIDATE_KEY_SCAN", {
          key,
          entityKeys: entityKeys.join(","),
          time: tracing(),
        });
      }
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
      if (logEvents?.CONCURRENT_CACHED_CALL_HIT) {
        logMessage("CONCURRENT_CACHED_CALL_HIT", {
          key,
        });
      }
      return concurrentLoadingValueCache as Promise<Awaited<T>>;
    }

    return (ConcurrentLoadingCache[key] = cb()).finally(() => {
      ConcurrentLoadingCache[key] = null;
    }) as Promise<Awaited<T>>;
  }

  function getFromRedis<T>(responseId: string) {
    return ConcurrentCachedCall<[T | null, { ok: boolean; ttl?: number }]>(responseId, async () => {
      let ok = true;

      let timedOut = false;

      const tracing =
        logEvents?.REDIS_GET || (logEvents?.REDIS_GET_TIMED_OUT ?? true) ? getTracing() : null;

      if (debugTtl) {
        const redisGetPromise = store
          .pipeline()
          .get(responseId)
          .ttl(responseId)
          .exec()
          .then((value) => {
            if (tracing) {
              const ttl = value?.[1]?.[1];
              logMessage("REDIS_GET", {
                key: responseId,
                cache: value?.[0]?.[1] == null ? "MISS" : "HIT",
                timedOut,
                remainingTtl: typeof ttl === "number" ? ttl : "null",
                time: tracing(),
              });
            }
            return value;
          })
          .catch(gracefullyFail);

        const resultWithTtl = await (redisGetTimeout != null
          ? Promise.race([redisGetPromise, setTimeout(redisGetTimeout, RedisGetTimedOut)])
          : redisGetPromise);

        if (resultWithTtl === RedisGetTimedOut) {
          timedOut = true;
          if (logEvents?.REDIS_GET_TIMED_OUT ?? true) {
            logMessage("REDIS_GET_TIMED_OUT", {
              key: responseId,
              timeout: redisGetTimeout,
              time: tracing?.(),
            });
          }
          return [null, { ok: false, ttl: undefined }];
        }

        if (!resultWithTtl || !resultWithTtl[0] || !resultWithTtl[1]) {
          return [null, { ok: false, ttl: undefined }];
        }

        const [[resultError, result], [ttlError, ttlRedis]] = resultWithTtl;

        const ttl = typeof ttlRedis === "number" ? ttlRedis : undefined;

        if (resultError) {
          gracefullyFail(resultError);
          ok = false;
        }

        if (ttlError) {
          gracefullyFail(ttlError);
          ok = false;
        }

        if (result != null && typeof result === "string") {
          return [JSON.parse(result), { ok, ttl }];
        }

        return [null, { ok, ttl }];
      }

      const redisGetPromise = store
        .get(responseId)
        .then((value) => {
          if (tracing) {
            logMessage("REDIS_GET", {
              key: responseId,
              cache: value == null ? "MISS" : "HIT",
              timedOut,
              time: tracing(),
            });
          }

          return value;
        })
        .catch((err) => {
          ok = false;
          return gracefullyFail(err);
        });

      const result = await (redisGetTimeout != null
        ? Promise.race([redisGetPromise, setTimeout(redisGetTimeout, RedisGetTimedOut)])
        : redisGetPromise);

      if (result === RedisGetTimedOut) {
        timedOut = true;
        if (logEvents?.REDIS_GET_TIMED_OUT ?? true) {
          logMessage("REDIS_GET_TIMED_OUT", {
            key: responseId,
            timeout: redisGetTimeout,
            time: tracing?.(),
          });
        }

        return [null, { ok: false }];
      }

      if (result != null) return [JSON.parse(result), { ok }];

      return [null, { ok }];
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
        const tracing = logEvents?.REDIS_SET ? getTracing() : null;

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

        if (tracing) {
          logMessage("REDIS_SET", {
            responseKey,
            collectedEntities: Array.from(collectedEntities)
              .map(({ typename, id }) => (id != null ? buildRedisEntityId(typename, id) : typename))
              .join(","),
            ttl,
          });
        }
      } catch (err) {
        console.error(err);
      }

      const lock = responseIdLocks[responseId];

      if (!lock) return;

      lock.release().catch(console.error);
      responseIdLocks[responseId] = null;
    },
    async get(responseId) {
      const [firstTry, { ok, ttl }] = await getFromRedis<ExecutionResult>(responseId);

      if (!ok) return [null];

      if (firstTry) return [firstTry, { ttl }];

      if (!redLock) return [null];

      const lock = await redLock
        .acquire(["lock:" + responseId], lockDuration, {
          ...lockSettings,
          retryCount: lockRetryCount,
          retryDelay: lockRetryDelay,
        })
        .then(
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
      else if (lock?.attempts.length === 1) return [null];

      return getFromRedis<ExecutionResult>(responseId).then((v) => [v[0], { ttl: v[1].ttl }]);
    },
    async invalidate(entitiesToRemove) {
      const entitiesToRemoveList = Array.from(entitiesToRemove);

      if (!entitiesToRemoveList.length) return;

      const invalidationKeys: string[] = [];

      const tracing = logEvents?.INVALIDATED_KEYS ? getTracing() : null;

      const invalidationEntitiesKey = entitiesToRemoveList.map(({ id, typename }) =>
        id != null ? buildRedisEntityId(typename, id) : typename
      );

      await Promise.all(
        invalidationEntitiesKey.map(async (key) => {
          invalidationKeys.push(...(await buildEntityInvalidationsKeys(key)));
        })
      );

      if (invalidationKeys.length > 0) {
        await store.del(invalidationKeys).catch(gracefullyFail);
      }

      if (tracing) {
        logMessage("INVALIDATED_KEYS", {
          invalidatedEntitiesKeys: entitiesToRemoveList
            .map((v) => (v.id != null ? (v.typename = ":" + v.id) : v.typename))
            .join(","),
          invalidatedKeys: invalidationKeys.join(",") || "null",
          time: tracing(),
        });
      }
    },
  };
};

export const defaultBuildRedisEntityId: BuildRedisEntityId = (typename, id) => `${typename}:${id}`;
export const defaultBuildRedisOperationResultCacheKey: BuildRedisOperationResultCacheKey = (
  responseId
) => `operations:${responseId}`;
