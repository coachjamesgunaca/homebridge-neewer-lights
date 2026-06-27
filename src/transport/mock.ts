import { EventEmitter } from 'events';
import type { LightConfig, NeewerTransport, TransportEvents, TransportOptions } from './types';

/**
 * Transport that pretends every light is connected and logs the bytes it would
 * send. Useful for verifying the accessories show up correctly in Apple Home
 * with no hardware present (`"transport": "mock"`).
 */
export class MockTransport implements NeewerTransport {
  private readonly emitter = new EventEmitter();
  private readonly lights = new Map<string, LightConfig>();

  constructor(private readonly opts: TransportOptions) {}

  async start(): Promise<void> {
    for (const light of this.lights.values()) {
      this.opts.log.info(`[mock] "${light.name}" ready`);
      // Defer so listeners registered after start() still fire.
      setImmediate(() => this.emitter.emit('ready', light.key));
    }
  }

  async stop(): Promise<void> {
    this.lights.clear();
  }

  registerLight(light: LightConfig): void {
    this.lights.set(light.key, light);
  }

  async write(key: string, data: Uint8Array): Promise<void> {
    const hex = Buffer.from(data).toString('hex').match(/.{1,2}/g)?.join(' ');
    this.opts.log.info(`[mock] ${this.lights.get(key)?.name ?? key} <= ${hex}`);
  }

  isReady(): boolean {
    return true;
  }

  on<E extends keyof TransportEvents>(event: E, handler: TransportEvents[E]): void {
    this.emitter.on(event, handler as (...args: unknown[]) => void);
  }
}
