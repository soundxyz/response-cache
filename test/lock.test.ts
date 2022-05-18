import test from "ava";
import { gql, Plugin } from "graphql-ez";
import IORedis, { Redis } from "ioredis";
import { RedisMemoryServer } from "redis-memory-server";
import RedLock from "redlock";
import { setTimeout } from "timers/promises";
import { inspect } from "util";

import { CreateTestClient, GlobalTeardown } from "@graphql-ez/fastify-testing";
import { makeExecutableSchema } from "@graphql-tools/schema";

import { createRedisCache, useResponseCache } from "../src";

inspect.defaultOptions.depth = 5;

let redis: Redis;
let redLock: RedLock;

let expensiveCallAmount = 0;

const createCachePlugin = () =>
  useResponseCache({
    cache: createRedisCache({
      redis,
      redlock: {
        client: redLock,
        duration: 5000,
        settings: {
          retryCount: (5000 / 100) * 2,
          retryDelay: 100,
        },
      },
    }),
  });

function TestClient(cachePlugin: Plugin) {
  return CreateTestClient({
    cache: {
      parse: true,
      validation: true,
    },
    envelop: {
      plugins: [cachePlugin],
    },
    schema: makeExecutableSchema({
      typeDefs: gql`
        type Query {
          hello: String!
        }
      `,
      resolvers: {
        Query: {
          async hello() {
            console.log("---EXPENSIVE CALL!!---");
            ++expensiveCallAmount;
            await setTimeout(1000);
            return "Hello World!";
          },
        },
      },
    }),
  });
}

const memoryServer = new RedisMemoryServer({});

test.before(async () => {
  const [host, port] = await Promise.all([memoryServer.getHost(), memoryServer.getPort()]);

  redis = new IORedis({
    host,
    port,
  });

  redLock = new RedLock([redis]);
});

test.after.always(GlobalTeardown);

test("hello", async (t) => {
  const sharedCachePlugin = createCachePlugin();
  const clientsAmount = 10;
  const repeatQueryAmount = 100;
  const data = await Promise.all(
    new Array(clientsAmount).fill(0).map(async (_, index) => {
      const testClient = await TestClient(index > 5 ? sharedCachePlugin : createCachePlugin());

      return Promise.all(
        new Array(repeatQueryAmount)
          .fill(0)
          .map(() => testClient.assertedQuery<{ hello: string }>("{hello}"))
      );
    })
  );

  t.is(data.length, clientsAmount);

  t.true(
    data.every(
      (v) => v.length === repeatQueryAmount && v.every((val) => val.hello === "Hello World!")
    )
  );

  t.is(expensiveCallAmount, 1);
});
