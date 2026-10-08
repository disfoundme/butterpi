// Stub for #dsh-ecosystem-spec/profile-definitions (git submodule, absent here).
// Only the names that adapter/spec/tui-contributions.ts re-exports need to exist.
const stub = new Proxy(function () {}, {
  get(t, p) { if (p === 'then') return undefined; return stub },
  apply() { return stub },
  construct() { return new Proxy({}, { get(t, p) { return p === 'then' ? undefined : stub } }) },
})
export const DECISION_EVENTS = stub
export const decisionEventsDefinition = stub
export const profileDefinitions = stub
export function registerProfileProtocols() {}
export const tuiChannelDefinition = stub
export const TUI_CHANNEL = stub
export const TUI_CHANNEL_FEATURES = stub
export const TUI_CHANNEL_WIRE_REVISION = stub
export default stub
export const validateTuiChannelInput = stub
export const validateTuiChannelOutput = stub
export const validateTuiChannelSnapshot = stub
