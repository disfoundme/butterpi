// Permissive upstream stub for the vendored dsh-TUI tree (see src/vendor/README.md).
// Everything is a self-referential callable/constructible proxy so that value
// imports, `new X()`, `class Y extends X`, and `X.field` all succeed.
const fn = function () {}
const stub = new Proxy(fn, {
  get(t, p) {
    if (p === 'then') return undefined              // stay non-thenable for await
    if (p === Symbol.toPrimitive) return () => ''   // safe in string/number ctx
    if (p === Symbol.iterator) return function* () {} // empty iteration
    return stub
  },
  apply() { return stub },
  construct() { return new Proxy({}, { get(t, p) { if (p === 'then') return undefined; return stub } }) },
})
export default stub

export const AssistantStreamRecord = stub
export const BlockAssembler = stub
export const ContentBlock = stub
export const LlmConfigurableProvider = stub
export const LlmDiscoveredModel = stub
export const LlmModelInfo = stub
export const LlmProviderInfo = stub
export const Message = stub
export const MessageId = stub
export const ReasoningBlock = stub
export const ReasoningEffortId = stub
export const StreamChunk = stub
export const TextBlock = stub
export const TimedStreamChunk = stub
export const UserMessage = stub
export const createAssistantMessage = stub
export const createUserMessage = stub
export const MessageSourceMap = stub
