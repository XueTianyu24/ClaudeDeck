import { invoke } from "@tauri-apps/api/core";

/**
 * UI 偏好的统一存取。
 *
 * **真相在后端** `%APPDATA%\ClaudeDeck\ui-prefs.json`（每次改动同步写盘），
 * localStorage 只是首屏免闪烁的同步快取。原因：webview 的 localStorage 是延迟
 * 批量落盘的，托盘「退出」（`app.exit(0)`）/ 更新重启 / taskkill 都等价硬退出，
 * 刚改的值会被吞掉——主题「选了不记住」就是这么来的（v0.12.7 修主题，v0.12.8
 * 把其余偏好一并搬来）。
 *
 * 值一律是字符串，与 localStorage 语义一一对应；结构化的值自己 JSON.stringify。
 */

/** 已搬到后端的偏好键。新增偏好项：写进这里 + 用 setPref 存，后端无需改动。 */
export const PREF_KEYS = [
  "cd-theme", // 深 / 浅主题
  "cd-notify", // 通知设置（JSON：桌面通知 / 提示音 / 阈值 / 关窗到托盘）
  "cd-update-proxy", // 更新代理
  "cd-groups-expanded", // 会话监控里展开的项目分组（JSON 数组）
  "cd-skill-view", // 技能视图 grid / list
  "cd-update-dismissed", // 「忽略此版本」记住的版本号
] as const;

/** 后端偏好是否已读回。读回之前只写快取，避免用 localStorage 旧值反盖后端新值。 */
let ready = false;

/** 双写：localStorage 快取 + 后端文件（同步落盘）。 */
export function setPref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 存不上就只本次会话生效 */
  }
  if (ready) invoke("set_ui_pref", { key, value }).catch(() => {});
}

/**
 * 启动时拉一次后端偏好并回填 localStorage（让之后才挂载的子视图同步读到正确值），
 * 返回后端现有的偏好表交给调用方校正内存里的 state。无论成败都会解除写入封印。
 */
export async function syncPrefs(): Promise<Record<string, string>> {
  try {
    const prefs = await invoke<Record<string, string>>("get_ui_prefs");
    for (const [k, v] of Object.entries(prefs)) {
      try {
        localStorage.setItem(k, v);
      } catch {
        /* ignore */
      }
    }
    return prefs;
  } finally {
    ready = true;
  }
}

/**
 * 老用户首次升级：后端还没有的项，把本地现有值迁进去（在 syncPrefs 之后调用）。
 */
export function migrateMissing(backend: Record<string, string>) {
  for (const k of PREF_KEYS) {
    if (backend[k] !== undefined) continue;
    const v = localStorage.getItem(k);
    if (v !== null) setPref(k, v);
  }
}
