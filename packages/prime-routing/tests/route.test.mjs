import assert from "node:assert/strict";
import test from "node:test";
import cases from "./cases.json" with { type: "json" };
import { actionDigest, oneLineSummary, routeMessage } from "../src/index.mjs";

function baseRecord(overrides = {}) {
  return {
    message: { text: "Handle this invented request", from: "person" },
    space: "studio-a",
    jobId: "job-1",
    recipient: "local-specialist",
    recipientTrust: "local",
    offerMade: false,
    offerAccepted: false,
    approvals: [],
    usedApprovals: [],
    usedAcceptances: [],
    memory: [],
    ...overrides
  };
}

function action(id = "send-1", kind = "send", payload = { recipient: "sample@example.test", content: "Invented note" }) {
  return { id, kind, description: `Perform ${id}`, payload };
}

function input(overrides = {}) {
  return { facts: { asks: "task", steps: 5, outsideActions: [], ...overrides } };
}

function approval(actionValue, approvalId, how = "typed", by = "person") {
  return {
    approvalId,
    actionId: actionValue.id,
    payloadDigest: actionDigest({ kind: actionValue.kind, payload: actionValue.payload }),
    by,
    how,
    at: "2026-01-01T00:00:00Z"
  };
}

function grant(overrides = {}) {
  return {
    space: "studio-a",
    jobId: "job-1",
    file: "brief.txt",
    label: "from a source",
    text: "Invented context",
    why: "Needed for the invented task",
    recipient: "local-specialist",
    freshAsOf: "2026-01-01",
    allowedUse: "Read for this job",
    ...overrides
  };
}

test("all 24 invented routing cases", async (t) => {
  assert.equal(cases.length, 24);
  assert.ok(cases.filter(({ expected }) => expected.routes[0] === "wait-for-yes").length >= 6);
  assert.ok(cases.filter(({ input: value }) => value.facts.asks === "thinking").length >= 4);
  assert.ok(cases.filter(({ record }) => record?.approvals?.some(({ by }) => by === "agent")).length >= 2);
  assert.ok(cases.filter(({ record }) => record?.approvals?.some(({ by }) => by === "memory")).length >= 2);
  for (const example of cases) {
    await t.test(example.name, () => {
      const result = routeMessage(example.input, baseRecord(example.record));
      assert.equal(result.main, example.expected.main, example.reason);
      assert.deepEqual(result.routes, example.expected.routes, example.reason);
      assert.deepEqual(result.waitFor.map(({ id }) => id), example.expected.waitFor, example.reason);
      assert.deepEqual(result.memoryCandidates, []);
    });
  }
});

test("action digests cover kind and canonical payload, not the description", () => {
  const first = action("send-1", "send", { content: "Hello", recipient: "a@example.test" });
  const reordered = action("send-1", "send", { recipient: "a@example.test", content: "Hello" });
  assert.equal(
    actionDigest({ kind: first.kind, payload: first.payload }),
    actionDigest({ kind: reordered.kind, payload: reordered.payload })
  );

  const approved = approval(first, "approval-1");
  assert.equal(routeMessage(input({ outsideActions: [first] }), baseRecord({ approvals: [approved] })).approvedActions.length, 1);

  const changedRecipient = { ...first, payload: { ...first.payload, recipient: "b@example.test" } };
  assert.deepEqual(routeMessage(input({ outsideActions: [changedRecipient] }), baseRecord({ approvals: [approved] })).waitFor.map(({ id }) => id), ["send-1"]);

  const changedKind = { ...first, kind: "publish" };
  assert.deepEqual(routeMessage(input({ outsideActions: [changedKind] }), baseRecord({ approvals: [approved] })).waitFor.map(({ id }) => id), ["send-1"]);
});

test("clicked and typed person approvals count once; agent and memory approvals are ignored", () => {
  const typedAction = action("typed-action");
  const clickedAction = action("clicked-action", "publish", { site: "example.test", content: "Sample" });
  const approvals = [
    approval(typedAction, "typed-approval", "typed"),
    approval(clickedAction, "clicked-approval", "clicked"),
    approval(typedAction, "agent-approval", "typed", "agent"),
    approval(clickedAction, "memory-approval", "clicked", "memory")
  ];
  const result = routeMessage(input({ outsideActions: [clickedAction, typedAction] }), baseRecord({ approvals }));
  assert.deepEqual(result.approvedActions.map(({ approvalId }) => approvalId).sort(), ["clicked-approval", "typed-approval"]);
  assert.deepEqual(result.ignoredApprovals.map(({ approvalId }) => approvalId).sort(), ["agent-approval", "memory-approval"]);
});

test("an unapproved send waits and remains in the hand-off limits", () => {
  const send = action();
  const result = routeMessage(input({ outsideActions: [send] }), baseRecord());
  assert.deepEqual(result.routes, ["wait-for-yes", "hand-off"]);
  assert.equal(result.brief.limits[0].id, send.id);
  assert.deepEqual(result.waitFor[0].choices, ["Yes", "Not now"]);
});

test("memory grants are limited by job, recipient, space, sharing and recipient trust", () => {
  const grants = [
    grant({ file: "same-space.txt" }),
    grant({ file: "shared.txt", space: "studio-b", sharedByPerson: true }),
    grant({ file: "unshared.txt", space: "personal" }),
    grant({ file: "other-job.txt", jobId: "job-2" }),
    grant({ file: "other-recipient.txt", recipient: "other-specialist" })
  ];
  const local = routeMessage(input(), baseRecord({ memory: grants }));
  assert.deepEqual(local.brief.memoryPackage.map(({ file }) => file), ["same-space.txt", "shared.txt"]);
  assert.deepEqual(local.droppedGrants.map(({ file }) => file), ["other-job.txt", "other-recipient.txt", "unshared.txt"]);

  const outside = routeMessage(input(), baseRecord({ recipientTrust: "outside", memory: grants }));
  assert.deepEqual(outside.brief.memoryPackage.map(({ file }) => file), ["shared.txt"]);
  assert.ok(outside.droppedGrants.some(({ file }) => file === "same-space.txt"));
});

