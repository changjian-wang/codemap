import type { LanguageRuleSet } from '../types';

/**
 * Python entry-point detection.
 *
 * Covers FastAPI / Flask / Django / Starlette routers, Click / Typer CLIs,
 * Celery / APScheduler workers, and package facades. `__main__.py` and the
 * top-level `if __name__ == "__main__":` idiom both produce a synthesized
 * entry — see the Synthesized Program rule in universal.ts.
 */
export const PYTHON_RULES: LanguageRuleSet = {
  family: 'python',
  displayName: 'Python',
  kinds: {
    http_endpoint:
      'FastAPI / Starlette router class with `@router.get` / `@app.post` decorators. Flask `Blueprint`. Django view class with `urlpatterns` / `path(...)` registration. aiohttp route table.',
    cli_main:
      'Module containing `if __name__ == "__main__":` at the bottom (synthesize a Program node — see below). `@click.group()` / `@click.command()` decorated class. Typer `app = typer.Typer()` module facade.',
    worker:
      'Celery `@task` decorated class. APScheduler `BackgroundScheduler` job. asyncio worker class with a long-running `run()` coroutine.',
    public_api:
      'Package facade class exported via `__all__` from a top-level `__init__.py` — **only when the package lives OUTSIDE any `apps/` directory** (see "Public API hardening" below).',
  },
};
