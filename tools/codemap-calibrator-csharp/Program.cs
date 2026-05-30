using System.Diagnostics;
using Newtonsoft.Json;
using Newtonsoft.Json.Serialization;
using StreamJsonRpc;

namespace CodeMap.Calibrator;

// Phase 2.1 — JSON-RPC skeleton. Only `initialize` / `shutdown` / `ping`
// are wired here; Roslyn + slnx loading land in Phase 2.2.
//
// Transport is stdin/stdout LSP-style framed messages (HeaderDelimitedMessageHandler
// + JsonMessageFormatter), so the extension host can spawn this process and
// speak StreamJsonRpc directly without picking a port.
//
// All diagnostic output goes to stderr; stdout is reserved for JSON-RPC
// framing. A stray `Console.WriteLine` on stdout would break the protocol,
// so the entry point swaps stdout for stderr immediately after capturing
// the real one for the rpc handler.

internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        // Capture the real stdout BEFORE redirecting; the rpc handler needs
        // the unredirected stream for framed JSON. Any Console.Write* call
        // after this will land on stderr, which is safe to log to.
        var stdoutRaw = Console.OpenStandardOutput();
        var stdinRaw = Console.OpenStandardInput();
        Console.SetOut(Console.Error);

        Log($"codemap-calibrator-csharp starting (pid={Environment.ProcessId}, args=[{string.Join(' ', args)}])");

        var formatter = new JsonMessageFormatter();
        // Force camelCase on the wire (both directions) so the TypeScript
        // host sees idiomatic JSON-RPC payloads. Deserialization is
        // case-insensitive by default, so PascalCase requests still bind.
        formatter.JsonSerializer.ContractResolver = new CamelCasePropertyNamesContractResolver();
        formatter.JsonSerializer.NullValueHandling = NullValueHandling.Ignore;
        var handler = new HeaderDelimitedMessageHandler(stdoutRaw, stdinRaw, formatter);

        var service = new CalibratorService();
        using var rpc = new JsonRpc(handler);
        // Skip auto-wiring of CalibratorService's events as JSON-RPC notifications;
        // we use `OnShutdownRequested` purely for in-process coordination, and
        // StreamJsonRpc's default event scanner rejects 0-arg delegates anyway.
        rpc.AddLocalRpcTarget(service, new JsonRpcTargetOptions { NotifyClientOfEvents = false });
        rpc.TraceSource = new TraceSource("codemap.calibrator", SourceLevels.Warning);
        rpc.TraceSource.Listeners.Add(new TextWriterTraceListener(Console.Error));

        service.OnShutdownRequested += () =>
        {
            Log("shutdown requested, completing rpc");
            rpc.Dispose();
        };

        rpc.StartListening();
        Log("rpc listening on stdin/stdout");

        try
        {
            await rpc.Completion.ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // graceful shutdown, swallow
        }
        catch (Exception ex)
        {
            Log($"rpc completion threw: {ex.GetType().Name}: {ex.Message}");
            return 1;
        }

        Log("exiting cleanly");
        return 0;
    }

    private static void Log(string message)
    {
        Console.Error.WriteLine($"[calibrator] {message}");
    }
}
