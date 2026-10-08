// Permissive stub types (see src/vendor/README.md).
// Agent/AgentHandle/AssistantStreamFrame are interfaces (not `any` aliases):
// `any` would poison optional-chaining narrowings the vendored code relies on.
export interface Agent {
  ctx: any
  session: any
  followup(message: any): void
  [key: string]: any
}
export declare const Agent: any
export interface AgentHandle { dispose(): Promise<void>; [key: string]: any }
export declare const AgentHandle: any
export interface AssistantStreamFrame {
  type: string
  revision: number
  attemptId: string
  turn: number
  step: number
  outcome: any
  [key: string]: any
}
export declare const AssistantStreamFrame: any
export declare const AgentSetup: any
export type AgentSetup<A = any, B = any, C = any, D = any> = any
export declare const AgentStatus: any
export type AgentStatus<A = any, B = any, C = any, D = any> = any
export declare const CreateAgentOptions: any
export type CreateAgentOptions<A = any, B = any, C = any, D = any> = any
export declare const ModelSelectionRef: any
export type ModelSelectionRef<A = any, B = any, C = any, D = any> = any
export declare const assembleContextFor: any
declare const _default: any
export default _default
