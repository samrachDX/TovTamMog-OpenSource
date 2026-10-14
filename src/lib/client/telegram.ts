/** The subset of the Telegram Mini App bridge this app uses. */
export type TelegramWebApp = {
  /** Raw signed string. This, and only this, is sent to the server for verification. */
  initData: string;
  ready(): void;
  expand(): void;
  isVersionAtLeast(version: string): boolean;
  showScanQrPopup(params: { text?: string }, callback?: (data: string) => boolean | void): void;
  closeScanQrPopup(): void;
  onEvent(event: string, handler: () => void): void;
  offEvent(event: string, handler: () => void): void;
  /**
   * Bot API 8.0+. Telegram asks the person once per bot and remembers the answer, which they
   * can change later in the bot's settings; the browser geolocation API may ask on every use
   * inside Telegram's in-app browser.
   */
  LocationManager?: {
    isInited: boolean;
    isLocationAvailable: boolean;
    isAccessRequested: boolean;
    isAccessGranted: boolean;
    init(callback?: () => void): void;
    getLocation(callback: (data: { latitude: number; longitude: number; horizontal_accuracy: number | null } | null) => void): void;
    openSettings(): void;
  };
  HapticFeedback?: {
    notificationOccurred(type: 'success' | 'error' | 'warning'): void;
    impactOccurred(style: 'light' | 'medium' | 'heavy'): void;
  };
};

export function telegram(): TelegramWebApp | null {
  if (typeof window === 'undefined') return null;
  const tg = (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
  return tg && typeof tg.initData === 'string' && tg.initData.length > 0 ? tg : null;
}

/** Opens the native scanner. Resolves with the scanned text, or null if the user closed it. */
export function scanQr(tg: TelegramWebApp, prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      tg.offEvent('scanQrPopupClosed', onClosed);
      resolve(value);
    };
    const onClosed = () => finish(null);
    tg.onEvent('scanQrPopupClosed', onClosed);
    tg.showScanQrPopup({ text: prompt }, (data) => {
      finish(data);
      return true; // closes the popup
    });
  });
}
