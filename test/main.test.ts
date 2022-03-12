import test from "ava";
import { execSync } from "child_process";
import { gql } from "graphql-ez";
import IORedis from "ioredis";
import RedLock from "redlock";

import { CreateTestClient, GlobalTeardown } from "@graphql-ez/fastify-testing";
import { makeExecutableSchema } from "@graphql-tools/schema";

import { createRedisCache, useResponseCache } from "../src";

let redis: IORedis.Redis;
let redLock: RedLock;
let testClient: Awaited<ReturnType<typeof CreateTestClient>>;

test.before(async () => {
  execSync("docker-compose up -d", {
    stdio: "ignore",
  });

  redis = new IORedis(9736);

  redLock = new RedLock([redis]);

  testClient = await CreateTestClient({
    envelopPlugins: [
      useResponseCache({
        cache: createRedisCache({
          redLock,
          redis,
        }),
      }),
    ],
    schema: makeExecutableSchema({
      typeDefs: gql`
        type Query {
          hello: String!
        }
      `,
      resolvers: {
        Query: {
          hello() {
            return "Hello World!";
          },
        },
      },
    }),
  });
});

test.after.always(GlobalTeardown);

test.after.always(() => {
  execSync("docker-compose down", {
    stdio: "ignore",
  });
});

test("hello", async (t) => {
  t.deepEqual(await testClient.assertedQuery("{hello}"), {
    hello: "Hello World!",
  });
});
