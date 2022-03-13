import test from "ava";
import { execSync } from "child_process";
import { gql, Plugin } from "graphql-ez";
import IORedis from "ioredis";
import RedLock from "redlock";
import { setTimeout } from "timers/promises";
import { inspect } from "util";

import { CreateTestClient, GlobalTeardown } from "@graphql-ez/fastify-testing";
import { makeExecutableSchema } from "@graphql-tools/schema";

import { createRedisCache, useResponseCache } from "../src";

inspect.defaultOptions.depth = Infinity;

let redis: IORedis.Redis;
let redLock: RedLock;

let expensiveCallAmount = 0;

const createCachePlugin = () =>
  useResponseCache({
    cache: createRedisCache({
      redLock,
      redis,
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

test.before(async () => {
  execSync("docker-compose down && docker-compose up -d", {
    stdio: "ignore",
  });

  redis = new IORedis(9736);

  redLock = new RedLock([redis]);
});

test.after.always(GlobalTeardown);

test("hello", async (t) => {
  const data = await Promise.all(
    new Array(10).fill(0).map(async (_, _index) => {
      const testClient = await TestClient(createCachePlugin());

      return Promise.all([
        testClient.assertedQuery<{ hello: string }>("{hello}"),
        testClient.assertedQuery<{ hello: string }>("{hello}"),
        testClient.assertedQuery<{ hello: string }>("{hello}"),
      ]);
    })
  );

  t.is(data.length, 10);

  t.true(data.every((v) => v.every((val) => val.hello === "Hello World!")));

  t.is(expensiveCallAmount, 1);
});
