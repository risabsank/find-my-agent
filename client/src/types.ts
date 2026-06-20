// Re-export the shared data model so client code imports from one place.
export type {
  AgentState,
  AgentStatus,
  TokenUsage,
  ActivityEntry,
  NormalizedEvent,
  TreeNode,
  ServerMessage,
  SnapshotMessage,
  EventMessage,
  AgentRemovedMessage,
} from "../../shared/types.ts";
