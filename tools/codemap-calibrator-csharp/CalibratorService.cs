using StreamJsonRpc;

namespace CodeMap.Calibrator;

// CalibratorService — Phase 2.1 surface only: `initialize`, `shutdown`, `ping`.
// Method names use camelCase per JSON-RPC convention and the v4-plan §2.4
// CalibratorRequest contract; the host can map TypeScript camelCase callers
// without an extra dispatch layer.

public sealed class CalibratorService
{
    /// <summary>Fired when a client invokes <see cref="Shutdown"/>.</summary>
    public event Action? OnShutdownRequested;

    private readonly WorkspaceHost _workspaceHost = new();
    private InitializeResult? _initialized;

    [JsonRpcMethod("initialize", UseSingleObjectParameterDeserialization = true)]
    public InitializeResult Initialize(InitializeParams @params)
    {
        // Idempotent: re-running initialize with the same params is a no-op.
        // A different workspaceRoot is allowed (resets the host's view) so
        // the extension can survive workspace folder reconfiguration.
        var result = new InitializeResult(
            ServerName: "codemap-calibrator-csharp",
            ServerVersion: ThisAssemblyVersion(),
            ProtocolVersion: 1,
            Capabilities: new ServerCapabilities(
                SlnxLoading: true,
                ResolveCallees: false       // Phase 2.3
            )
        );
        _initialized = result;
        return result;
    }

    [JsonRpcMethod("ping", UseSingleObjectParameterDeserialization = true)]
    public PingResult Ping(PingParams? @params = null)
    {
        // Liveness probe — no side effects, no initialized-state requirement,
        // safe to call before/after initialize. The echoed token lets the
        // host detect a process restart that happens to keep the pipe.
        return new PingResult(
            Echo: @params?.Token ?? string.Empty,
            ServerTimestampMs: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Initialized: _initialized is not null
        );
    }

    [JsonRpcMethod("loadSolution", UseSingleObjectParameterDeserialization = true)]
    public Task<LoadSolutionResult> LoadSolutionAsync(LoadSolutionParams @params, CancellationToken ct)
    {
        if (@params is null) throw new ArgumentNullException(nameof(@params));
        if (string.IsNullOrWhiteSpace(@params.SlnxPath))
        {
            throw new ArgumentException("slnxPath is required", nameof(@params));
        }
        return _workspaceHost.LoadSolutionAsync(@params.SlnxPath, ct);
    }

    [JsonRpcMethod("shutdown")]
    public ShutdownResult Shutdown()
    {
        // Cooperative shutdown: respond first so the client sees the result,
        // then fire the event so Program.cs can dispose the rpc instance.
        // We hand off the dispose to a fire-and-forget task with a small
        // yield so StreamJsonRpc finishes writing this reply to stdout
        // before the pipe is torn down.
        _ = Task.Run(async () =>
        {
            await Task.Delay(50).ConfigureAwait(false);
            await _workspaceHost.DisposeAsync().ConfigureAwait(false);
            OnShutdownRequested?.Invoke();
        });
        return new ShutdownResult(Accepted: true);
    }

    private static string ThisAssemblyVersion()
    {
        var asm = typeof(CalibratorService).Assembly;
        return asm.GetName().Version?.ToString() ?? "0.0.0";
    }
}

public sealed record InitializeParams(string? WorkspaceRoot, string? ClientName);
public sealed record InitializeResult(
    string ServerName,
    string ServerVersion,
    int ProtocolVersion,
    ServerCapabilities Capabilities);
public sealed record ServerCapabilities(bool SlnxLoading, bool ResolveCallees);

public sealed record PingParams(string? Token);
public sealed record PingResult(string Echo, long ServerTimestampMs, bool Initialized);

public sealed record ShutdownResult(bool Accepted);
