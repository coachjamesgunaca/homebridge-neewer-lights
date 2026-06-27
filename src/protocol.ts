/**
 * Neewer Bluetooth LE protocol.
 *
 * Reverse-engineered from NeewerLite (https://github.com/keefo/NeewerLite),
 * specifically Model/NeewerLightConstant.swift and Model/NeewerLight.swift.
 *
 * Wire format for the "classic" RGB panels (RGB660/530/176, CB60 RGB, etc.):
 *
 *   [ 0x78 (prefix) ][ tag ][ length ][ ...payload ][ checksum ]
 *
 * where `length` is the number of payload bytes and `checksum` is the sum of
 * every preceding byte modulo 256.
 */

/** Every Neewer BLE command starts with this prefix byte (0x78 = 120). */
export const PREFIX_TAG = 0x78;

/** Command tags (from NeewerLightConstant.BleCommand). */
export const TAG = {
  POWER: 0x81,
  /** CCT (color temperature) mode: brightness, then CCT byte. */
  CCT: 0x87,
  /** HSI (RGB) mode: hue (uint16 LE), saturation, brightness. */
  HSI: 0x86,
  /** Long-CCT brightness-only. */
  LONG_CCT_BRIGHTNESS: 0x82,
} as const;

/** Fixed power frames (NeewerLightConstant.BleCommand.powerOn / powerOff). */
export const POWER_ON = Uint8Array.from([PREFIX_TAG, 0x81, 0x01, 0x01, 0xfb]);
export const POWER_OFF = Uint8Array.from([PREFIX_TAG, 0x81, 0x01, 0x02, 0xfc]);

/** Request the light to report its state on the notify characteristic. */
export const READ_REQUEST = Uint8Array.from([PREFIX_TAG, 0x84, 0x00, 0xfc]);

/** Service + characteristic UUIDs (NeewerLightConstant.Constants). */
export const SERVICE_UUID = '69400001b5a3f393e0a9e50e24dcca99';
export const WRITE_CHARACTERISTIC_UUID = '69400002b5a3f393e0a9e50e24dcca99';
export const NOTIFY_CHARACTERISTIC_UUID = '69400003b5a3f393e0a9e50e24dcca99';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * Sum every byte and append the low 8 bits as a trailing checksum.
 * Mirrors NeewerLight.appendCheckSum().
 */
export function withChecksum(bytes: number[]): Uint8Array {
  let sum = 0;
  for (const b of bytes) {
    sum += b & 0xff;
  }
  return Uint8Array.from([...bytes.map((b) => b & 0xff), sum & 0xff]);
}

/**
 * Build a command frame: prefix, tag, length, payload, checksum.
 * Mirrors NeewerLight.composeSingleCommand().
 */
export function composeCommand(tag: number, payload: number[]): Uint8Array {
  return withChecksum([PREFIX_TAG, tag, payload.length, ...payload]);
}

export function powerCommand(on: boolean): Uint8Array {
  return on ? POWER_ON : POWER_OFF;
}

/**
 * CCT mode command.
 * @param brightness 0-100 (HomeKit percentage)
 * @param kelvin     desired color temperature in kelvin
 * @param minKelvin  light's minimum supported kelvin
 * @param maxKelvin  light's maximum supported kelvin
 *
 * Neewer encodes CCT as kelvin / 100 (e.g. 5600K -> 0x38 / 56), clamped to the
 * light's supported range (default 32-56 in the firmware).
 */
export function cctCommand(
  brightness: number,
  kelvin: number,
  minKelvin = 3200,
  maxKelvin = 5600,
): Uint8Array {
  const brr = clamp(brightness, 0, 100);
  const cctByte = clamp(kelvin / 100, Math.round(minKelvin / 100), Math.round(maxKelvin / 100));
  return composeCommand(TAG.CCT, [brr, cctByte]);
}

/** Brightness-only update while staying in CCT mode. */
export function cctBrightnessCommand(brightness: number): Uint8Array {
  return composeCommand(TAG.CCT, [clamp(brightness, 0, 100)]);
}

/**
 * HSI / RGB mode command.
 * @param hue        0-360 degrees
 * @param saturation 0-100
 * @param brightness 0-100
 *
 * Hue is sent as a little-endian uint16 (low byte first), as in
 * NeewerLight: bArr[3] = hue & 0xFF, bArr[4] = (hue & 0xFF00) >> 8.
 */
export function hsiCommand(hue: number, saturation: number, brightness: number): Uint8Array {
  const h = clamp(hue, 0, 360);
  const sat = clamp(saturation, 0, 100);
  const brr = clamp(brightness, 0, 100);
  return composeCommand(TAG.HSI, [h & 0xff, (h & 0xff00) >> 8, sat, brr]);
}

/** Convert a HomeKit mired value (reciprocal megakelvin) to kelvin. */
export function miredToKelvin(mired: number): number {
  return Math.round(1_000_000 / mired);
}

/** Convert kelvin to a HomeKit mired value. */
export function kelvinToMired(kelvin: number): number {
  return Math.round(1_000_000 / kelvin);
}
