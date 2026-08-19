/**
 * Branded (nominal) identity type for a plan item id.
 *
 * An id string (`PlanItem.id`, a `requires` entry, an `itemId` param) is
 * easy to pass to the wrong place with no compiler complaint today. The
 * brand is compile-time only — storage/wire representation stays a plain
 * string — and `asNodeId` does no validation beyond the brand: the string
 * is already trusted at the point it's minted (e.g. straight from
 * `generateId()`).
 */
export type NodeId = string & { readonly __brand: "NodeId" };

export function asNodeId(raw: string): NodeId {
  return raw as NodeId;
}
