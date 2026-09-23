/** 是否应走 Cloudflare / Tauri updater 检查更新（Vite dev / 浏览器模式跳过）。 */
export async function shouldCheckAppUpdates() {
  // A derivative build must never consume the upstream project's update feed.
  return false;
}
