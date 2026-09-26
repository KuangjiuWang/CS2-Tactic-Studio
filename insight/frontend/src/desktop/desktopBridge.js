import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

export const isDesktopApp = Boolean(window.__TAURI_INTERNALS__);

const currentWindow = isDesktopApp ? getCurrentWindow() : null;
let fileDropSequence = 0;
const RELEASE_API = "https://api.github.com/repos/KuangjiuWang/CS2-Tactic-Studio/releases/latest";
const RELEASE_PAGE = "https://github.com/KuangjiuWang/CS2-Tactic-Studio/releases/latest";

function isNewerRelease(latest, current) {
  const parse = (value) => String(value || "").replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/);
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let index = 1; index <= 3; index += 1) {
    if (Number(a[index]) !== Number(b[index])) return Number(a[index]) > Number(b[index]);
  }
  return false;
}

async function checkTacticStudioUpdate() {
  try {
    return await check();
  } catch (signedError) {
    // Releases published before signed updater artifacts still need a usable update path.
    try {
      const response = await fetch(RELEASE_API, { headers: { Accept: "application/vnd.github+json" } });
      if (!response.ok) throw new Error(`GitHub release lookup failed: ${response.status}`);
      const release = await response.json();
      const version = String(release.tag_name || "").replace(/^v/i, "");
      if (!isNewerRelease(version, await getVersion())) return null;
      return {
        version,
        body: typeof release.body === "string" ? release.body : "",
        rawJson: { update_mode: "normal", manual_url: RELEASE_PAGE },
        close: async () => {},
      };
    } catch {
      throw signedError;
    }
  }
}

export const desktopBridge = isDesktopApp
  ? {
      minimize: () => currentWindow.minimize(),
      toggleMaximize: () => currentWindow.toggleMaximize(),
      close: () => currentWindow.close(),
      startDragging: () => currentWindow.startDragging(),
      isMaximized: () => currentWindow.isMaximized(),
      onMaximizeChange(callback) {
        let active = true;
        const unlistenPromise = currentWindow.onResized(async () => {
          if (active) callback(await currentWindow.isMaximized());
        });
        return () => {
          active = false;
          void unlistenPromise.then((unlisten) => unlisten());
        };
      },
      getVersion,
      checkForUpdate: checkTacticStudioUpdate,
      relaunch: () => relaunch(),
      async saveTacticPackage(tacticId, suggestedName, title) {
        const destination = await save({
          title: title || "Export CS2 tactic package",
          defaultPath: suggestedName,
          filters: [{ name: "CS2 tactic package", extensions: ["cstactic"] }],
        });
        if (!destination) return null;
        return invoke("export_tactic_package", { tacticId: String(tacticId), destination });
      },
      readLegacyUiState: () => invoke("read_legacy_ui_state"),
      resolveDroppedFilePaths(files) {
        const droppedFiles = Array.from(files || []);
        if (!droppedFiles.length) return Promise.resolve([]);
        const token = `${Date.now().toString(36)}_${(++fileDropSequence).toString(36)}`;
        const registry = window.__LITECUT_DROPPED_FILES__
          || (window.__LITECUT_DROPPED_FILES__ = Object.create(null));
        registry[token] = droppedFiles;
        return invoke("resolve_dropped_file_paths", { token })
          .then((paths) => (Array.isArray(paths) ? paths : []))
          .finally(() => {
            delete registry[token];
          });
      },
      writeClipboardText: (text) => writeText(String(text ?? "")),
      launchCs2Inspect: (hex) => invoke("launch_cs2_inspect", { hex: String(hex ?? "") }),
      async showOpenDialog(options = {}) {
        const properties = Array.isArray(options.properties) ? options.properties : [];
        const selected = await open({
          title: options.title,
          defaultPath: options.defaultPath,
          filters: options.filters,
          directory: properties.includes("openDirectory"),
          multiple: properties.includes("multiSelections"),
        });
        const filePaths = selected == null ? [] : Array.isArray(selected) ? selected : [selected];
        return { canceled: filePaths.length === 0, filePaths };
      },
      onFileDragDrop(callback) {
        let active = true;
        let scaleFactor = window.devicePixelRatio || 1;
        void currentWindow.scaleFactor().then((value) => {
          if (Number.isFinite(value) && value > 0) scaleFactor = value;
        }).catch(() => {});
        const unlistenPromise = currentWindow.onDragDropEvent(({ payload }) => {
          if (!active) return;
          const logicalPosition = payload.position?.toLogical?.(scaleFactor);
          callback({
            ...payload,
            position: logicalPosition
              ? { x: logicalPosition.x, y: logicalPosition.y }
              : null,
          });
        });
        return () => {
          active = false;
          void unlistenPromise.then((unlisten) => unlisten());
        };
      },
      async chooseDemoFiles() {
        try {
          const selected = await open({
            title: "选择 CS2 Demo",
            filters: [{ name: "CS2 Demo", extensions: ["dem"] }],
            multiple: true,
          });
          return selected == null ? [] : Array.isArray(selected) ? selected : [selected];
        } catch {
          return [];
        }
      },
      async chooseDirectory(defaultPath = "", title = "选择文件夹") {
        try {
          const selected = await open({
            title,
            defaultPath: typeof defaultPath === "string" && defaultPath.trim() ? defaultPath.trim() : undefined,
            directory: true,
            multiple: false,
          });
          return typeof selected === "string" ? selected : "";
        } catch {
          return "";
        }
      },
      async showItemInFolder(itemPath) {
        if (typeof itemPath !== "string" || !itemPath.trim()) return false;
        try {
          await revealItemInDir(itemPath.trim());
          return true;
        } catch {
          return false;
        }
      },
      openExternal: (url) => openUrl(url),
    }
  : null;
