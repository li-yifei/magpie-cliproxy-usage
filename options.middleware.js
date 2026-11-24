// Enables Magpie's Plugins page Options editor for magpie-cliproxy-usage
// without executing on any gateway request or SSE event.
export const events = ['__magpie_cliproxy_usage_noop__']
export function onEvent() {}
