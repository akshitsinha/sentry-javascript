import { tracingChannel } from 'node:diagnostics_channel';
import * as Sentry from '@sentry/cloudflare';

interface Config {
  host: string;
  port: number;
  database: string;
  user: string;
}

// Faking the mysql query call to no include the entire mysql package.
// This wouldn't work if only the packages were instrumented that are actually used in the code.
function runQuery(sql: string, config: Config): Promise<void> {
  const channel = tracingChannel('orchestrion:mysql:query');
  const connection = { config };
  return new Promise<void>((resolve, reject) => {
    channel.traceCallback(
      (cb: (err: unknown) => void) => queueMicrotask(() => cb(null)),
      0,
      { arguments: [sql], self: connection },
      connection,
      (err: unknown) => (err ? reject(err) : resolve()),
    );
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const config: Config = { host: '127.0.0.1', port: 3306, database: 'testdb', user: 'root' };

    if (url.pathname === '/test-mysql-channel') {
      await runQuery('SELECT 1 + 1 AS solution', config);

      return Response.json({ status: 'ok' });
    }

    if (url.pathname === '/test-nested-mysql-channel') {
      // Second query runs inside the first's callback — proves the parent span
      // context is restored across the async boundary so both `db` spans land on
      // the same `http.server` transaction.
      await Sentry.startSpan(
        {
          name: 'test-nested-mysql-channel',
        },
        async () => {
          await runQuery('SELECT 1 + 1 AS solution', config);
          await runQuery('SELECT NOW()', config);
        },
      );

      return Response.json({ status: 'ok' });
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
