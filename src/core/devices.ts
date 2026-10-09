import { LabError, type DeviceOverride, type DeviceProfile } from './schema.js';

// Generic CSS-pixel profiles, deliberately not named after real handsets: this is Chromium
// device emulation, not a phone.
const ANDROID_CHROME_UA =
  'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36';
const ANDROID_TABLET_UA =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

export const DEVICES: Readonly<Record<string, DeviceProfile>> = {
  'mobile-320': {
    id: 'mobile-320',
    label: 'Small mobile 320x568 @2x, touch',
    viewport: { width: 320, height: 568 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: ANDROID_CHROME_UA,
  },
  'mobile-390': {
    id: 'mobile-390',
    label: 'Generic mobile 390x844 @3x, touch',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: ANDROID_CHROME_UA,
  },
  'tablet-768': {
    id: 'tablet-768',
    label: 'Tablet 768x1024 @2x, touch',
    viewport: { width: 768, height: 1024 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: ANDROID_TABLET_UA,
  },
  'desktop-1440': {
    id: 'desktop-1440',
    label: 'Desktop 1440x900, mouse',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    userAgent: DESKTOP_CHROME_UA,
  },
};

/** The responsive sweep's default widths, narrowest first. */
export const SWEEP_DEVICES = ['mobile-320', 'mobile-390', 'tablet-768', 'desktop-1440'] as const;

/**
 * A built-in profile, or one the project defines in agentlab.json `devices` (optionally extending a
 * built-in). Project devices take precedence.
 */
export function getDevice(id: string, custom: Readonly<Record<string, DeviceOverride>> = {}): DeviceProfile {
  const own = custom[id];
  if (own) {
    const base = own.extends ? DEVICES[own.extends] : undefined;
    if (own.extends && !base) {
      throw new LabError('unknown_device', `Device "${id}" extends unknown device "${own.extends}"`, { hint: `Built-in: ${Object.keys(DEVICES).join(', ')}` });
    }
    const viewport = own.viewport ?? base!.viewport;
    const isMobile = own.isMobile ?? base?.isMobile ?? false;
    return {
      id,
      label: own.label ?? `${id} ${viewport.width}x${viewport.height}${base ? ` (from ${base.id})` : ''}`,
      viewport,
      deviceScaleFactor: own.deviceScaleFactor ?? base?.deviceScaleFactor ?? 1,
      isMobile,
      hasTouch: own.hasTouch ?? base?.hasTouch ?? isMobile,
      userAgent: own.userAgent ?? base?.userAgent ?? (isMobile ? ANDROID_CHROME_UA : DESKTOP_CHROME_UA),
    };
  }
  const device = DEVICES[id];
  if (!device) {
    throw new LabError('unknown_device', `Unknown device profile "${id}"`, {
      hint: `Available: ${[...Object.keys(DEVICES), ...Object.keys(custom)].join(', ')}`,
    });
  }
  return device;
}

export const EMULATION_LIMITATIONS = [
  'Chromium device emulation on the host OS: not a real phone, not iOS Safari or Android WebView',
  'No on-screen keyboard, native permission prompts or device hardware',
  'Touch events are synthesised by the browser, not produced by a touchscreen',
];
