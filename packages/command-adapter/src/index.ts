export {
  MemoryCommandAdapter,
  type MemoryCommandAdapterOptions,
} from "./memory-command-adapter.js";
export {
  V2CommandValidationError,
  type V2CreateMemoryCommand,
  type V2UpdateMemoryCommand,
  type V2LifecycleCommand,
  type V2CommandValidationIssue,
} from "./types.js";
export {
  validateCreateMemory,
  validateUpdateMemory,
  validateLifecycle,
} from "./validate.js";
export {
  createCoreRuntime,
  probeCoreDatabase,
  resolveCoreDatabaseUrl,
  type CoreRuntime,
  type CreateCoreRuntimeOptions,
} from "./core-runtime.js";
export {
  asProductionStore,
  testOnlyEventStore,
  type EventStoreRead,
} from "./event-store-read.js";
export {
  DesktopHost,
  getDesktopHost,
  resetDesktopHostForTests,
  invokeDesktopCommand,
  type DesktopMemoryCommand,
  type DesktopHostStartOptions,
} from "./desktop-host.js";
export {
  startDesktopBridgeServer,
  DEFAULT_DESKTOP_HOST_PORT,
  requireChannelToken,
  bridgeCommandStatus,
  type DesktopBridgeServer,
} from "./desktop-bridge-server.js";
export {
  classifyV2Error,
  formatV2Error,
  type V2ErrorCode,
  type ClassifiedV2Error,
} from "./errors.js";
export {
  MemoryQueryService,
  type MemoryHistoryEntry,
  type MemoryQueryServiceDeps,
} from "./memory-query-service.js";
export {
  RETRIEVE_ORDER,
  compareRetrieveOrder,
  encodeRetrieveCursor,
  decodeRetrieveCursor,
  filterAndOrderCells,
  paginateRetrieve,
  assembleContextFromViews,
  matchesHardFilter,
  type RetrieveMemoriesQuery,
  type RetrieveMemoriesPage,
  type AssembleContextSpec,
  type ContextBundle,
  type ContextItem,
} from "./memory-retrieval.js";

export {
  ContinuityService,
  type ContinuityExportSpec,
  type ContinuityRehydrateResult,
  type ContinuityServiceDeps,
} from "./continuity-service.js";

