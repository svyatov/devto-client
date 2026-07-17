/**
 * `{param}` names in a path template, in URL order — the single runtime+codegen
 * truth for positional order (KTD3), shared by the binder (`bindOps`) and the
 * signature generator so their orderings cannot drift. A dependency-free leaf so
 * the generator never imports the files it generates.
 */
export function pathParamNames(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string);
}