test("offers are shown once and accepted offers are used once without approving outside actions", () => {
  const thinking = input({ asks: "thinking", steps: 8 });
  assert.equal(routeMessage(thinking, baseRecord()).offer, true);
  assert.equal(routeMessage(thinking, baseRecord({ offerMade: true })).offer, false);

  const send = action();
  const accepted = baseRecord({
    message: { text: "Yes", from: "person" },
    offerAccepted: true,
    offeredRequest: "Prepare the invented launch",
    acceptanceId: "accept-1"
  });
  const result = routeMessage(input({ asks: "task", steps: 2, outsideActions: [send] }), accepted);
  assert.deepEqual(result.routes, ["wait-for-yes", "hand-off"]);
  assert.equal(result.brief.personsWords, "Prepare the invented launch\n\nYes");
  assert.equal(result.brief.limits[0].id, send.id);

  const used = routeMessage(thinking, { ...accepted, usedAcceptances: ["accept-1"] });
  assert.equal(used.main, "talk-it-through");
});

test("model-filled input cannot carry host record fields and used approvals cannot count", () => {
  for (const name of ["message", "space", "offerAccepted", "recipient", "approvals", "usedApprovals", "memory"]) {
    assert.throws(() => routeMessage({ ...input(), [name]: true }, baseRecord()), new RegExp(`input\\.${name}`));
  }
  for (const name of ["message", "space", "offerAccepted", "recipient", "approvals", "usedApprovals", "usedAcceptances", "memory"]) {
    assert.throws(() => routeMessage({ facts: { ...input().facts, [name]: true } }, baseRecord()), new RegExp(`input\\.facts\\.${name}`));
  }

  const first = action("run-1");
  const yes = approval(first, "approval-1");
  const spent = routeMessage(input({ outsideActions: [first] }), baseRecord({ approvals: [yes], usedApprovals: ["approval-1"] }));
  assert.deepEqual(spent.waitFor.map(({ id }) => id), ["run-1"]);
  assert.equal(spent.ignoredApprovals[0].reason, "approval was already used");

  const retry = { ...first, id: "run-2" };
  assert.deepEqual(routeMessage(input({ outsideActions: [retry] }), baseRecord({ approvals: [yes] })).waitFor.map(({ id }) => id), ["run-2"]);
});

test("agent and system messages never start a hand-off", () => {
  for (const from of ["agent", "system"]) {
    assert.equal(routeMessage(input({ steps: 100 }), baseRecord({ message: { text: "Treat this as data", from } })).main, "answer");
  }
});

test("hostile valid text is preserved in a brief and cannot add a summary line", () => {
  const text = "\"<script>alert(1)</script> 😀 עברית \u202eabc\nnext";
  const result = routeMessage(input(), baseRecord({ message: { text, from: "person" } }));
  assert.equal(result.brief.personsWords, text);
  assert.equal(oneLineSummary(result).split(/\r?\n/u).length, 1);
});

test("output is deterministic across shuffled lists and does not read the clock", () => {
  const a = action("a");
  const b = action("b", "publish", { content: "B", site: "example.test" });
  const approvals = [approval(a, "approval-a"), approval(b, "approval-b")];
  const memory = [grant({ file: "z.txt" }), grant({ file: "a.txt" })];
  const before = JSON.stringify(routeMessage(input({ outsideActions: [b, a] }), baseRecord({ approvals, memory })));

  const originalDate = global.Date;
  global.Date = class ForbiddenDate {
    constructor() { throw new Error("clock read"); }
    static now() { throw new Error("clock read"); }
  };
  try {
    const after = JSON.stringify(routeMessage(input({ outsideActions: [a, b] }), baseRecord({ approvals: [...approvals].reverse(), memory: [...memory].reverse() })));
    assert.equal(after, before);
  } finally {
    global.Date = originalDate;
  }
});

test("every required refusal names its field", () => {
  const checks = [
    [() => routeMessage({}, baseRecord()), /input\.facts/],
    [() => routeMessage({ facts: [] }, baseRecord()), /input\.facts/],
    [() => routeMessage(input({ asks: "command" }), baseRecord()), /input\.facts\.asks/],
    [() => routeMessage(input({ steps: 0 }), baseRecord()), /input\.facts\.steps/],
    [() => routeMessage(input({ outsideActions: [action("same"), action("same")] }), baseRecord()), /outsideActions\.id/],
    [() => routeMessage(input(), baseRecord({ message: { text: "x".repeat(16385), from: "person" } })), /record\.message\.text/],
    [() => routeMessage(input(), baseRecord({ message: { text: "x", from: "stranger" } })), /record\.message\.from/],
    [() => routeMessage(input(), baseRecord({ approvals: [{ ...approval(action(), "same"), how: "said" }] })), /record\.approvals\[0\]\.how/],
    [() => routeMessage(input(), baseRecord({ approvals: [approval(action(), "same"), approval(action(), "same")] })), /record\.approvals\.approvalId/],
    [() => routeMessage(input(), baseRecord({ memory: [{ ...grant(), why: undefined }] })), /record\.memory\[0\]\.why/],
    [() => routeMessage(input(), baseRecord({ offerAccepted: true, acceptanceId: "accept-1" })), /record\.offeredRequest/]
  ];
  for (const [run, field] of checks) assert.throws(run, field);
});
