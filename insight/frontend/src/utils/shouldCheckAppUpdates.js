import { isDesktopApp } from "../desktop/desktopBridge.js";

/** Production desktop builds auto-check; desktop development can check manually. */
export async function shouldCheckAppUpdates({ manual = false } = {}) {
  return Boolean(isDesktopApp && (import.meta.env.PROD || manual));
}
