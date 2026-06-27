import type { Logger } from 'homebridge';

/** A single light as configured by the user. */
export interface LightConfig {
  /** Stable key derived from config; used to address the light internally. */
  key: string;
  /** Display name in Apple Home. */
  name: string;
  /** Case-insensitive substring matched against the advertised BLE name. */
  bleName?: string;
  /** Exact host-specific peripheral id (macOS UUID), for disambiguation. */
  bleId?: string;
  /** Whether the model supports hue/saturation (RGB). */
  rgb: boolean;
  minKelvin: number;
  maxKelvin: number;
}

/** Connection state callbacks a transport emits per light. */
export interface TransportEvents {
  /** Light became reachable (connected + characteristic discovered). */
  ready: (key: string) => void;
  /** Light dropped / disconnected. */
  disconnect: (key: string) => void;
}

/**
 * Abstraction over how commands reach the hardware. The BLE transport speaks
 * directly to the lights; the mock transport just logs. This mirrors the
 * plugin/transport separation in homebridge-amaran-lights.
 */
export interface NeewerTransport {
  /** Begin scanning / connecting for all registered lights. */
  start(): Promise<void>;
  /** Tear down connections and scanning. */
  stop(): Promise<void>;
  /** Tell the transport about a light it should find and maintain. */
  registerLight(light: LightConfig): void;
  /** Write a raw command frame to a light. Rejects if not reachable. */
  write(key: string, data: Uint8Array): Promise<void>;
  /** Whether the light is currently reachable. */
  isReady(key: string): boolean;
  on<E extends keyof TransportEvents>(event: E, handler: TransportEvents[E]): void;
}

export interface TransportOptions {
  log: Logger;
  debug: boolean;
  scanTimeoutSeconds: number;
  keepAliveSeconds: number;
}
