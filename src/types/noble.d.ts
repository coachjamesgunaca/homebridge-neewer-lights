/**
 * Minimal ambient typings for @abandonware/noble covering only the surface this
 * plugin uses. The package ships its own types in recent versions, but declaring
 * a local module keeps the build resilient across versions.
 */
declare module '@abandonware/noble' {
  import { EventEmitter } from 'events';

  export interface Advertisement {
    localName?: string;
    serviceUuids?: string[];
    manufacturerData?: Buffer;
  }

  export class Characteristic extends EventEmitter {
    uuid: string;
    properties: string[];
    writeAsync(data: Buffer, withoutResponse: boolean): Promise<void>;
    subscribeAsync(): Promise<void>;
  }

  export class Service extends EventEmitter {
    uuid: string;
    characteristics: Characteristic[];
  }

  export type PeripheralState =
    | 'connecting'
    | 'connected'
    | 'disconnecting'
    | 'disconnected'
    | 'error';

  export class Peripheral extends EventEmitter {
    id: string;
    uuid: string;
    address: string;
    addressType: string;
    connectable: boolean;
    advertisement: Advertisement;
    rssi: number;
    state: PeripheralState;
    connectAsync(): Promise<void>;
    disconnectAsync(): Promise<void>;
    discoverSomeServicesAndCharacteristicsAsync(
      serviceUuids: string[],
      characteristicUuids: string[],
    ): Promise<{ services: Service[]; characteristics: Characteristic[] }>;
    discoverAllServicesAndCharacteristicsAsync(): Promise<{
      services: Service[];
      characteristics: Characteristic[];
    }>;
  }

  export type NobleState =
    | 'unknown'
    | 'resetting'
    | 'unsupported'
    | 'unauthorized'
    | 'poweredOff'
    | 'poweredOn';

  export function startScanningAsync(
    serviceUuids?: string[],
    allowDuplicates?: boolean,
  ): Promise<void>;
  export function stopScanningAsync(): Promise<void>;

  export function on(event: 'stateChange', listener: (state: NobleState) => void): void;
  export function on(event: 'discover', listener: (peripheral: Peripheral) => void): void;
  export function on(event: 'scanStart' | 'scanStop', listener: () => void): void;
  export function removeAllListeners(event?: string): void;

  const _state: NobleState;
  export { _state as state };
}
