import type {
  CharacteristicValue,
  PlatformAccessory,
  Service,
} from 'homebridge';
import type { NeewerLightsPlatform } from './platform';
import type { LightConfig, NeewerTransport } from './transport/types';
import {
  cctCommand,
  hsiCommand,
  kelvinToMired,
  miredToKelvin,
  powerCommand,
} from './protocol';

type Mode = 'cct' | 'hsi';

interface DesiredState {
  on: boolean;
  brightness: number; // 1-100
  mode: Mode;
  kelvin: number;
  hue: number; // 0-360
  saturation: number; // 0-100
}

/**
 * One Neewer light exposed as a HomeKit lightbulb. Holds the desired state
 * locally (optimistic) and pushes debounced BLE writes through the transport.
 */
export class NeewerLightAccessory {
  private readonly service: Service;
  private readonly state: DesiredState;
  private writeTimer?: NodeJS.Timeout;

  constructor(
    private readonly platform: NeewerLightsPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly config: LightConfig,
    private readonly transport: NeewerTransport,
    private readonly debounceMs: number,
  ) {
    const { Service, Characteristic } = this.platform;

    this.state = {
      on: false,
      brightness: 100,
      mode: 'cct',
      kelvin: Math.round((config.minKelvin + config.maxKelvin) / 2),
      hue: 0,
      saturation: 0,
    };

    this.accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Neewer')
      .setCharacteristic(Characteristic.Model, config.rgb ? 'RGB Light' : 'Bi-Color Light')
      .setCharacteristic(Characteristic.SerialNumber, config.bleId || config.key);

    this.service =
      this.accessory.getService(Service.Lightbulb) ||
      this.accessory.addService(Service.Lightbulb, config.name);

    this.service.setCharacteristic(Characteristic.Name, config.name);

    this.service
      .getCharacteristic(Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(() => this.state.on);

    this.service
      .getCharacteristic(Characteristic.Brightness)
      .onSet(this.setBrightness.bind(this))
      .onGet(() => this.state.brightness);

    // Color temperature: HomeKit uses mireds; bound to this light's kelvin range.
    this.service
      .getCharacteristic(Characteristic.ColorTemperature)
      .setProps({
        minValue: kelvinToMired(config.maxKelvin), // warm/cool inverted in mireds
        maxValue: kelvinToMired(config.minKelvin),
      })
      .onSet(this.setColorTemperature.bind(this))
      .onGet(() => kelvinToMired(this.state.kelvin));

    if (config.rgb) {
      this.service
        .getCharacteristic(Characteristic.Hue)
        .onSet(this.setHue.bind(this))
        .onGet(() => this.state.hue);

      this.service
        .getCharacteristic(Characteristic.Saturation)
        .onSet(this.setSaturation.bind(this))
        .onGet(() => this.state.saturation);
    }

    // When the light (re)connects, push current desired state so HomeKit and
    // hardware agree.
    this.transport.on('ready', (key) => {
      if (key === this.config.key && this.state.on) {
        this.flush(true);
      }
    });
  }

  // --- HomeKit setters -----------------------------------------------------

  private async setOn(value: CharacteristicValue): Promise<void> {
    this.state.on = value as boolean;
    await this.send(powerCommand(this.state.on));
    // On power-on, re-assert the active mode so brightness/color are restored.
    if (this.state.on) {
      this.scheduleModeWrite();
    }
  }

  private async setBrightness(value: CharacteristicValue): Promise<void> {
    this.state.brightness = Math.max(1, value as number);
    this.scheduleModeWrite();
  }

  private async setColorTemperature(value: CharacteristicValue): Promise<void> {
    this.state.kelvin = miredToKelvin(value as number);
    this.state.mode = 'cct';
    this.scheduleModeWrite();
  }

  private async setHue(value: CharacteristicValue): Promise<void> {
    this.state.hue = value as number;
    this.state.mode = 'hsi';
    this.scheduleModeWrite();
  }

  private async setSaturation(value: CharacteristicValue): Promise<void> {
    this.state.saturation = value as number;
    this.state.mode = 'hsi';
    this.scheduleModeWrite();
  }

  // --- write pipeline ------------------------------------------------------

  /** Coalesce rapid slider changes into a single mode write. */
  private scheduleModeWrite(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
    }
    this.writeTimer = setTimeout(() => this.flush(false), this.debounceMs);
  }

  private flush(force: boolean): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
    if (!this.state.on && !force) {
      return;
    }
    void this.send(this.currentModeCommand());
  }

  private currentModeCommand(): Uint8Array {
    if (this.state.mode === 'hsi' && this.config.rgb) {
      return hsiCommand(this.state.hue, this.state.saturation, this.state.brightness);
    }
    return cctCommand(
      this.state.brightness,
      this.state.kelvin,
      this.config.minKelvin,
      this.config.maxKelvin,
    );
  }

  private async send(data: Uint8Array): Promise<void> {
    if (!this.transport.isReady(this.config.key)) {
      this.platform.log.debug(
        `"${this.config.name}" not connected yet; command queued for next connection`,
      );
      return;
    }
    try {
      await this.transport.write(this.config.key, data);
    } catch (err) {
      this.platform.log.warn(
        `Write to "${this.config.name}" failed: ${(err as Error).message}`,
      );
    }
  }
}
