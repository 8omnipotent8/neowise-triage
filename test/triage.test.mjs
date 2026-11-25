import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp, triage } from "../server.mjs";
import { mountTriage } from "../client.mjs";

const manual = { status: "manual_review", topic: null, draft: null };
const ready = { status: "ready", topic: "delivery", draft: "Ответ" };

async function serve(t, provider) {
  const server = createApp({ provider });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    get: path => fetch(url + path),
    post: body => fetch(url + "/api/triage", {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    }),
  };
}

test("invalid input returns 400 without calling AI", async t => {
  let calls = 0;
  const { post } = await serve(t, () => { calls++; });
  for (const body of ["", "{", "null", "[]", "{}", '{"text":null}',
    '{"text":42}', '{"text":false}', '{"text":[]}', '{"text":{}}',
    '{"text":""}', JSON.stringify({ text: " \n\t " })]) {
    const response = await post(body);
    assert.equal(response.status, 400, body);
    assert.deepEqual(await response.json(), { status: "invalid_input" });
  }
  assert.equal(calls, 0);
});

test("real mock: success and all failure modes over HTTP", async t => {
  const { post, get } = await serve(t);
  for (const [text, topic] of [["Доставка", "delivery"], ["Цена", "pricing"], ["Привет", "other"]]) {
    const response = await post(JSON.stringify({ text }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, "ready");
    assert.equal(result.topic, topic);
    assert.ok(result.draft.trim());
  }
  for (const marker of ["timeout", "error", "bad-json", "bad-topic", "empty-draft"]) {
    const started = performance.now();
    const response = await post(JSON.stringify({ text: `[${marker}]` }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), manual, marker);
    if (marker === "timeout") assert.ok(performance.now() - started < 1000);
  }
  assert.equal((await get("/")).status, 200);
  assert.match((await get("/client.mjs")).headers.get("content-type"), /javascript/);
  assert.equal((await get("/missing")).status, 404);
});

test("AI schema rejects malformed shapes and never trusts extra fields", async () => {
  for (const value of [null, [], 1, "text", {}, { topic: "delivery", draft: 1 },
    { topic: "refund", draft: "ok" }, { topic: "delivery", draft: " \t " }]) {
    assert.deepEqual(await triage("text", () => JSON.stringify(value)), manual);
  }
  assert.deepEqual(await triage("text", () => JSON.stringify({
    topic: "delivery", draft: " Ответ ", status: "malicious", extra: true,
  })), ready);
});

test("300ms deadline aborts provider, even if provider ignores cancellation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  const pending = triage("text", (_, options) => {
    signal = options.signal;
    return new Promise(() => {});
  });
  await Promise.resolve();
  let finished = false;
  pending.then(() => { finished = true; });
  t.mock.timers.tick(299);
  await Promise.resolve();
  assert.equal(finished, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, manual);
  assert.equal(signal.aborted, true);
});

// Minimal DOM adapter: exercises the actual form handler and rendered text.
function page(fetcher) {
  const nodes = Object.fromEntries(["form", "#message", "#status", "#topic", "#draft"]
    .map(key => [key, { textContent: "", value: "" }]));
  let submit;
  nodes.form.addEventListener = (event, callback) => {
    assert.equal(event, "submit"); submit = callback;
  };
  mountTriage({ querySelector: key => nodes[key] }, fetcher);
  return { nodes, submit: (text = "Заявка") => {
    nodes["#message"].value = text;
    return submit({ preventDefault() {} });
  } };
}
const reply = data => ({ ok: true, json: async () => data });

test("UI clears a previous successful draft on every failure", async () => {
  for (const fail of [
    async () => reply(manual),
    async () => { throw new Error("offline"); },
    async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => { throw new Error("bad JSON"); } }),
    async () => reply({ ...ready, topic: "refund" }),
    async () => reply({ ...ready, draft: "  " }),
    async () => reply(null),
  ]) {
    let calls = 0;
    const { nodes, submit } = page((...args) => ++calls === 1 ? reply(ready) : fail(...args));
    await submit();
    assert.equal(nodes["#draft"].textContent, "Ответ");
    const pending = submit();
    assert.equal(nodes["#draft"].textContent, "");
    await pending;
    assert.match(nodes["#status"].textContent, /ручной разбор/);
    assert.equal(nodes["#topic"].textContent, "");
    assert.equal(nodes["#draft"].textContent, "");
  }
});

test("UI rejects whitespace locally and clears previous result", async () => {
  let calls = 0;
  const { nodes, submit } = page(() => { calls++; return reply(ready); });
  await submit();
  await submit(" \n\t ");
  assert.equal(calls, 1);
  assert.match(nodes["#status"].textContent, /Введите текст/);
  assert.equal(nodes["#draft"].textContent, "");
});

test("UI bounds a hanging network request and clears old draft", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let signal;
  const { nodes, submit } = page((_, options) => {
    signal = options.signal;
    return ++calls === 1 ? reply(ready) : new Promise(() => {});
  });
  await submit();
  const pending = submit();
  t.mock.timers.tick(5000);
  await pending;
  assert.equal(signal.aborted, true);
  assert.match(nodes["#status"].textContent, /ручной разбор/);
  assert.equal(nodes["#draft"].textContent, "");
});

test("out-of-order success or failure cannot overwrite the newest result", async () => {
  for (const rejectOld of [false, true]) {
    let completeOld, failOld, calls = 0;
    const { nodes, submit } = page(() => ++calls === 1
      ? new Promise((resolve, reject) => { completeOld = resolve; failOld = reject; })
      : reply({ ...ready, draft: "Новый ответ" }));
    const old = submit("Старая заявка");
    await submit("Новая заявка");
    if (rejectOld) failOld(new Error("late failure"));
    else completeOld(reply(ready));
    await old;
    assert.equal(nodes["#draft"].textContent, "Новый ответ");
    assert.match(nodes["#status"].textContent, /Черновик готов/);
  }
});
