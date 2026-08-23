import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const config = JSON.parse(await readFile(
  new URL("../wrangler.jsonc", import.meta.url),
  "utf8",
));

const DEFAULT_DELIVERY_DELAY = 0;
const FEATURE_QUEUES_V1 = "queues-v1";

function normalizedManifest(queueConfig) {
  return {
    bindings: queueConfig.producers.map((producer) => ({
      type: "queue",
      name: producer.binding,
      queue_name: producer.queue,
      delivery_delay: producer.delivery_delay ?? DEFAULT_DELIVERY_DELAY,
    })),
    queue_consumers: queueConfig.consumers.map((consumer) => ({
      queue_name: consumer.queue,
      max_batch_size: consumer.max_batch_size,
      max_batch_timeout: consumer.max_batch_timeout,
      max_retries: consumer.max_retries,
      retry_delay: consumer.retry_delay,
    })),
    required_features: [FEATURE_QUEUES_V1],
  };
}

test("queue Wrangler config normalizes to the queues-v1 manifest contract", () => {
  assert.deepEqual(Object.keys(config.queues).sort(), ["consumers", "producers"]);
  assert.deepEqual(normalizedManifest(config.queues), {
    bindings: [{
      type: "queue",
      name: "EVENTS",
      queue_name: "example-events",
      delivery_delay: 0,
    }],
    queue_consumers: [{
      queue_name: "example-events",
      max_batch_size: 10,
      max_batch_timeout: 1,
      max_retries: 2,
      retry_delay: 1,
    }],
    required_features: ["queues-v1"],
  });
});

test("the fixture remains dependency-free", async () => {
  const packageJson = JSON.parse(await readFile(
    new URL("../package.json", import.meta.url),
    "utf8",
  ));
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.devDependencies, undefined);
});
