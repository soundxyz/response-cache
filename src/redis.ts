import type { ExecutionResult } from "graphql";
import type { Redis } from "ioredis";
import type RedLock from "redlock";
import type { Lock, Settings } from "redlock";
import { setTimeout as timersSetTimeout } from "timers/promises";
import type { Cache } from "./plugin";
import { chunk } from "./utils";

export type BuildRedisEntityId = (typename: string, id: number | string) => string;
export type BuildRedisOperationResultCacheKey = (responseId: string) => string;

export const Events = {
  REDIS_GET: "REDIS_GET",
  REDIS_GET_TIMED_OUT: "REDIS_GET_TIMED_OUT",
  REDIS_SET: "REDIS_SET",
  INVALIDATE_KEY_SCAN: "INVALIDATE_KEY_SCAN",
  INVALIDATED_KEYS: "INVALIDATED_KEYS",
  CONCURRENT_CACHED_CALL_HIT: "CONCURRENT_CACHED_CALL_HIT",
  REDLOCK_ACQUIRED: "REDLOCK_ACQUIRED",
  REDLOCK_RELEASED: "REDLOCK_RELEASED",
  REDLOCK_GET_AFTER_ACQUIRE: "REDLOCK_GET_AFTER_ACQUIRE",
} as const;

export type Events = (typeof Events)[keyof typeof Events];

export type LogEventArgs = { message: string; code: Events; params: EventParamsObject };

export type LoggedEvents = Partial<
  Record<Events, string | boolean | null | ((args: LogEventArgs) => void)>
>;

function defaultLog({ message }: LogEventArgs) {
  console.log(message);
}

export type EventParamsObject = Record<string, string | number | boolean | null | undefined>;

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
   * Enable event logging
   */
  logEvents?: {
    events: LoggedEvents;

    /**
     * @default console.log
     */
    log?: (args: LogEventArgs) => void;
  };

  /**
   * Set a maximum amount of milliseconds for redis gets to wait for the GET redis response
   */
  GETRedisTimeout?: number;

  onError?: (err: unknown) => void;

  /**
   * @default 20
   */
  concurrencyLimit?: number;
};

