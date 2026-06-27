import type { API } from 'homebridge';
import { PLATFORM_NAME } from './settings';
import { NeewerLightsPlatform } from './platform';

/** Homebridge entry point. */
export = (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, NeewerLightsPlatform);
};
