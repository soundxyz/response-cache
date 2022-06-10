# @sound-xyz/response-cache

Alternative to [@envelop/response-cache](https://www.envelop.dev/plugins/use-response-cache) with new features:

- Support for [Distributed Redis Locks](https://redis.io/docs/reference/patterns/distributed-locks/) using [RedLock](https://github.com/mike-marcacci/node-redlock) (Opt-in)
- Support for setting the response cache dynamically
- Leverage [cached parsed documents](https://www.envelop.dev/plugins/use-parser-cache) for faster TTL calculation based on customs `ttlPerSchemaCoordinate`.
- Idempotent redis `get` calls (Multiple concurrent calls to redis re-use the same promise)
