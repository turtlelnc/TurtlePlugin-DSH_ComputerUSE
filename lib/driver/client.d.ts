import { type DriverPolicy, type DriverStatus } from './protocol.js';
/** Directory the plugin writes runtime state into. */
export declare function dataDir(): string;
/** Where a driver compiled at runtime is cached. */
export declare function builtDriverPath(): string;
/** The driver shipped inside the installed package. */
export declare function shippedDriverPath(): string;
/** The `native/` directory of the installed package, used to rebuild on demand. */
export declare function nativeSourceDir(): string;
/** A live NDJSON conversation with one driver process. */
export declare class DriverClient {
    private readonly options;
    private child;
    private pending;
    private buffer;
    private nextId;
    private spawnFailure;
    private idleTimer;
    private lastExit;
    private ready;
    constructor(options: {
        /** Explicit driver path from configuration, or empty for auto-detection. */
        driverPath: string;
        /** Whether a missing executable may be compiled from native/ on the spot. */
        autoBuild: boolean;
        /** Reclaim the process after this many idle milliseconds; 0 keeps it resident. */
        idleShutdownMs: number;
        /** Sink for driver diagnostics and lifecycle notes. */
        log(level: 'debug' | 'info' | 'warn', message: string): void;
    });
    /** Version handshake reported by the running driver, when it is up. */
    get handshake(): {
        version: string;
        pid: number;
        elevated: boolean;
    } | null;
    /** Whether a driver process is currently alive. */
    get running(): boolean;
    /** How the last driver process ended, when it has. */
    get exitInfo(): {
        code: number | null;
        signal: NodeJS.Signals | null;
    } | null;
    /**
     * Resolve the executable, compiling it from `native/` when necessary.
     * @returns The absolute path to a driver that exists, or null when none can be produced.
     */
    locate(): string | null;
    /**
     * Compile the driver with the in-box .NET Framework compiler.
     * @returns The path to the freshly built executable, or null when the build failed.
     */
    compile(): string | null;
    private ensureChild;
    private consume;
    private failAll;
    /**
     * Send one request and await its result.
     * @param method - driver method name.
     * @param params - method parameters.
     * @param policy - sandbox decisions to attach.
     * @param timeoutMs - how long to wait before the driver is considered hung.
     * @returns The driver's result object.
     * @throws {DriverError} on a structured refusal, a timeout, or a dead process.
     */
    call<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, policy?: DriverPolicy, timeoutMs?: number): Promise<T>;
    /** Stop the driver if it is running, and settle every in-flight request. */
    kill(reason: string): void;
    /** Release the driver after an idle period instead of leaving it resident. */
    touchIdle(): void;
    private clearIdleTimer;
    /** Ask the driver for its own status, used by the status tool. */
    status(timeoutMs?: number): Promise<DriverStatus>;
    /** Shut the driver down; called when the plugin unloads. */
    dispose(): void;
}