export const createRedisCache = ({
  redis: store,
  redlock,
  debugTtl = false,
  logEvents,
  buildRedisEntityId = defaultBuildRedisEntityId,
  buildRedisOperationResultCacheKey = defaultBuildRedisOperationResultCacheKey,
  GETRedisTimeout,
  onError = console.error,
  concurrencyLimit = 20,
}: RedisCacheParameter): Cache => {
  const redLock = redlock?.client;
  const lockSettings = redlock?.settings;
  const lockDuration = redlock?.duration ?? 5000;
  const lockRetryDelay = redlock?.settings?.retryDelay ?? 250;
  const lockRetryCount = lockSettings?.retryCount ?? (lockDuration / lockRetryDelay) * 2;

  function gracefullyFail(err: unknown) {
    onError(err);
    return null;
  }

  function getTracing() {
    const start = performance.now();

    return () => `${(performance.now() - start).toFixed()}ms`;
  }

  const enabledLogEvents = logEvents?.events;

  const logMessage = logEvents
    ? function logMessage(code: Events, params: EventParamsObject) {
        const eventValue = logEvents.events[code];

        if (!eventValue) return;

        const log = typeof eventValue === "function" ? eventValue : logEvents.log || defaultLog;

        const codeMessageValue = typeof eventValue === "string" ? eventValue : code;

        let paramsString = "";

        for (const key in params) {
          let value = params[key];

          if (value === undefined) continue;

          if (value === "") value = "null";

          paramsString += " " + key + "=" + value;
        }

        log({
          code,
          message: `[${codeMessageValue}]${paramsString}`,
          params,
        });
      }
    : () => void 0;

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
      const tracing = enabledLogEvents?.INVALIDATE_KEY_SCAN ? getTracing() : null;

      const key = `${entity}:*`;
      const entityKeys = await store.keys(key).catch(gracefullyFail);

      if (tracing && entityKeys) {
        logMessage("INVALIDATE_KEY_SCAN", {
          key,
          entityKeys: entityKeys.join(",") || "null",
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
      if (enabledLogEvents?.CONCURRENT_CACHED_CALL_HIT) {
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

      let timedOut: true | undefined;

      const tracing =
        enabledLogEvents?.REDIS_GET || (enabledLogEvents?.REDIS_GET_TIMED_OUT ?? true)
          ? getTracing()
          : null;

      if (debugTtl) {
        const redisGetPromise = store
          .pipeline()
          .get(responseId)
          .ttl(responseId)
          .exec()
          .then((value) => {
            if (enabledLogEvents?.REDIS_GET) {
              const ttl = value?.[1]?.[1];
              logMessage("REDIS_GET", {
                key: responseId,
                cache: value?.[0]?.[1] == null ? "MISS" : "HIT",
                timedOut,
                remainingTtl: typeof ttl === "number" ? ttl : "null",
                time: tracing?.(),
              });
            }
            return value;
          })
          .catch(gracefullyFail);

        const resultWithTtl = await (GETRedisTimeout != null
          ? Promise.race([redisGetPromise, timersSetTimeout(GETRedisTimeout, undefined)])
          : redisGetPromise);

        if (resultWithTtl === undefined) {
          timedOut = true;
          if (enabledLogEvents?.REDIS_GET_TIMED_OUT ?? true) {
            logMessage("REDIS_GET_TIMED_OUT", {
              key: responseId,
              timeout: GETRedisTimeout,
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
          if (enabledLogEvents?.REDIS_GET) {
            logMessage("REDIS_GET", {
              key: responseId,
              cache: value == null ? "MISS" : "HIT",
              timedOut,
              time: tracing?.(),
            });
          }

          return value;
        })
        .catch((err) => {
          ok = false;
          return gracefullyFail(err);
        });

      const result = await (GETRedisTimeout != null
        ? Promise.race([redisGetPromise, timersSetTimeout(GETRedisTimeout, undefined)])
        : redisGetPromise);

      if (result === undefined) {
        timedOut = true;
        if (enabledLogEvents?.REDIS_GET_TIMED_OUT) {
          logMessage("REDIS_GET_TIMED_OUT", {
            key: responseId,
            timeout: GETRedisTimeout,
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
        const tracing = enabledLogEvents?.REDLOCK_RELEASED ? getTracing() : null;

        lock
          .release()
          .then(({ attempts }) => {
            if (tracing) {
              logMessage("REDLOCK_RELEASED", {
                key: responseId,
                attempts: attempts.length,
                time: tracing(),
              });
            }
          })
          .catch(() => null);
        responseIdLocks[responseId] = null;
      }
    },
    async set(responseId, result, collectedEntities, ttl) {
      try {
        const tracing = enabledLogEvents?.REDIS_SET ? getTracing() : null;

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
        onError(err);
      }

      const lock = responseIdLocks[responseId];

      if (!lock) return;

      const tracing = enabledLogEvents?.REDLOCK_RELEASED ? getTracing() : null;
      lock
        .release()
        .then(({ attempts }) => {
          if (tracing) {
            logMessage("REDLOCK_RELEASED", {
              key: responseId,
              attempts: attempts.length,
              time: tracing(),
            });
          }
        })
        .catch(() => null);
      responseIdLocks[responseId] = null;
    },
    async get(responseId) {
      const [firstTry, { ok, ttl }] = await getFromRedis<ExecutionResult>(responseId);

      if (!ok) return [null];

      if (firstTry) return [firstTry, { ttl }];

      if (!redLock) return [null];

      const tracing = enabledLogEvents?.REDLOCK_ACQUIRED ? getTracing() : null;

      const lock = await redLock
        .acquire(["lock:" + responseId], lockDuration, {
          ...lockSettings,
          retryCount: lockRetryCount,
          retryDelay: lockRetryDelay,
        })
        .then(
          (lock) => {
            if (tracing) {
              logMessage("REDLOCK_ACQUIRED", {
                key: responseId,
                attempts: lock.attempts.length,
                time: tracing(),
              });
            }

            if (lock.attempts.length === 1) {
              return (responseIdLocks[responseId] = lock);
            }

            return lock;
          },
          () => null
        );

      // Any lock that took more than 1 attempt should be released right away for the other readers
      if (lock && lock.attempts.length > 1) {
        const tracing = enabledLogEvents?.REDLOCK_RELEASED ? getTracing() : null;

        lock
          .release()
          .then(({ attempts }) => {
            if (tracing) {
              logMessage("REDLOCK_RELEASED", {
                key: responseId,
                attempts: attempts.length,
                time: tracing(),
              });
            }
          })
          .catch(() => null);
      }
      // If the lock was first attempt, skip the second get try, and go right to execute
      else if (lock?.attempts.length === 1) return [null];

      {
        const tracing = enabledLogEvents?.REDLOCK_GET_AFTER_ACQUIRE ? getTracing() : null;

        const getAfterLock = await getFromRedis<ExecutionResult>(responseId).then(
          (v) => [v[0], { ttl: v[1].ttl }] as const
        );

        if (tracing) {
          logMessage("REDLOCK_GET_AFTER_ACQUIRE", {
            key: responseId,
            cache: getAfterLock[0] != null ? "HIT" : "MISS",
            time: tracing(),
          });
        }

        return getAfterLock;
      }
    },
    async invalidate(entitiesToRemove) {
      const entitiesToRemoveList = Array.from(entitiesToRemove);

      if (!entitiesToRemoveList.length) return;

      const tracing = enabledLogEvents?.INVALIDATED_KEYS ? getTracing() : null;

      const invalidationEntitiesKey = entitiesToRemoveList.map(({ id, typename }) =>
        id != null ? buildRedisEntityId(typename, id) : typename
      );

      const chunksInvalidationEntities = chunk(invalidationEntitiesKey, concurrencyLimit);

      let invalidationKeysSize = 0;

      for (const invalidationEntities of chunksInvalidationEntities) {
        await Promise.all(
          invalidationEntities.map(async (key) => {
            const keys = await buildEntityInvalidationsKeys(key);

            const chunkedKeys = chunk(keys, concurrencyLimit);

            for (const invalidationChunk of chunkedKeys) {
              invalidationKeysSize += invalidationChunk.length;

              await store.del(invalidationChunk).catch(gracefullyFail);
            }
          })
        );
      }

      if (tracing) {
        logMessage("INVALIDATED_KEYS", {
          invalidatedEntitiesKeys: entitiesToRemoveList
            .map((v) => (v.id != null ? (v.typename = ":" + v.id) : v.typename))
            .join(","),
          invalidationKeysSize,
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
