/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  BridgePendingInteractionOption,
  BridgePendingPermissionInteraction,
  BridgePendingUserQuestion,
  BridgePendingUserQuestionInteraction,
} from '@qwen-code/acp-bridge/bridgeTypes';
import type {
  ServeSubagentAbandonResult,
  ServeSubagentControlRefusalCode,
  ServeSubagentPauseRefusalCode,
  ServeSubagentPauseResult,
  ServeSubagentResumeResult,
} from '@qwen-code/acp-bridge/status';
import type {
  DaemonPendingInteractionOption,
  DaemonPendingPermissionInteraction,
  DaemonPendingUserQuestion,
  DaemonPendingUserQuestionInteraction,
  DaemonSubagentAbandonOutcome,
  DaemonSubagentControlRefusalCode,
  DaemonSubagentPauseOutcome,
  DaemonSubagentPauseRefusalCode,
  DaemonSubagentResumeOutcome,
} from './types.js';

type Assert<T extends true> = T;
type MutuallyAssignable<A, B> = A extends B
  ? B extends A
    ? true
    : false
  : false;

type PendingInteractionOptionStaysInSync = Assert<
  MutuallyAssignable<
    BridgePendingInteractionOption,
    DaemonPendingInteractionOption
  >
>;
type PendingPermissionInteractionStaysInSync = Assert<
  MutuallyAssignable<
    BridgePendingPermissionInteraction,
    DaemonPendingPermissionInteraction
  >
>;
type PendingUserQuestionStaysInSync = Assert<
  MutuallyAssignable<BridgePendingUserQuestion, DaemonPendingUserQuestion>
>;
type PendingUserQuestionInteractionStaysInSync = Assert<
  MutuallyAssignable<
    BridgePendingUserQuestionInteraction,
    DaemonPendingUserQuestionInteraction
  >
>;

/** Compile-time assertion for bridge/SDK pending-interaction wire mirrors. */
export const pendingInteractionWireTypesInSync: [
  PendingInteractionOptionStaysInSync,
  PendingPermissionInteractionStaysInSync,
  PendingUserQuestionStaysInSync,
  PendingUserQuestionInteractionStaysInSync,
] = [true, true, true, true];

// The subagent control wire types are unions, which `MutuallyAssignable`
// would distribute over; the tuple wrap compares each union as a whole.
type SameUnion<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

type SubagentPauseRefusalCodeStaysInSync = Assert<
  SameUnion<ServeSubagentPauseRefusalCode, DaemonSubagentPauseRefusalCode>
>;
type SubagentPauseOutcomeStaysInSync = Assert<
  SameUnion<ServeSubagentPauseResult, DaemonSubagentPauseOutcome>
>;
type SubagentRefusalCodeStaysInSync = Assert<
  SameUnion<ServeSubagentControlRefusalCode, DaemonSubagentControlRefusalCode>
>;
type SubagentResumeOutcomeStaysInSync = Assert<
  SameUnion<ServeSubagentResumeResult, DaemonSubagentResumeOutcome>
>;
type SubagentAbandonOutcomeStaysInSync = Assert<
  SameUnion<ServeSubagentAbandonResult, DaemonSubagentAbandonOutcome>
>;

/** Compile-time assertion for bridge/SDK subagent pause, resume, and abandon (#259, #267). */
export const subagentControlWireTypesInSync: [
  SubagentPauseRefusalCodeStaysInSync,
  SubagentPauseOutcomeStaysInSync,
  SubagentRefusalCodeStaysInSync,
  SubagentResumeOutcomeStaysInSync,
  SubagentAbandonOutcomeStaysInSync,
] = [true, true, true, true, true];
