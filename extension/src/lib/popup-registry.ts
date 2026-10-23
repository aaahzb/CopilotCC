/**
 * 弹窗钉住注册表（纯状态机，零 chrome API 依赖，方便单测）。
 * 维护两层映射：弹窗窗口 → 被钉页面（打开即登记，用于同 tab 去重聚焦）；
 * 被钉页面 → 钉住信息（popup 上报别名后才有，用于页面徽标注入/重注入/摘除）。
 * chrome 事件接线在 entrypoints/background.ts。
 */

/** 钉住信息（页面徽标渲染所需） */
export interface PinInfo {
  /** 弹窗窗口 ID */
  winId: number;
  /** 被钉住的页面 tab ID */
  tabId: number;
  /** 徽标显示的别名（未选别名时为空串，徽标只显示图标） */
  aliasName: string;
  /** 徽标主题色色相 0-359（与别名色一致：hash(aliasId) % 360，由调用方算好传入） */
  hue: number;
}

export class PopupRegistry {
  private winToTab = new Map<number, number>(); // 弹窗 winId → 页面 tabId
  private pins = new Map<number, PinInfo>(); // 页面 tabId → 钉住信息

  /**
   * 登记弹窗窗口（windows.create 成功后调用）。
   * @param winId 弹窗窗口 ID
   * @param tabId 被钉住的页面 tabId
   */
  registerPopup(winId: number, tabId: number): void {
    this.winToTab.set(winId, tabId);
  }

  /**
   * 按页面 tab 查已登记的弹窗（同 tab 重复点"弹出"时聚焦旧窗而非再开）。
   * @param tabId 页面 tabId
   * @returns 弹窗 winId；没有返回 null
   */
  winForTab(tabId: number): number | null {
    for (const [w, t] of this.winToTab) if (t === tabId) return w;
    return null;
  }

  /**
   * 上报/更新钉住（popup 连上桥接、别名落定或换绑后调用）。
   * 同一弹窗改钉新 tab 时自动解除旧 tab 的钉住。
   * @param info 钉住信息
   * @returns 被替换掉的旧 tabId（调用方需去摘旧页徽标）；全新登记或无变化返回 null
   */
  pin(info: PinInfo): number | null {
    let replaced: number | null = null;
    for (const [t, p] of this.pins) {
      if (p.winId === info.winId && t !== info.tabId) {
        this.pins.delete(t);
        replaced = t;
      }
    }
    this.pins.set(info.tabId, info);
    return replaced;
  }

  /**
   * 按页面 tab 查钉住信息（tabs.onUpdated 完成加载后重注入徽标的参数来源）。
   * @param tabId 页面 tabId
   * @returns 钉住信息；未钉返回 null
   */
  pinForTab(tabId: number): PinInfo | null {
    return this.pins.get(tabId) ?? null;
  }

  /**
   * 弹窗窗口被关闭：清登记与钉住。
   * @param winId 被关窗口 ID
   * @returns 需摘除徽标的页面 tabId；该窗未登记或未钉住返回 null
   */
  windowRemoved(winId: number): number | null {
    const tabId = this.winToTab.get(winId) ?? null;
    this.winToTab.delete(winId);
    for (const [t, p] of this.pins) {
      if (p.winId === winId) {
        this.pins.delete(t);
        return t;
      }
    }
    return tabId !== null && this.pins.has(tabId) ? tabId : null;
  }

  /**
   * 页面 tab 被关闭：清钉住（徽标随页面消失，无需主动摘）与该页的弹窗登记。
   * @param tabId 被关 tab ID
   * @returns 受影响的弹窗 winId；无则 null
   */
  tabRemoved(tabId: number): number | null {
    this.pins.delete(tabId);
    for (const [w, t] of this.winToTab) {
      if (t === tabId) {
        this.winToTab.delete(w);
        return w;
      }
    }
    return null;
  }
}
