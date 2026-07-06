export const FBRAIN_MCP_READ_TOOL_NAMES = [
  "fbrain_search",
  "fbrain_ask",
  "fbrain_get",
  "fbrain_list",
  "fbrain_backlinks",
] as const;

export const FBRAIN_MCP_WRITE_TOOL_NAMES = [
  "fbrain_put",
  "fbrain_status",
  "fbrain_append",
  "fbrain_delete",
  "fbrain_link",
] as const;

export const FBRAIN_MCP_TOOL_NAMES = [
  ...FBRAIN_MCP_READ_TOOL_NAMES,
  ...FBRAIN_MCP_WRITE_TOOL_NAMES,
] as const;
