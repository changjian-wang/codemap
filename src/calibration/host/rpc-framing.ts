// Phase 2.5 -- LSP-style JSON-RPC framing helpers shared between the
// calibrator host (src/calibration/host/csharp-host.ts) and the protocol
// integration tests (test/integration/*). Single implementation so framing
// bugs surface in one place rather than two.

export interface RpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export function encodeFrame(message: RpcMessage): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

export class FrameDecoder {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): RpcMessage[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: RpcMessage[] = [];
    while (true) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return out;
      const header = this.buf.subarray(0, headerEnd).toString('utf8');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        // Skip malformed frame; drop up to and including the header
        // terminator so the stream can recover.
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const len = parseInt(m[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + len) return out;
      const body = this.buf.subarray(bodyStart, bodyStart + len).toString('utf8');
      this.buf = this.buf.subarray(bodyStart + len);
      try {
        out.push(JSON.parse(body) as RpcMessage);
      } catch {
        // ignore non-JSON garbage
      }
    }
  }

  reset(): void {
    this.buf = Buffer.alloc(0);
  }
}
