import assert from "node:assert/strict";
import test from "node:test";

import {
  assertEvidenceMatchesBrief,
  assertPublicEvidenceUrl,
  verifyEvidenceAvailability,
} from "./business-value/evidence.mjs";

const brief = {
  queries: [
    { id: "query-1", metricIds: ["mau", "dau"] },
    { id: "query-2", metricIds: ["gross_revenue_monthly"] },
  ],
};

const source = (overrides = {}) => ({
  id: "evidence-1",
  queryId: "query-1",
  metricId: "mau",
  url: "https://evidence.example/study",
  ...overrides,
});

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const response = (status, location) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: new Headers(location ? { location } : {}),
});

test("evidence обязан соответствовать query и его metricIds", () => {
  assert.doesNotThrow(() =>
    assertEvidenceMatchesBrief({ sources: [source()] }, brief),
  );
  assert.throws(
    () =>
      assertEvidenceMatchesBrief(
        { sources: [source({ metricId: "gross_revenue_monthly" })] },
        brief,
      ),
    (error) => error.code === "EVIDENCE_QUERY_MISMATCH",
  );
  assert.throws(
    () =>
      assertEvidenceMatchesBrief(
        { sources: [source({ queryId: "query-404" })] },
        brief,
      ),
    (error) => error.code === "EVIDENCE_QUERY_MISMATCH",
  );
});

test("проверка URL запрещает локальные и непубличные адреса", async () => {
  await assert.rejects(
    assertPublicEvidenceUrl("https://127.0.0.1/private"),
    (error) => error.code === "EVIDENCE_URL_FORBIDDEN",
  );
  await assert.rejects(
    assertPublicEvidenceUrl("https://metadata.example/private", {
      lookupFn: async () => [{ address: "169.254.169.254", family: 4 }],
    }),
    (error) => error.code === "EVIDENCE_URL_FORBIDDEN",
  );
  const url = await assertPublicEvidenceUrl("https://evidence.example/study", {
    lookupFn: publicLookup,
  });
  assert.equal(url.hostname, "evidence.example");
});

test("availability оставляет только доступные источники и маркирует их", async () => {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url: url.toString(), method: options.method, range: options.headers?.range });
    if (url.pathname === "/study" && options.method === "HEAD") return response(405);
    if (url.pathname === "/study" && options.method === "GET") return response(206);
    return response(404);
  };
  const verified = await verifyEvidenceAvailability(
    {
      schemaVersion: 1,
      sources: [source(), source({ id: "evidence-2", url: "https://evidence.example/missing" })],
    },
    { fetchFn, lookupFn: publicLookup },
  );
  assert.equal(verified.sources.length, 1);
  assert.equal(verified.sources[0].id, "evidence-1");
  assert.equal(verified.sources[0].availabilityVerified, true);
  assert.deepEqual(calls.map(({ method, range }) => ({ method, range })), [
    { method: "HEAD", range: undefined },
    { method: "HEAD", range: undefined },
    { method: "GET", range: "bytes=0-0" },
  ]);
});

test("redirect на непубличный URL не считается доступным evidence", async () => {
  const verified = await verifyEvidenceAvailability(
    { schemaVersion: 1, sources: [source()] },
    {
      fetchFn: async () => response(302, "https://127.0.0.1/private"),
      lookupFn: publicLookup,
    },
  );
  assert.deepEqual(verified.sources, []);
});
