// Shims for optional native deps with no bundled types — prevents LSP cold-neighbor
// cascade when the packages are present in node_modules but lack index.d.ts
// (NodeNext + skipLibCheck still surfaces “Missing declaration file” for bare specifiers).
// biome-ignore-all lint/suspicious/noExplicitAny: shim file — exact types are provided by the packages at runtime

declare module "wreq-js" {
  export const fetch: unknown;
  export const getProfiles: unknown;
  export function createSession(...args: unknown[]): unknown;
}

declare module "@modelcontextprotocol/sdk/server/index.js" {
  export class Server {}
}
declare module "@modelcontextprotocol/sdk/server/stdio.js" {
  export class StdioServerTransport {}
}
declare module "@modelcontextprotocol/sdk/types.js" {
  export const ListToolsRequestSchema: unknown;
  export const CallToolRequestSchema: unknown;
}
