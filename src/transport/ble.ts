import { EventEmitter } from 'events';
import noble, { Characteristic, Peripheral } from '@abandonware/noble';
import { WRITE_CHARACTERISTIC_UUID, NOTIFY_CHARACTERISTIC_UUID } from '../protocol';
import type { LightConfig, NeewerTransport, TransportEvents, TransportOptions } from './types';

interface Connection {
  config: LightConfig;
  peripheral?: Peripheral;
  writeChar?: Characteristic;
  connecting: boolean;
}

/**
 * Direct Bluetooth LE transport. Scans for Neewer peripherals, matches them to
 * configured lights by advertised name and/or id, connects, and exposes a
 * write() that pushes raw command frames to each light's control characteristic.
 */
export class BleTransport implements NeewerTransport {
  private readonly emitter = new EventEmitter();
  private readonly connections = new Map<string, Connection>();
  private poweredOn = false;
  private scanning = false;
  private stopped = false;
  private scanStopTimer?: NodeJS.Timeout;
  private keepAliveTimer?: NodeJS.Timeout;

  constructor(private readonly opts: TransportOptions) {}

  registerLight(light: LightConfig): void {
    this.connections.set(light.key, { config: light, connecting: false });
  }

  async start(): Promise<void> {
    noble.on('stateChange', (state) => {
      this.debug(`adapter state: ${state}`);
      if (state === 'poweredOn') {
        this.poweredOn = true;
        void this.startScanning();
      } else {
        this.poweredOn = false;
        if (state === 'unauthorized') {
          this.opts.log.error(
            'Bluetooth permission denied. On macOS, grant Bluetooth access to the ' +
              'process running Homebridge (System Settings > Privacy & Security > Bluetooth).',
          );
        }
      }
    });

    noble.on('discover', (peripheral) => {
      void this.onDiscover(peripheral);
    });

    if (this.opts.keepAliveSeconds > 0) {
      this.keepAliveTimer = setInterval(
        () => this.reconcile(),
        this.opts.keepAliveSeconds * 1000,
      );
    }

    // If the adapter is already powered on (state event may have fired before
    // our listener attached), kick off scanning now.
    if ((noble.state as string) === 'poweredOn') {
      this.poweredOn = true;
      await this.startScanning();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.scanStopTimer) {
      clearTimeout(this.scanStopTimer);
    }
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
    }
    try {
      await noble.stopScanningAsync();
    } catch {
      /* ignore */
    }
    for (const conn of this.connections.values()) {
      try {
        await conn.peripheral?.disconnectAsync();
      } catch {
        /* ignore */
      }
    }
    noble.removeAllListeners();
  }

  isReady(key: string): boolean {
    const conn = this.connections.get(key);
    return !!conn?.writeChar && conn.peripheral?.state === 'connected';
  }

  async write(key: string, data: Uint8Array): Promise<void> {
    const conn = this.connections.get(key);
    if (!conn?.writeChar || conn.peripheral?.state !== 'connected') {
      throw new Error(`Light "${conn?.config.name ?? key}" is not connected`);
    }
    // Neewer's control characteristic accepts write-without-response.
    await conn.writeChar.writeAsync(Buffer.from(data), true);
    this.debug(`${conn.config.name} <= ${Buffer.from(data).toString('hex')}`);
  }

  on<E extends keyof TransportEvents>(event: E, handler: TransportEvents[E]): void {
    this.emitter.on(event, handler as (...args: unknown[]) => void);
  }

  // --- internals -----------------------------------------------------------

  private get hasPendingLights(): boolean {
    for (const conn of this.connections.values()) {
      if (!this.isReady(conn.config.key)) {
        return true;
      }
    }
    return false;
  }

  private async startScanning(): Promise<void> {
    if (this.stopped || !this.poweredOn || this.scanning) {
      return;
    }
    if (!this.hasPendingLights) {
      return;
    }
    try {
      // Scan with NO service filter: Neewer lights advertise their name but not
      // the GATT service UUID, so a filtered scan never sees them. We match by
      // advertised name / id in onDiscover() instead (as NeewerLite does).
      await noble.startScanningAsync([], false);
      this.scanning = true;
      this.debug('scanning for Neewer lights...');
      if (this.opts.scanTimeoutSeconds > 0) {
        this.scanStopTimer = setTimeout(
          () => void this.stopScanning(),
          this.opts.scanTimeoutSeconds * 1000,
        );
      }
    } catch (err) {
      this.opts.log.error(`Failed to start BLE scan: ${(err as Error).message}`);
    }
  }

  private async stopScanning(): Promise<void> {
    if (!this.scanning) {
      return;
    }
    try {
      await noble.stopScanningAsync();
    } catch {
      /* ignore */
    }
    this.scanning = false;
  }

  private matchLight(peripheral: Peripheral): Connection | undefined {
    const name = (peripheral.advertisement.localName ?? '').toLowerCase();
    for (const conn of this.connections.values()) {
      if (this.isReady(conn.config.key) || conn.connecting) {
        continue;
      }
      const { bleId, bleName } = conn.config;
      if (bleId && peripheral.id.toLowerCase() === bleId.toLowerCase()) {
        return conn;
      }
      if (bleName && name.includes(bleName.toLowerCase())) {
        return conn;
      }
    }
    return undefined;
  }

  private async onDiscover(peripheral: Peripheral): Promise<void> {
    if (this.stopped) {
      return;
    }
    const advName = peripheral.advertisement.localName ?? '(no name)';
    // In debug mode, surface every *named* peripheral so the user can find the
    // exact advertised name/id of their lights and copy them into the config.
    if (this.opts.debug && peripheral.advertisement.localName) {
      const tag = this.looksLikeNeewer(advName) ? 'Neewer?' : 'other';
      this.debug(`discovered [${tag}] name="${advName}" id=${peripheral.id}`);
    }

    const conn = this.matchLight(peripheral);
    if (!conn) {
      return;
    }

    conn.connecting = true;
    conn.peripheral = peripheral;
    // Pause scanning while connecting; CoreBluetooth on macOS is unreliable if a
    // scan is in flight during connect. Give the adapter a moment to settle.
    await this.stopScanning();
    await delay(300);

    try {
      this.opts.log.info(`Connecting to "${conn.config.name}" (${advName} / ${peripheral.id})`);
      peripheral.removeAllListeners('disconnect');
      peripheral.once('disconnect', () => this.onDisconnect(conn));
      await withTimeout(peripheral.connectAsync(), 12000, 'connection timed out');

      // Discover everything so we can (a) log what the device exposes and
      // (b) fall back gracefully if it doesn't use the classic Neewer service.
      const { services, characteristics } =
        await peripheral.discoverAllServicesAndCharacteristicsAsync();

      if (this.opts.debug) {
        this.debug(
          `"${conn.config.name}" exposes ${services.length} service(s), ` +
            `${characteristics.length} characteristic(s):`,
        );
        for (const c of characteristics) {
          this.debug(`    char ${normalizeUuid(c.uuid)} props=[${(c.properties ?? []).join(',')}]`);
        }
      }

      let writeChar = characteristics.find(
        (c) => normalizeUuid(c.uuid) === WRITE_CHARACTERISTIC_UUID,
      );
      if (!writeChar) {
        // No classic Neewer control characteristic. Fall back to the first
        // writable characteristic so we can still attempt to drive the light.
        writeChar = characteristics.find((c) => {
          const p = c.properties ?? [];
          return p.includes('writeWithoutResponse') || p.includes('write');
        });
        if (writeChar) {
          this.opts.log.warn(
            `"${conn.config.name}" does not expose the standard Neewer service; ` +
              `falling back to writable characteristic ${normalizeUuid(writeChar.uuid)}. ` +
              `If control doesn't work, share the characteristic list logged above.`,
          );
        }
      }
      if (!writeChar) {
        throw new Error('no writable control characteristic found');
      }
      conn.writeChar = writeChar;

      // Best-effort subscribe to notifications (state read-back varies by model).
      const notifyChar = characteristics.find((c) => {
        const p = c.properties ?? [];
        return (
          normalizeUuid(c.uuid) === NOTIFY_CHARACTERISTIC_UUID ||
          p.includes('notify') ||
          p.includes('indicate')
        );
      });
      try {
        await notifyChar?.subscribeAsync();
      } catch {
        /* notifications optional */
      }

      conn.connecting = false;
      this.opts.log.info(`Connected to "${conn.config.name}"`);
      this.emitter.emit('ready', conn.config.key);
    } catch (err) {
      conn.connecting = false;
      conn.writeChar = undefined;
      const msg =
        err instanceof Error
          ? err.message
          : err
            ? String(err)
            : 'no error detail (peripheral refused the connection or went out of range)';
      this.opts.log.warn(`Failed to connect to "${conn.config.name}": ${msg}. Will retry.`);
      try {
        await peripheral.disconnectAsync();
      } catch {
        /* ignore */
      }
      // Back off before rescanning so we don't hammer a flaky peripheral.
      await delay(1500);
    } finally {
      // Resume scanning if any lights remain unconnected.
      await this.startScanning();
    }
  }

  private onDisconnect(conn: Connection): void {
    if (conn.writeChar || conn.peripheral) {
      this.opts.log.warn(`"${conn.config.name}" disconnected`);
    }
    conn.writeChar = undefined;
    conn.connecting = false;
    this.emitter.emit('disconnect', conn.config.key);
    void this.startScanning();
  }

  private reconcile(): void {
    if (this.hasPendingLights) {
      void this.startScanning();
    }
  }

  private looksLikeNeewer(name: string): boolean {
    const n = name.toLowerCase();
    return (
      n.includes('neewer') ||
      n.includes('nwr') ||
      n.includes('nee') ||
      n.startsWith('nw-') ||
      n.startsWith('nh-') ||
      n.includes('rgb') ||
      n.includes('sl')
    );
  }

  private debug(msg: string): void {
    if (this.opts.debug) {
      this.opts.log.info(`[ble] ${msg}`);
    }
  }
}

/** noble may return characteristic uuids with or without dashes / casing. */
function normalizeUuid(uuid: string): string {
  return uuid.replace(/-/g, '').toLowerCase();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reject if a promise hasn't settled within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
