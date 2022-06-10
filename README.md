# @sound-xyz/response-cache

Alternative to [@envelop/response-cache](https://www.envelop.dev/plugins/use-response-cache) with new features:

- Support for [Distributed Redis Locks](https://redis.io/docs/reference/patterns/distributed-locks/) using [RedLock](https://github.com/mike-marcacci/node-redlock) (Opt-in), so your resolvers logic only get's executed once with identical queries
- Support for setting the response cache dynamically
- Leverage [cached parsed documents](https://www.envelop.dev/plugins/use-parser-cache) for faster TTL calculation based on customs `ttlPerSchemaCoordinate`.
- Idempotent redis `get` calls (Multiple concurrent calls to redis re-use the same promise)

## Install

```sh
pnpm add @soundxyz/response-cache
```

```sh
yarn add @soundxyz/response-cache
```

```sh
npm install @soundxyz/response-cache
```

### Peer dependencies

> `redlock` is optional

```sh
pnpm add ioredis redlock
```

```sh
yarn add ioredis redlock
```

```sh
npm install ioredis redlock
```

## Usage

### Configuration

Most of the configuration is the same as with `@envelop/response-cache`

```ts
import Redis from "ioredis";
import RedLock from "redlock";

export const redis = new Redis();
export const redLock = new RedLock([redis], {});
```

```ts
import {
  createRedisCache,
  useResponseCache,
  UseResponseCacheParameter,
} from "@soundxyz/response-cache";
import ms from "ms";

import { redis, redLock } from "./redis";

export const responseCache = createRedisCache({
  // ioredis instance
  redis,
  // Don't specify or set to `null` to disable
  redlock: {
    // Client created calling the `redlock` package
    client: redLock,
    // The default is 5000ms
    duration: 5000,
    settings: {
      // The default is ((duration / retryDelay) * 2)
      retryCount: (5000 / 250) * 2,
      // The default is 250ms
      retryDelay: 250,
    },
  },
});

const cacheConfig: UseResponseCacheParameter = {
  cache: responseCache,
  // cache operations for 1 hour by default
  ttl: ms("1 hour"),
  ttlPerSchemaCoordinate: {
    "Query.fooBar": 0,
  },
  includeExtensionMetadata: true,
};

// ...

({
  plugins: [
    //...
    useResponseCache(cacheConfig),
  ],
});
```

### Dynamic TTL

We have to add the ResponseCache context type in your custom context:

```ts
import type { ResponseCacheContext } from "@soundxyz/response-cache";

export interface Context extends ResponseCacheContext {
  // ...
}
```

Then you can use it directly on your resolvers:

```ts
// ...
makeExecutableSchema({
  typeDefs: `
  type Query {
    hello: String!
  }
  `,
  resolvers: {
    Query: {
      hello(_root, _args, context: Context) {
        // Get the current expiry to be used for the cache TTL
        const expiry = ctx.$responseCache?.getExpiry();

        // You can use any logic
        if (expiry != null && expiry > 500) {
          // Set the expiry to any arbitrary value in milliseconds
          context.$responseCache?.setExpiry({
            // TTL in ms
            ttl: 1000,
          });
        }

        return "Hello World";
      },
    },
  },
});
```
