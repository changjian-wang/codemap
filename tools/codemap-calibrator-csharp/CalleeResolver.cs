using System.Diagnostics;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CodeMap.Calibrator;

// Phase 2.3 -- resolveCallees(file, line, classId, methodName) -> Callee[].
//
// Strategy:
//   1. Find the Roslyn Document whose FilePath matches the request (case
//      insensitive). If the file isn't in the loaded solution we fail
//      cleanly -- the host should have called loadSolution first.
//   2. Locate the MethodDeclarationSyntax by methodName (Identifier text)
//      + container type (matches classId either as simple or fully
//      qualified name) + the requested line falling inside the method's
//      declaration span. The line bound is what lets us disambiguate
//      overloads without asking the client to pass a signature.
//   3. For every InvocationExpressionSyntax inside the method body,
//      ask the SemanticModel for the symbol and project it into a Callee.
//      Per v4-plan Phase 2.3 acceptance, we ONLY visit invocations --
//      object creation, property reads, etc. are explicitly out of scope.
internal static class CalleeResolver
{
    public static async Task<ResolveCalleesResult> ResolveAsync(
        Solution solution,
        ResolveCalleesParams request,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.FilePath))
            throw new ArgumentException("filePath is required", nameof(request));
        if (request.Line <= 0)
            throw new ArgumentException("line must be 1-based and positive", nameof(request));
        if (string.IsNullOrWhiteSpace(request.MethodName))
            throw new ArgumentException("methodName is required", nameof(request));

        var sw = Stopwatch.StartNew();

        var document = FindDocument(solution, request.FilePath)
            ?? throw new InvalidOperationException(
                $"file not in loaded solution: {request.FilePath}");

        var syntaxRoot = await document.GetSyntaxRootAsync(ct).ConfigureAwait(false)
            ?? throw new InvalidOperationException(
                $"could not load syntax tree for {request.FilePath}");
        var semanticModel = await document.GetSemanticModelAsync(ct).ConfigureAwait(false)
            ?? throw new InvalidOperationException(
                $"could not load semantic model for {request.FilePath}");

        var method = FindMethod(syntaxRoot, request)
            ?? throw new InvalidOperationException(
                $"method not found: {request.ClassId}.{request.MethodName} @ {request.FilePath}:{request.Line}");

        var methodSymbol = semanticModel.GetDeclaredSymbol(method, ct) as IMethodSymbol;
        var methodFqn = methodSymbol?.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)
            ?? $"{request.ClassId}.{request.MethodName}";

        var callees = new List<Callee>();
        var body = (SyntaxNode?)method.Body ?? method.ExpressionBody;
        if (body is not null)
        {
            foreach (var invocation in body.DescendantNodes().OfType<InvocationExpressionSyntax>())
            {
                ct.ThrowIfCancellationRequested();
                var callee = ProjectInvocation(invocation, semanticModel, ct);
                if (callee is not null) callees.Add(callee);
            }
        }

        sw.Stop();

        return new ResolveCalleesResult(
            FilePath: request.FilePath,
            ClassId: request.ClassId,
            MethodName: request.MethodName,
            MethodFullyQualifiedName: methodFqn,
            Callees: callees,
            ElapsedMs: sw.ElapsedMilliseconds);
    }

    private static Document? FindDocument(Solution solution, string filePath)
    {
        var full = Path.GetFullPath(filePath);
        // Two passes: exact match first, then case-insensitive. macOS / Windows
        // typically need the second pass; Linux usually hits the first.
        foreach (var project in solution.Projects)
        {
            foreach (var doc in project.Documents)
            {
                if (doc.FilePath is null) continue;
                if (string.Equals(doc.FilePath, full, StringComparison.Ordinal))
                    return doc;
            }
        }
        foreach (var project in solution.Projects)
        {
            foreach (var doc in project.Documents)
            {
                if (doc.FilePath is null) continue;
                if (string.Equals(doc.FilePath, full, StringComparison.OrdinalIgnoreCase))
                    return doc;
            }
        }
        return null;
    }

    private static MethodDeclarationSyntax? FindMethod(SyntaxNode root, ResolveCalleesParams req)
    {
        // We accept classId as either the simple name ("RecallByQueryHandler")
        // or the fully qualified name ("Lumen.Modules.Recall.Features.
        // RecallByQuery.RecallByQueryHandler"). The simple-name match is the
        // common case for the orchestrator since v2 ids are simple.
        var candidates = root.DescendantNodes()
            .OfType<MethodDeclarationSyntax>()
            .Where(m => string.Equals(m.Identifier.ValueText, req.MethodName, StringComparison.Ordinal))
            .Where(m => MatchesClass(m, req.ClassId))
            .ToList();

        if (candidates.Count == 0) return null;
        if (candidates.Count == 1) return candidates[0];

        // Overload resolution: pick the method whose declaration span covers
        // the requested line; fall back to the closest start-line if none
        // strictly covers it.
        var byLine = candidates
            .Select(m => new { Method = m, Span = m.GetLocation().GetLineSpan() })
            .Select(x => new
            {
                x.Method,
                StartLine = x.Span.StartLinePosition.Line + 1,
                EndLine = x.Span.EndLinePosition.Line + 1,
            })
            .ToList();

        var covering = byLine.FirstOrDefault(x => req.Line >= x.StartLine && req.Line <= x.EndLine);
        if (covering is not null) return covering.Method;

        return byLine.OrderBy(x => Math.Abs(x.StartLine - req.Line)).First().Method;
    }

    private static bool MatchesClass(MethodDeclarationSyntax method, string classId)
    {
        if (string.IsNullOrWhiteSpace(classId)) return true;
        var owner = method.Parent as TypeDeclarationSyntax;
        if (owner is null) return false;
        if (string.Equals(owner.Identifier.ValueText, classId, StringComparison.Ordinal))
            return true;

        // Fully qualified compare: walk namespace ancestors and prepend.
        var qualified = BuildQualifiedTypeName(owner);
        return string.Equals(qualified, classId, StringComparison.Ordinal)
            || qualified.EndsWith("." + classId, StringComparison.Ordinal);
    }

    private static string BuildQualifiedTypeName(TypeDeclarationSyntax type)
    {
        var parts = new List<string> { type.Identifier.ValueText };
        SyntaxNode? cursor = type.Parent;
        while (cursor is not null)
        {
            switch (cursor)
            {
                case TypeDeclarationSyntax outer:
                    parts.Insert(0, outer.Identifier.ValueText);
                    break;
                case BaseNamespaceDeclarationSyntax ns:
                    parts.Insert(0, ns.Name.ToString());
                    break;
            }
            cursor = cursor.Parent;
        }
        return string.Join(".", parts);
    }

    private static Callee? ProjectInvocation(
        InvocationExpressionSyntax invocation,
        SemanticModel model,
        CancellationToken ct)
    {
        var info = model.GetSymbolInfo(invocation, ct);
        var symbol = info.Symbol ?? info.CandidateSymbols.FirstOrDefault();

        var lineSpan = invocation.GetLocation().GetLineSpan();
        var invocationLine = lineSpan.StartLinePosition.Line + 1;

        if (symbol is null)
        {
            // Unresolved (e.g. missing assembly reference or syntax error
            // upstream). Emit a stub so the host can show "unverified" rather
            // than silently dropping the call.
            return new Callee(
                DisplayName: invocation.Expression.ToString(),
                FullyQualifiedName: invocation.Expression.ToString(),
                ContainingType: string.Empty,
                MethodName: invocation.Expression switch
                {
                    MemberAccessExpressionSyntax m => m.Name.Identifier.ValueText,
                    IdentifierNameSyntax i => i.Identifier.ValueText,
                    _ => invocation.Expression.ToString(),
                },
                Kind: "unknown",
                IsExternal: true,
                IsExtension: false,
                FilePath: null,
                Line: null,
                InvocationLine: invocationLine);
        }

        if (symbol is not IMethodSymbol method)
        {
            return new Callee(
                DisplayName: symbol.ToDisplayString(),
                FullyQualifiedName: symbol.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat),
                ContainingType: symbol.ContainingType?.ToDisplayString() ?? string.Empty,
                MethodName: symbol.Name,
                Kind: symbol.Kind.ToString().ToLowerInvariant(),
                IsExternal: symbol.Locations.All(l => l.IsInMetadata),
                IsExtension: false,
                FilePath: null,
                Line: null,
                InvocationLine: invocationLine);
        }

        // For overrides / interface impls reduce to the original definition
        // -- that's what the orchestrator wants to draw an edge to.
        var canonical = method.OriginalDefinition;
        var declLocation = canonical.Locations.FirstOrDefault(l => l.IsInSource);
        var declSpan = declLocation?.GetLineSpan();

        return new Callee(
            DisplayName: canonical.ToDisplayString(),
            FullyQualifiedName: canonical.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat),
            ContainingType: canonical.ContainingType?.ToDisplayString() ?? string.Empty,
            MethodName: canonical.Name,
            Kind: canonical.MethodKind switch
            {
                MethodKind.Constructor => "constructor",
                MethodKind.LocalFunction => "localFunction",
                MethodKind.ReducedExtension => "extension",
                _ => "method",
            },
            IsExternal: canonical.Locations.All(l => l.IsInMetadata),
            IsExtension: canonical.IsExtensionMethod || canonical.MethodKind == MethodKind.ReducedExtension,
            FilePath: declLocation?.SourceTree?.FilePath,
            Line: declSpan is { } s ? s.StartLinePosition.Line + 1 : null,
            InvocationLine: invocationLine);
    }
}

public sealed record ResolveCalleesParams(
    string FilePath,
    int Line,
    string ClassId,
    string MethodName);

public sealed record ResolveCalleesResult(
    string FilePath,
    string ClassId,
    string MethodName,
    string MethodFullyQualifiedName,
    IReadOnlyList<Callee> Callees,
    long ElapsedMs);

public sealed record Callee(
    string DisplayName,
    string FullyQualifiedName,
    string ContainingType,
    string MethodName,
    string Kind,
    bool IsExternal,
    bool IsExtension,
    string? FilePath,
    int? Line,
    int InvocationLine);
