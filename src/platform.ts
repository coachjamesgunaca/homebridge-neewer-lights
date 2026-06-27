import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { NeewerLightAccessory } from './accessory';
import { BleTransport } from './transport/ble';
import { MockTransport } from './transport/mock';
import type { LightConfig, NeewerTransport } from './transport/types';

interface RawLightConfig {
  name?: string;
  bleName?: string;
  bleId?: string;
  rgb?: boolean;
  minKelvin?: number;
  maxKelvin?: number;
}

interface NeewerPlatformConfig extends PlatformConfig {
  transport?: 'ble' | 'mock';
  scanTimeoutSeconds?: number;
  writeDebounceMs?: number;
  keepAliveSeconds?: number;
  debug?: boolean;
  lights?: RawLightConfig[];
}

export class NeewerLightsPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly accessories = new Map<string, PlatformAccessory>();
  private readonly config: NeewerPlatformConfig;
  private transport?: NeewerTransport;

  constructor(
    public readonly log: Logger,
    config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.config = config as NeewerPlatformConfig;

    this.api.on('didFinishLaunching', () => {
      void this.start();
    });

    this.api.on('shutdown', () => {
      void this.transport?.stop();
    });
  }

  /** Restore cached accessories on Homebridge restart. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug(`Restoring cached accessory: ${accessory.displayName}`);
    this.accessories.set(accessory.UUID, accessory);
  }

  private buildLightConfigs(): LightConfig[] {
    const lights = this.config.lights ?? [];
    const result: LightConfig[] = [];

    lights.forEach((raw, index) => {
      const name = (raw.name ?? '').trim();
      if (!name) {
        this.log.warn(`lights[${index}] has no name; skipping`);
        return;
      }
      if (!raw.bleName && !raw.bleId) {
        this.log.warn(`Light "${name}" needs a bleName or bleId to be matched; skipping`);
        return;
      }
      const minKelvin = raw.minKelvin ?? 3200;
      const maxKelvin = raw.maxKelvin ?? 5600;
      result.push({
        key: (raw.bleId || raw.bleName || name).toLowerCase(),
        name,
        bleName: raw.bleName,
        bleId: raw.bleId,
        rgb: raw.rgb ?? true,
        minKelvin: Math.min(minKelvin, maxKelvin),
        maxKelvin: Math.max(minKelvin, maxKelvin),
      });
    });

    return result;
  }

  private async start(): Promise<void> {
    const lights = this.buildLightConfigs();
    if (lights.length === 0) {
      this.log.warn('No lights configured. Add lights in the plugin settings.');
      return;
    }

    const debug = this.config.debug ?? false;
    const transportKind = this.config.transport ?? 'ble';
    const transportOpts = {
      log: this.log,
      debug,
      scanTimeoutSeconds: this.config.scanTimeoutSeconds ?? 0,
      keepAliveSeconds: this.config.keepAliveSeconds ?? 30,
    };

    this.transport =
      transportKind === 'mock'
        ? new MockTransport(transportOpts)
        : new BleTransport(transportOpts);

    this.log.info(`Starting Neewer Lights (${transportKind}) with ${lights.length} light(s)`);

    const debounceMs = this.config.writeDebounceMs ?? 120;
    const activeUuids = new Set<string>();

    for (const light of lights) {
      this.transport.registerLight(light);
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${light.key}`);
      activeUuids.add(uuid);

      let accessory = this.accessories.get(uuid);
      if (accessory) {
        accessory.context.light = light;
        this.api.updatePlatformAccessories([accessory]);
      } else {
        accessory = new this.api.platformAccessory(light.name, uuid);
        accessory.context.light = light;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
        this.log.info(`Added new light: ${light.name}`);
      }

      new NeewerLightAccessory(this, accessory, light, this.transport, debounceMs);
    }

    // Remove accessories no longer in config.
    for (const [uuid, accessory] of this.accessories) {
      if (!activeUuids.has(uuid)) {
        this.log.info(`Removing stale accessory: ${accessory.displayName}`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
      }
    }

    try {
      await this.transport.start();
    } catch (err) {
      this.log.error(`Failed to start transport: ${(err as Error).message}`);
    }
  }
}
