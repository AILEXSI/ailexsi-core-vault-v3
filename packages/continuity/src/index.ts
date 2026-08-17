export type {
  ContinuityFieldClass,
  ContinuityFieldMeta,
  ContinuityMemoryFact,
  ContinuityPackage,
} from "./types.js";
export {
  buildContinuityPackage,
  serializeContinuity,
  parseContinuity,
  canonicalMemoryIds,
  type ContinuityBuildInput,
} from "./continuity-builder.js";

export {
  CONTINUITY_V1_SCHEMA,
  CONTINUITY_V1_KIND,
  buildContinuityPackageV1,
  serializeContinuityV1,
  parseContinuityV1,
  stripAuditOnly,
  packagesIdentityEqual,
  inspectContinuityV1,
  type ContinuityPackageV1,
  type ContinuityPackageIdentity,
  type ContinuitySelection,
  type ContinuityRetrieveParams,
  type ContinuityContextParams,
  type ContinuityInspectionItem,
  type ContinuitySelectionMode,
} from "./continuity-v1.js";
