/**
 * A minimal MCP server over stdio: newline-delimited JSON-RPC 2.0, tools only.
 *
 * No dependencies, so the plugin runs on the agent image's Bun as shipped and
 * nothing is installed at stamp time.
 */

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

/** An error the agent should see as a tool failure with this message. */
export class ToolError extends Error {}

const PROTOCOL_VERSION = '2025-06-18';

interface Request {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export class StdioServer {
  constructor(
    private readonly name: string,
    private readonly version: string,
    private readonly instructions: string,
    private readonly tools: ToolSpec[],
  ) {}

  /** Handle one parsed message; returns the response, or null for a notification. */
  async handle(msg: Request): Promise<Record<string, unknown> | null> {
    if (msg.id === undefined || msg.id === null) return null;
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });

    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        return ok({
          protocolVersion: typeof asked === 'string' ? asked : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: this.name, version: this.version },
          instructions: this.instructions,
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({
          tools: this.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
      case 'tools/call': {
        const name = msg.params?.name;
        const tool = this.tools.find((t) => t.name === name);
        if (!tool) return fail(-32602, `Unknown tool: ${String(name)}`);
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        const missing = ((tool.inputSchema.required as string[] | undefined) ?? []).filter(
          (k) => args[k] === undefined || args[k] === null,
        );
        if (missing.length) return ok(errorResult(`Missing required argument(s): ${missing.join(', ')}`));
        try {
          const value = await tool.run(args);
          const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
          return ok({ content: [{ type: 'text', text }], isError: false });
        } catch (err) {
          return ok(errorResult(err instanceof Error ? err.message : String(err)));
        }
      }
      default:
        return fail(-32601, `Method not found: ${msg.method}`);
    }
  }

  /** Read stdin line by line until it closes. */
  async serve(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of Bun.stdin.stream()) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) await this.handleLine(line);
      }
    }
  }

  private async handleLine(line: string): Promise<void> {
    let msg: Request;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const response = await this.handle(msg);
    if (response) write(response);
  }
}

function errorResult(message: string) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function write(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
