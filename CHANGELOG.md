# @soundxyz/response-cache

## 2.2.1

### Patch Changes

- bd42e6e: Include GraphQL Errors on "Failed to cache due to errors"

## 2.2.0

### Minor Changes

- 3572893: concurrencyLimit option, by default 20. Used by "invalidate" function

## 2.1.0

### Minor Changes

- 446f3fc: logEvents.events accepts custom log functions for specific events

### Patch Changes

- 446f3fc: logEvents.log is now optional (console.log default fallback)

## 2.0.1

### Patch Changes

- 7f10b84: Never log empty param string, fallback to "null"

## 2.0.0

### Major Changes

- b16d035: Minimum version of Node.js is v16

### Minor Changes

- b16d035: New "GETRedisTimeout" option to set a maximum amount of milliseconds to wait for the GET redis responses
- b16d035: New "logEvents" option to enable observability of events

## 1.1.1

### Minor Changes

- New "debugTtl" option for "createRedisCache" that shows ttl (seconds) of currently-cached responses in metadata extensions

## 1.0.3

### Patch Changes

- 2237fde: Always leverage document visit cache
- 007669b: Official Documentation
- b81b3b3: Improve redlock defaults

## 1.0.2

### Patch Changes

- 3ea61fd: Fix overwrite existing result extensions

## 1.0.1

### Patch Changes

- 7325294: remove lock on finalTtl <= 0

## 1.0.0

### Major Changes

- bfb518f: First class support for ESM

### Minor Changes

- bfb518f: Make redlock optional + put all options in `redlock` field
- bfb518f: Allow to set the expiry time on execution, use $responseCache.setExpiry, $responseCache.getExpiry, and ResponseCacheContext interface to extend user context type

## 0.3.1

### Patch Changes

- b649bea: Update ioredis to v5

## 0.3.0

### Minor Changes

- 903885f: Clean lock on execution error
- 903885f: Parallel buildEntityInvalidationsKeys

### Patch Changes

- 903885f: Use "= null" instead of delete (small perf improvement)
- 903885f: Change forEach to for of

## 0.2.6

### Patch Changes

- fb69f77: Fix redLock check

## 0.2.5

### Patch Changes

- b438abe: Skip redlock functionality

## 0.2.4

### Patch Changes

- 7d3da9e: If redis fails on get, skip lock logic

## 0.2.3

### Patch Changes

- 48df81a: Redis usage gracefully fails

## 0.2.2

### Patch Changes

- 05b8a9e: Improve concurrent get logic

## 0.2.1

### Patch Changes

- ac6ed51: fix partial lock settings

## 0.2.0

### Minor Changes

- d8724fb: allow customize lock settings

## 0.1.3

### Patch Changes

- 08c2aa2: clean

## 0.1.2

### Patch Changes

- 5a345ee: esm->cjs

## 0.1.1

### Patch Changes

- de0684b: clean

## 0.1.0

### Minor Changes

- c6a2bb3: Release
