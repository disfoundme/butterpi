// Permissive stub types (see src/vendor/README.md).
// Schemastery's default export is used as both a callable value (Schema.string())
// and a generic type (Schema<T, R>) by dsh-adapter/compat/settings.ts.
// `dict` needs `any` values so `.meta`/`.volatile` accesses type-check.
export declare const Schema: any
export type Schema<A = any, B = any, C = any> = {
  dict?: Record<string, any>
  meta?: any
  [key: string]: any
}
export default Schema
