import type { LanguageRuleSet } from '../types';

/**
 * Node.js / TypeScript entry-point detection.
 *
 * Express / Fastify / NestJS / tRPC for HTTP; oclif / commander.js for CLI;
 * BullMQ / agenda for background workers; library facades for `public_api`.
 */
export const NODE_RULES: LanguageRuleSet = {
  family: 'node',
  displayName: 'Node.js / TypeScript',
  kinds: {
    http_endpoint:
      'Express / Fastify router class with `router.get` / `app.post` calls. NestJS controller with `@Controller` / `@Get` / `@Post` decorators. tRPC procedure router. Hono / Koa route registration class.',
    cli_main:
      'oclif `Command` subclass with a `run()` method. commander.js / yargs root with `program.command(...)` calls. A `bin/*.ts` entry script registered in `package.json#bin`.',
    worker:
      'BullMQ `Worker` instantiation class. Agenda job definition class. Bee-Queue worker. A long-running `cron` job class.',
    public_api:
      'Library facade class re-exported from the package `index.ts` — **only when the package lives OUTSIDE any `apps/` directory** (see "Public API hardening" below).',
  },
};
