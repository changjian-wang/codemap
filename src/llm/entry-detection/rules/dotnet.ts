import type { LanguageRuleSet } from '../types';

/**
 * .NET / C# entry-point detection.
 *
 * Coverage:
 *   - ASP.NET Core minimal API + MVC + gRPC services
 *   - Console host bootstrap (top-level statements OR `Main`)
 *   - `System.CommandLine` root commands
 *   - `BackgroundService` / `IHostedService` / Quartz / Hangfire workers
 *   - Library `*Extensions` classes — but only when outside `apps/`
 *     (universal hardening rule pins this down further)
 *
 * No file in `apps/api/src/.../*ServiceCollectionExtensions.cs` should
 * pass — they're app-internal DI wiring; the v3.5 spike on lumen tagged
 * 4 of them as `public_api`, which is the regression v3.6 fixes.
 */
export const DOTNET_RULES: LanguageRuleSet = {
  family: 'dotnet',
  displayName: '.NET / C#',
  kinds: {
    http_endpoint:
      'ASP.NET Core minimal-API endpoint class with `MapGet` / `MapPost` / `MapPut` / `MapDelete` / `MapPatch` calls (often named `*Endpoints` with a `MapXxxRoutes(IEndpointRouteBuilder)` extension). MVC controller deriving from `ControllerBase` / `Controller` with `[HttpGet]` / `[HttpPost]` / `[Route]` attributes. gRPC service deriving from a generated `*Base` class.',
    cli_main:
      'Class with `static void Main(string[] args)` or `static async Task Main(string[] args)`. **Top-level statements** in `Program.cs` containing `WebApplication.CreateBuilder(args)`, `Host.CreateDefaultBuilder`, or `new RootCommand(...)` — see "Synthesized Program for top-level statements" below. `System.CommandLine` root command class.',
    worker:
      '`BackgroundService` or `IHostedService` implementation. Quartz.NET `IJob`. Hangfire job class with `[Queue]` / `RecurringJob.AddOrUpdate` registration.',
    public_api:
      'Static class whose primary value is `public static` extension methods (e.g. `ServiceCollectionExtensions` with `AddXxx(this IServiceCollection)`) — **only when the class lives OUTSIDE any `apps/` directory** (see "Public API hardening" below). Public facade / factory class meant to be instantiated directly by consumers from outside the workspace.',
  },
};
