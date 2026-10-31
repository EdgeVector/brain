export const BRAIN_MCP_READ_TOOL_NAMES = [
  "brain_search",
  "brain_ask",
  "brain_find",
  "brain_get",
  "brain_list",
  "brain_backlinks",
] as const;

export const BRAIN_MCP_WRITE_TOOL_NAMES = [
  "brain_put",
  "brain_status",
  "brain_append",
  "brain_tag",
  "brain_delete",
  "brain_link",
] as const;

export const BRAIN_MCP_TOOL_NAMES = [
  ...BRAIN_MCP_READ_TOOL_NAMES,
  ...BRAIN_MCP_WRITE_TOOL_NAMES,
] as const;
