"use strict";

// 1.3.102: a warm Netlify function reused after a heavy export.
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const warm = require("../netlify/lib/warm-guard");

function fakeJobs(job) {
  const store = { job: Object.assign({}, job) };
  return {
    store,
    readJob: async () => Object.assign({}, store.job),
    updateJob: async (_id, patch) => {
      Object.assign(store.job, patch);
      return store.job;
    },
  };
}
const MB = 1024 * 1024;

describe("warm reuse guard (1.3.102)", () => {
  afterEach(() => {
    delete process.env.OPENCLUTTER_LOW_MEMORY;
    delete process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE;
  });

  it("never acts on a roomy host (Fly, benches)", async () => {
    process.env.OPENCLUTTER_LOW_MEMORY = "0";
    let exited = null;
    const deps = { rss: () => 2000 * MB, exit: (c) => (exited = c), jobs: fakeJobs({ state: "queued" }) };
    assert.equal(await warm.beforeRun("j", deps), "run");
    assert.equal(await warm.afterRun("j", deps), false);
    assert.equal(exited, null);
  });

  it("a small process runs and stays", async () => {
    process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE = "1024";
    let exited = null;
    const deps = { rss: () => 150 * MB, exit: (c) => (exited = c), jobs: fakeJobs({ state: "queued" }) };
    assert.equal(await warm.beforeRun("j", deps), "run");
    assert.equal(await warm.afterRun("j", deps), false);
    assert.equal(exited, null);
  });

  it("a large process at start exits for a cold retry, at most twice", async () => {
    process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE = "1024";
    const jobs = fakeJobs({ state: "queued" });
    const exits = [];
    const deps = { rss: () => 1000 * MB, exit: (c) => exits.push(c), jobs };
    assert.equal(await warm.beforeRun("j", deps), "exiting");
    assert.equal(jobs.store.job.coldRetries, 1);
    assert.equal(await warm.beforeRun("j", deps), "exiting");
    assert.equal(await warm.beforeRun("j", deps), "run", "the last attempt runs anyway");
    assert.deepEqual(exits, [1, 1]);
    assert.ok(jobs.store.job.coldRetryRssMb > 1000);
  });

  it("a run that leaves the process large exits after its result is written", async () => {
    process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE = "1024";
    const jobs = fakeJobs({ state: "done" });
    let exited = null;
    assert.equal(await warm.afterRun("j", { rss: () => 980 * MB, exit: (c) => (exited = c), jobs }), true);
    assert.equal(exited, 0);
    assert.equal(jobs.store.job.state, "done");
    assert.ok(jobs.store.job.recycledRssMb > 1000);
  });

  it("the retry after that exit finds the job finished and runs nothing", async () => {
    const { priorNetlifyAttempt } = require("../netlify/lib/job-watchdog");
    const job = { state: "done", netlifyStartedAt: Date.now() - 60000, netlifyBeatAt: Date.now() - 50000 };
    assert.equal((await priorNetlifyAttempt(async () => job, "j")).verdict, "finished");
  });
});
