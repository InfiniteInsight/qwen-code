/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ambient module shims for the OPTIONAL Matrix E2EE dependencies
 * (`@vector-im/matrix-bot-sdk` + `@matrix-org/matrix-sdk-crypto-nodejs`),
 * consumed only by {@link ./cryptoAdapter.js}.
 *
 * Why the shim exists at all:
 * 1. Both packages declare `engines: node >= 24`; on Node 22 (this repo's
 *    CI runtime) npm SILENTLY SKIPS these optionalDependencies (no error —
 *    empty scope dirs left behind), so `@vector-im/matrix-bot-sdk` is not
 *    on disk for tsc to resolve and the dynamic import fails with TS2307.
 *    The shim lets the build pass there, matching the runtime reality the
 *    adapter's try/catch already handles (missing module → degrade to the
 *    plain bridge, E2EE off).
 * 2. On Node ≥ 24 the packages install and the vector fork's own
 *    declarations (`typings: ./lib/index.d.ts`) would apply — the surface
 *    below mirrors them (verified against 0.10.0-element.0), so the same
 *    call sites typecheck identically on both runtimes. If the SDK is
 *    bumped, re-verify the surface and update the shim.
 */

declare module '@vector-im/matrix-bot-sdk' {
  /** Simple JSON-file sync-state storage (persists the sole `/sync` cursor). */
  export class SimpleFsStorageProvider {
    constructor(
      filename: string,
      trackTransactionsInMemory?: boolean,
      maxInMemoryTransactions?: number,
    );
  }
  /** SQLite-backed olm/megolm crypto store (persistent across restarts). */
  export class RustSdkCryptoStorageProvider {
    /** `storageType` is the native `StoreType` enum (`Sqlite = 0`). */
    constructor(storagePath: string, storageType: number);
  }
  /** The crypto-enabled Matrix client (sole `/sync` owner while E2EE is on). */
  export class MatrixClient {
    constructor(
      homeserverUrl: string,
      accessToken: string,
      storage?: SimpleFsStorageProvider,
      cryptoStore?: RustSdkCryptoStorageProvider,
    );
    /** Room event emitter (e.g. `room.message`, `room.event`). */
    on(
      event: string,
      cb: (roomId: string, event: unknown, ...rest: unknown[]) => void,
    ): this;
    getRoomStateEvent(
      roomId: string,
      eventType: string,
      stateKey: string,
    ): Promise<unknown>;
    joinRoom(roomIdOrAlias: string, viaServers?: string[]): Promise<string>;
    sendEvent(
      roomId: string,
      eventType: string,
      content: Record<string, unknown>,
    ): Promise<string>;
    start(filter?: unknown): Promise<unknown>;
    stop(): void;
    /**
     * Present whenever a crypto store was passed to the constructor (the
     * real declaration is non-optional; at runtime it is only defined when
     * crypto is possible).
     */
    readonly crypto: {
      readonly isReady: boolean;
      /** Initializes the olm machine; room tracking happens during sync. */
      prepare(): Promise<void>;
    };
  }
  /** Invites → auto-join, so the bot is in the room before messages arrive. */
  export class AutojoinRoomsMixin {
    static setupOnClient(client: MatrixClient): void;
  }
}

declare module '@matrix-org/matrix-sdk-crypto-nodejs' {
  /**
   * Store-type selector. The real package declares it as a `const enum`
   * (`Sqlite = 0`) in its index.d.ts — a plain object here mirrors the
   * runtime shape (the adapter sources the runtime value from this
   * package, see the comment at the call site in cryptoAdapter.ts).
   */
  export const StoreType: { readonly Sqlite: 0 };
}
