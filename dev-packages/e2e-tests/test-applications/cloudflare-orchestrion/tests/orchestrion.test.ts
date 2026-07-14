import { expect, test } from '@playwright/test';
import { waitForTransaction } from '@sentry-internal/test-utils';

test('orchestrion mysql channel produces a db span with correct attributes', async ({ baseURL }) => {
  const transactionPromise = waitForTransaction('cloudflare-orchestrion', event => {
    return (
      event?.contexts?.trace?.op === 'http.server' &&
      (event.request?.url ?? '').includes('/test-mysql-channel') &&
      (event.spans?.some(span => span.op === 'db') ?? false)
    );
  });

  const res = await fetch(`${baseURL}/test-mysql-channel`);
  expect(res.status).toBe(200);

  const transaction = await transactionPromise;

  expect(transaction).toEqual(
    expect.objectContaining({
      transaction: 'GET /test-mysql-channel',
      type: 'transaction',
      contexts: expect.objectContaining({
        trace: expect.objectContaining({
          op: 'http.server',
          span_id: expect.stringMatching(/[a-f0-9]{16}/),
          trace_id: expect.stringMatching(/[a-f0-9]{32}/),
        }),
      }),
      spans: [
        {
          description: 'SELECT 1 + 1 AS solution',
          op: 'db',
          origin: 'auto.db.orchestrion.mysql',
          data: {
            'db.system': 'mysql',
            'sentry.origin': 'auto.db.orchestrion.mysql',
            'sentry.op': 'db',
            'db.connection_string': 'jdbc:mysql://127.0.0.1:3306/testdb',
            'db.name': 'testdb',
            'db.user': 'root',
            'db.statement': 'SELECT 1 + 1 AS solution',
            'net.peer.name': '127.0.0.1',
            'net.peer.port': 3306,
          },
          parent_span_id: expect.stringMatching(/[a-f0-9]{16}/),
          span_id: expect.stringMatching(/[a-f0-9]{16}/),
          start_timestamp: expect.any(Number),
          timestamp: expect.any(Number),
          trace_id: expect.stringMatching(/[a-f0-9]{32}/),
        },
      ],
    }),
  );
});

test('nested queries land on the same transaction with a parent span', async ({ baseURL }) => {
  const transactionPromise = waitForTransaction('cloudflare-orchestrion', event => {
    return (
      event?.contexts?.trace?.op === 'http.server' &&
      (event.request?.url ?? '').includes('/test-nested-mysql-channel') &&
      (event.spans?.filter(span => span.op === 'db').length ?? 0) >= 2
    );
  });

  const res = await fetch(`${baseURL}/test-nested-mysql-channel`);
  expect(res.status).toBe(200);

  const transaction = await transactionPromise;

  const dbSpanBase = {
    op: 'db',
    origin: 'auto.db.orchestrion.mysql',
    data: expect.objectContaining({
      'db.system': 'mysql',
      'sentry.origin': 'auto.db.orchestrion.mysql',
      'sentry.op': 'db',
      'db.connection_string': 'jdbc:mysql://127.0.0.1:3306/testdb',
      'db.name': 'testdb',
      'db.user': 'root',
      'net.peer.name': '127.0.0.1',
      'net.peer.port': 3306,
    }),
    parent_span_id: expect.stringMatching(/[a-f0-9]{16}/),
    span_id: expect.stringMatching(/[a-f0-9]{16}/),
    start_timestamp: expect.any(Number),
    timestamp: expect.any(Number),
    trace_id: expect.stringMatching(/[a-f0-9]{32}/),
  };

  expect(transaction).toEqual(
    expect.objectContaining({
      transaction: 'GET /test-nested-mysql-channel',
      type: 'transaction',
      contexts: expect.objectContaining({
        trace: expect.objectContaining({
          op: 'http.server',
          span_id: expect.stringMatching(/[a-f0-9]{16}/),
          trace_id: expect.stringMatching(/[a-f0-9]{32}/),
        }),
      }),
      spans: expect.arrayContaining([
        {
          description: 'test-nested-mysql-channel',
          origin: 'manual',
          data: {
            'sentry.origin': 'manual',
          },
          parent_span_id: expect.stringMatching(/[a-f0-9]{16}/),
          span_id: expect.stringMatching(/[a-f0-9]{16}/),
          start_timestamp: expect.any(Number),
          timestamp: expect.any(Number),
          trace_id: expect.stringMatching(/[a-f0-9]{32}/),
        },
        expect.objectContaining({
          ...dbSpanBase,
          description: 'SELECT 1 + 1 AS solution',
        }),
        expect.objectContaining({
          ...dbSpanBase,
          description: 'SELECT NOW()',
        }),
      ]),
    }),
  );

  // Verify both db spans are children of the manual parent span
  const spans = transaction.spans!;
  const parentSpan = spans.find(s => s.description === 'test-nested-mysql-channel');
  expect(parentSpan).toBeDefined();

  const dbSpans = spans.filter(s => s.op === 'db');
  expect(dbSpans).toHaveLength(2);
  expect(dbSpans[0]!.parent_span_id).toBe(parentSpan!.span_id);
  expect(dbSpans[1]!.parent_span_id).toBe(parentSpan!.span_id);
});
