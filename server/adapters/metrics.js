/**
 * Latency and throughput accounting.
 *
 * Three independent sources, kept separate because they measure different
 * things and conflating them would hide the bottleneck you are hunting:
 *
 *   transport  -- how long the dashboard waits on the OpenClaw CLI. This is
 *                 dashboard overhead, not North's speed. Useful for telling
 *                 "North is slow" apart from "this panel is slow".
 *   model      -- durationMs / timeToFirstByteMs harvested from OpenClaw's own
 *                 structured logs. This is the real answer to "how fast is
 *                 North", because the gateway measures it at the source.
 *   tool       -- tool execution spans from the same logs.
 *
 * Everything is in-memory and bounded. Nothing is persisted: latency history
 * is not worth a database, and a file would be one more thing to leak.
 */

import * as R from '../lib/result.js';
import { normalizeTime } from './openclaw.js';

const MAX_SAMPLES = 600;

/** Percentile over an unsorted array of numbers. */
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(samples, valueOf = (s) => s.ms) {
  const values = samples.map(valueOf).filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!values.length) return null;
  return {
    count: values.length,
    avg: values.reduce((a, b) => a + b, 0) / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
  };
}

export class MetricsStore {
  constructor(adapter, config) {
    this.adapter = adapter;
    this.config = config;
    /** Requests we issued ourselves from the Console -- fully attributed. */
    this.requests = [];
    /** Model-call spans harvested from OpenClaw logs, keyed to dedupe. */
    this.model = [];
    this.tool = [];
    this.seen = new Set();
  }

  push(bucket, sample) {
    bucket.push(sample);
    if (bucket.length > MAX_SAMPLES) bucket.splice(0, bucket.length - MAX_SAMPLES);
  }

  /** Record a Console round trip, which we time end-to-end ourselves. */
  recordRequest({ text, totalMs, ok, method, sessionId }) {
    this.push(this.requests, {
      at: Date.now(),
      // Store only a short excerpt. The full prompt is North's business, and
      // an in-memory copy of everything typed is a liability.
      excerpt: String(text ?? '').slice(0, 80),
      totalMs,
      ok,
      method,
      sessionId: sessionId ?? null,
    });
  }

  /**
   * Mine OpenClaw's structured logs for timing spans.
   *
   * The documented model-call diagnostic fields are `timeToFirstByteMs` and
   * `durationMs`; tool spans carry a duration alongside a tool name. Entries
   * are deduped by trace/span id so repeated polling of an overlapping window
   * does not double-count.
   */
  ingestLogs(entries) {
    if (!Array.isArray(entries)) return;
    for (const raw of entries) {
      if (!raw || typeof raw !== 'object') continue;
      const at = normalizeTime(raw.time ?? raw.ts ?? raw.timestamp ?? raw.at) ?? Date.now();
      const key = raw.spanId ?? raw.traceId ?? `${at}:${raw.message ?? ''}`.slice(0, 120);
      if (this.seen.has(key)) continue;

      const ttft = num(raw.timeToFirstByteMs);
      const duration = num(raw.durationMs);
      if (ttft == null && duration == null) continue;

      this.seen.add(key);
      // Bound the dedupe set alongside the sample buffers.
      if (this.seen.size > MAX_SAMPLES * 4) {
        this.seen = new Set([...this.seen].slice(-MAX_SAMPLES * 2));
      }

      const isTool = Boolean(raw.toolName ?? raw.tool) || /tool/i.test(String(raw.message ?? ''));
      const sample = {
        at,
        ms: duration,
        ttftMs: ttft,
        name: raw.toolName ?? raw.tool ?? raw.model ?? raw.message ?? null,
        session: raw.session_id ?? raw.sessionId ?? null,
        requestBytes: num(raw.requestPayloadBytes),
        responseBytes: num(raw.responseStreamBytes),
      };
      this.push(isTool ? this.tool : this.model, sample);
    }
  }

  /** Refresh log-derived samples. Cheap enough to call on the activity tick. */
  async refresh() {
    const logs = await this.adapter.logs(300);
    if (R.isOk(logs)) {
      const entries = Array.isArray(logs.data)
        ? logs.data
        : logs.data?.lines ?? logs.data?.entries ?? logs.data?.items ?? [];
      // `logs.tail` may hand back raw JSONL strings rather than objects.
      const parsed = entries
        .map((e) => {
          if (typeof e !== 'string') return e;
          try { return JSON.parse(e); } catch { return null; }
        })
        .filter(Boolean);
      this.ingestLogs(parsed);
    }
    return logs;
  }

  /** Everything the Performance page renders. */
  snapshot() {
    const transport = this.adapter.transport.samples ?? [];
    const recent = (arr, ms) => arr.filter((s) => Date.now() - s.at <= ms);

    const modelSamples = this.model;
    const slowest = [...this.requests, ...modelSamples]
      .filter((s) => typeof (s.totalMs ?? s.ms) === 'number')
      .sort((a, b) => (b.totalMs ?? b.ms) - (a.totalMs ?? a.ms))
      .slice(0, 8)
      .map((s) => ({
        at: s.at,
        ms: s.totalMs ?? s.ms,
        label: s.excerpt || s.name || 'model call',
        kind: s.excerpt ? 'console' : 'model',
      }));

    return R.ok(
      {
        // Series are returned raw so the client can draw them without a
        // round trip per zoom level. They are bounded by MAX_SAMPLES.
        series: {
          model: modelSamples.map((s) => ({ at: s.at, ms: s.ms, ttftMs: s.ttftMs })),
          tool: this.tool.map((s) => ({ at: s.at, ms: s.ms, name: s.name })),
          request: this.requests.map((s) => ({ at: s.at, ms: s.totalMs, ok: s.ok })),
          transport: transport.map((s) => ({ at: s.at, ms: s.ms, method: s.method, ok: s.ok })),
        },
        summary: {
          model: summarize(modelSamples),
          modelTtft: summarize(modelSamples, (s) => s.ttftMs),
          tool: summarize(this.tool),
          request: summarize(this.requests, (s) => s.totalMs),
          transport: summarize(transport),
          recentModel: summarize(recent(modelSamples, 15 * 60 * 1000)),
        },
        slowest,
        counts: {
          modelCalls: modelSamples.length,
          toolCalls: this.tool.length,
          consoleRequests: this.requests.length,
          // Tool calls per request is only meaningful once we have both.
          toolsPerRequest:
            this.requests.length > 0 ? this.tool.length / this.requests.length : null,
        },
        payload: {
          requestBytes: summarize(modelSamples, (s) => s.requestBytes),
          responseBytes: summarize(modelSamples, (s) => s.responseBytes),
        },
      },
      'metrics',
      null,
    );
  }
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
