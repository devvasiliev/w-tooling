import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { BusinessValueError } from "./errors.mjs";

const MAX_REDIRECTS = 3;

const ipv4Number = (address) =>
  address
    .split(".")
    .map(Number)
    .reduce((value, octet) => value * 256 + octet, 0);

const ipv4InRange = (address, first, prefix) => {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(first) & mask);
};

const isPublicAddress = (address) => {
  const version = isIP(address);
  if (version === 4) {
    return ![
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ].some(([first, prefix]) => ipv4InRange(address, first, prefix));
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) {
      return isPublicAddress(normalized.slice("::ffff:".length));
    }
    return !(
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("2001:db8:") ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("ff")
    );
  }
  return false;
};

export function assertEvidenceMatchesBrief(evidence, brief) {
  const queries = new Map((brief?.queries || []).map((query) => [query.id, query]));
  for (const source of evidence?.sources || []) {
    const query = queries.get(source.queryId);
    if (!query || !query.metricIds.includes(source.metricId)) {
      throw new BusinessValueError(
        "EVIDENCE_QUERY_MISMATCH",
        "External evidence не соответствует research-query и его метрике",
      );
    }
  }
}

export async function assertPublicEvidenceUrl(rawUrl, { lookupFn = lookup } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BusinessValueError("EVIDENCE_URL_FORBIDDEN", "Evidence URL некорректен");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.hostname === "localhost"
  ) {
    throw new BusinessValueError(
      "EVIDENCE_URL_FORBIDDEN",
      "Evidence URL должен вести на публичный HTTPS-ресурс",
    );
  }
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookupFn(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new BusinessValueError(
      "EVIDENCE_URL_FORBIDDEN",
      "Evidence URL разрешился в непубличный адрес",
    );
  }
  return url;
}

const fetchWithSafeRedirects = async ({
  rawUrl,
  method,
  fetchFn,
  lookupFn,
  timeoutMs,
  headers = {},
}) => {
  let url = await assertPublicEvidenceUrl(rawUrl, { lookupFn });
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetchFn(url, {
      method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status < 300 || response.status >= 400) return response;
    if (redirects === MAX_REDIRECTS) return response;
    const location = response.headers?.get?.("location");
    if (!location) return response;
    url = await assertPublicEvidenceUrl(new URL(location, url).toString(), { lookupFn });
  }
};

const sourceIsAvailable = async ({ source, fetchFn, lookupFn, timeoutMs }) => {
  try {
    const head = await fetchWithSafeRedirects({
      rawUrl: source.url,
      method: "HEAD",
      fetchFn,
      lookupFn,
      timeoutMs,
    });
    if (head.ok) return true;
    if (![403, 405].includes(head.status)) return false;
    const get = await fetchWithSafeRedirects({
      rawUrl: source.url,
      method: "GET",
      headers: { range: "bytes=0-0" },
      fetchFn,
      lookupFn,
      timeoutMs,
    });
    return get.ok;
  } catch {
    return false;
  }
};

export async function verifyEvidenceAvailability(
  evidence,
  { fetchFn = fetch, lookupFn = lookup, timeoutMs = 8_000 } = {},
) {
  const verified = await Promise.all(
    (evidence?.sources || []).map(async (source) =>
      (await sourceIsAvailable({ source, fetchFn, lookupFn, timeoutMs }))
        ? { ...source, availabilityVerified: true }
        : null,
    ),
  );
  return { ...evidence, sources: verified.filter(Boolean) };
}
