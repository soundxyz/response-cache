import test from "ava";
import { execSync } from "child_process";
import { gql, Plugin } from "graphql-ez";
import IORedis from "ioredis";
import { setTimeout } from "timers/promises";
import RedLock from "redlock";

import { CreateTestClient, GlobalTeardown } from "@graphql-ez/fastify-testing";
import { makeExecutableSchema } from "@graphql-tools/schema";

import { createRedisCache, useResponseCache } from "../src";

let redis: IORedis.Redis;
let redLock: RedLock;

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
  const sharedCachePlugin = createCachePlugin();
  const data = await Promise.all(
    new Array(10)
      .fill(0)
      .map(async (_, index) =>
        (
          await TestClient(index > 55 ? createCachePlugin() : sharedCachePlugin)
        ).assertedQuery("{hello}")
      )
  );

  console.log({
    data,
  });

  t.truthy(data);
});
