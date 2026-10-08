// Permissive stub types (see src/vendor/README.md).
// Context/Fiber/Service are interfaces so `declare module '@deepseek-ai/cordis'`
// augmentations in the vendored tree can merge.
// `get` mirrors real cordis: key-generic, so `ctx.get('tuiPluginHost')` returns
// the augmented member type and `ctx.get('other')` falls back to `any`. The
// `| undefined` keeps `ctx.get('x') === undefined` checks and `??=` narrowing
// legal — bare `any` would poison both.
export interface Context {
  get<K extends keyof this & string>(name: K): this[K] | undefined
  [key: string]: any
}
export declare const Context: { new (...args: any[]): Context; is(x: unknown): x is Context; [key: string]: any }
export interface Fiber { [key: string]: any }
export declare const Fiber: { new (...args: any[]): Fiber; is(x: unknown): x is Fiber; [key: string]: any }
export interface Service { [key: string]: any }
export declare const Service: { new (...args: any[]): Service; [key: string]: any }
declare const _default: any
export default _default
