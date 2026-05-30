using System.Diagnostics;
using System.Xml.Linq;
using Microsoft.Build.Locator;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.MSBuild;

namespace CodeMap.Calibrator;

// Owns the singleton MSBuildWorkspace and the .slnx -> projects fan-out.
// Implements the R2 spike conclusion (ADR-005 sec.7.2): Roslyn 4.11's
// MSBuildWorkspace.OpenSolutionAsync rejects .slnx with
// InvalidProjectFileException("No file format header found"), so we parse
// the slnx XML ourselves and call OpenProjectAsync per <Project Path="..."/>.
// Transitive P2P references load implicitly; duplicate OpenProjectAsync
// throws ArgumentException which we treat as benign (project already in).
internal sealed class WorkspaceHost : IAsyncDisposable
{
    private static readonly object _locatorGate = new();
    private static bool _locatorRegistered;

    private MSBuildWorkspace? _workspace;
    private readonly List<string> _workspaceFailures = new();

    public bool IsLoaded => _workspace is not null;

    public async Task<LoadSolutionResult> LoadSolutionAsync(string slnxPath, CancellationToken ct)
    {
        if (!File.Exists(slnxPath))
        {
            throw new FileNotFoundException($"slnx file not found: {slnxPath}", slnxPath);
        }
        if (!slnxPath.EndsWith(".slnx", StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException($"expected .slnx, got: {slnxPath}", nameof(slnxPath));
        }

        EnsureMsbuildLocatorRegistered();

        var sw = Stopwatch.StartNew();
        var workspace = _workspace ??= CreateWorkspace();

        var slnxDir = Path.GetDirectoryName(Path.GetFullPath(slnxPath))!;
        var doc = XDocument.Load(slnxPath);
        var declared = new List<string>();
        var loaded = new List<string>();
        var skipped = new List<SkippedProject>();

        foreach (var node in doc.Descendants("Project"))
        {
            var rel = node.Attribute("Path")?.Value;
            if (string.IsNullOrWhiteSpace(rel)) continue;
            var csproj = Path.GetFullPath(Path.Combine(slnxDir, rel));
            declared.Add(rel);

            if (!File.Exists(csproj))
            {
                skipped.Add(new SkippedProject(rel, "csproj not found on disk"));
                continue;
            }

            try
            {
                ct.ThrowIfCancellationRequested();
                await workspace.OpenProjectAsync(csproj, cancellationToken: ct).ConfigureAwait(false);
                loaded.Add(rel);
            }
            catch (ArgumentException ex) when (ex.Message.Contains("already", StringComparison.OrdinalIgnoreCase))
            {
                // Already loaded transitively via a P2P reference -- benign.
                skipped.Add(new SkippedProject(rel, "already loaded transitively"));
            }
        }

        sw.Stop();

        var solution = workspace.CurrentSolution;
        var projects = solution.Projects
            .OrderBy(p => p.Name, StringComparer.Ordinal)
            .Select(p => new LoadedProject(p.Name, p.FilePath ?? "", p.Language, p.AssemblyName))
            .ToList();

        var diagnostics = _workspaceFailures.ToList();
        _workspaceFailures.Clear();

        return new LoadSolutionResult(
            SlnxPath: slnxPath,
            DeclaredProjectCount: declared.Count,
            LoadedProjectCount: loaded.Count,
            DistinctProjectCount: projects.Count,
            Projects: projects,
            Skipped: skipped,
            Diagnostics: diagnostics,
            ElapsedMs: sw.ElapsedMilliseconds);
    }

    public async ValueTask DisposeAsync()
    {
        if (_workspace is { } ws)
        {
            ws.WorkspaceFailed -= OnWorkspaceFailed;
            ws.Dispose();
            _workspace = null;
        }
        await Task.CompletedTask;
    }

    private MSBuildWorkspace CreateWorkspace()
    {
        var ws = MSBuildWorkspace.Create();
        ws.LoadMetadataForReferencedProjects = true;
        ws.SkipUnrecognizedProjects = true;
        ws.WorkspaceFailed += OnWorkspaceFailed;
        return ws;
    }

    private void OnWorkspaceFailed(object? sender, WorkspaceDiagnosticEventArgs e)
    {
        // Roslyn surfaces non-fatal issues (missing analyzer, target framework
        // pack absent, etc.) through this event. We collect them so the host
        // can log them via JSON-RPC notifications -- never throw on the rpc
        // path because Roslyn keeps the workspace usable after most of these.
        _workspaceFailures.Add($"{e.Diagnostic.Kind}: {e.Diagnostic.Message}");
    }

    private static void EnsureMsbuildLocatorRegistered()
    {
        lock (_locatorGate)
        {
            if (_locatorRegistered) return;
            // RegisterDefaults picks the highest installed SDK matching the
            // runtime that loaded us. We pin via global.json so this resolves
            // to 8.0.407 (or the rollForward latestFeature winner).
            MSBuildLocator.RegisterDefaults();
            _locatorRegistered = true;
        }
    }
}

public sealed record LoadSolutionParams(string SlnxPath);

public sealed record LoadSolutionResult(
    string SlnxPath,
    int DeclaredProjectCount,
    int LoadedProjectCount,
    int DistinctProjectCount,
    IReadOnlyList<LoadedProject> Projects,
    IReadOnlyList<SkippedProject> Skipped,
    IReadOnlyList<string> Diagnostics,
    long ElapsedMs);

public sealed record LoadedProject(string Name, string FilePath, string Language, string AssemblyName);
public sealed record SkippedProject(string Path, string Reason);
