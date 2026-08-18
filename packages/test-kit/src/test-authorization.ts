/**
 * TEST_ONLY grant minting. Not reachable through production package exports.
 */
import {
  issueAuthorizationOn,
  type IssueAuthorizationSpec,
  type AuthorizationGrant,
} from "../../harbor/src/agency.js";
import {
  getDefaultGrantRegistry,
  type DurableGrantRegistry,
} from "../../harbor/src/grant-registry.js";
import type { HarborActor } from "../../harbor/src/types.js";

export function issueTestAuthorization(
  granter: HarborActor,
  spec: IssueAuthorizationSpec,
  registry: DurableGrantRegistry = getDefaultGrantRegistry()
): AuthorizationGrant {
  return issueAuthorizationOn(registry, granter, spec);
}
