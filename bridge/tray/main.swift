import Cocoa
import Foundation

/**
 ccc-tray-helper · CopilotCC Bridge 的 macOS 菜单栏托盘助手（自研，arm64 原生）。
 为什么自研：systray2@2.1.4 自带的 tray_darwin_release 是 x86_64 单架构 Mach-O，没装 Rosetta 的
 Apple Silicon 直接 "Bad CPU type" 起不来——表现为 App 能打开、桥接在跑，但菜单栏永远没有图标
 （2026-10-23 实锤：二进制头部 cputype 0x01000007 = x86_64）。

 协议与 systray2 的 JS 客户端逐点对齐（口径以 node_modules/systray2/index.js 为准）：
 - stdout：启动后先打一行 {"type":"ready"}；此后每次菜单点击打一行
   {"type":"clicked","item":<该项原始字典回显>,"seq_id":-1,"__id":<该项 __id>}（客户端按 __id 合并字段）
 - stdin：行分隔 JSON。首行是整份菜单（无 type 字段：
   {"icon":"<base64 png>","title":"","tooltip":"...","items":[...],"isTemplateIcon":false}；
   注意 icon 已被客户端 resolveIcon 转成 base64 内容而非路径），其后为动作
   {"type":"update-menu","menu":{...}} / {"type":"update-item","item":{...},"seq_id":-1} /
   {"type":"update-menu-and-item",...} / {"type":"exit"}；stdin EOF 同样退出（父进程已走）
 - 菜单项字段：title（"<SEPARATOR>" = 分隔线）/ tooltip / checked / enabled / hidden /
   icon(base64) / isTemplateIcon / items(子菜单) / __id（客户端分配的点击回执 id，必须回显）
 */

/// 原始菜单项字典按 __id 留存：点击时原样回显（客户端 internalIdMap 按 __id 合并）
private var rawItemsById: [Int: [String: Any]] = [:]
/// 已建 NSMenuItem 按 __id 留存：update-item 时定位
private var nsItemsById: [Int: NSMenuItem] = [:]
/// 唯一的状态栏图标
private var statusItem: NSStatusItem?

/// 向 stdout 打一行 JSON（FileHandle 直写无缓冲；ready/clicked 都走这里）
private func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

/// base64 图标 → NSImage（空串/解码失败返回 nil）；菜单栏图标统一 18pt，isTemplate 按协议字段
private func imageFromB64(_ b64: String?, template: Bool) -> NSImage? {
    guard let b64 = b64, !b64.isEmpty, let data = Data(base64Encoded: b64), let img = NSImage(data: data) else { return nil }
    img.isTemplate = template
    img.size = NSSize(width: 18, height: 18)
    return img
}

/// 菜单点击汇聚：representedObject 携带 __id，回显原始字典 + __id + seq_id
private final class Clicker: NSObject {
    @objc func handle(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? Int else { return }
        emit(["type": "clicked", "item": rawItemsById[id] ?? [:], "seq_id": -1, "__id": id])
    }
}
/// NSMenuItem.target 是弱引用，必须用全局强引用托住
private let clicker = Clicker()

/// 按协议字典递归构建一个 NSMenuItem，并把原始字典与控件按 __id 登记（点击回显与 update-item 定位用）
private func buildItem(_ dict: [String: Any]) -> NSMenuItem {
    let title = dict["title"] as? String ?? ""
    // 分隔线是 title 约定（客户端 SysTray.separator = {title: "<SEPARATOR>"}），不参与点击登记
    if title == "<SEPARATOR>" { return NSMenuItem.separator() }
    let item = NSMenuItem(title: title, action: #selector(Clicker.handle(_:)), keyEquivalent: "")
    item.target = clicker
    item.toolTip = dict["tooltip"] as? String
    item.isEnabled = dict["enabled"] as? Bool ?? true // 客户端 itemTrimmer 缺省 true
    if let c = dict["checked"] as? Bool { item.state = c ? .on : .off }
    if let h = dict["hidden"] as? Bool { item.isHidden = h }
    if let img = imageFromB64(dict["icon"] as? String, template: dict["isTemplateIcon"] as? Bool ?? false) { item.image = img }
    if let subs = dict["items"] as? [[String: Any]], !subs.isEmpty {
        let sub = NSMenu()
        for s in subs { sub.addItem(buildItem(s)) } // 子菜单递归
        item.submenu = sub
    }
    if let id = dict["__id"] as? Int {
        rawItemsById[id] = dict
        nsItemsById[id] = item
        item.representedObject = id
    }
    return item
}

/// 应用整份菜单：图标/悬浮提示/菜单项全量替换（首行初始菜单与 update-menu 共用）
private func applyMenu(_ menu: [String: Any]) {
    guard let statusItem else { return }
    if let btn = statusItem.button {
        btn.image = imageFromB64(menu["icon"] as? String, template: menu["isTemplateIcon"] as? Bool ?? false)
        btn.toolTip = menu["tooltip"] as? String
        btn.title = menu["title"] as? String ?? ""
    }
    rawItemsById.removeAll()
    nsItemsById.removeAll()
    let m = NSMenu()
    for case let dict as [String: Any] in (menu["items"] as? [[String: Any]] ?? []) {
        m.addItem(buildItem(dict))
    }
    statusItem.menu = m
}

/// update-item：按 __id 定位已建菜单项，就地更新可见字段并回写原始字典（保持点击回显一致）
private func applyItemUpdate(_ it: [String: Any]) {
    guard let id = it["__id"] as? Int, let ns = nsItemsById[id] else { return }
    rawItemsById[id] = it
    if let t = it["title"] as? String { ns.title = t }
    ns.toolTip = it["tooltip"] as? String
    if let e = it["enabled"] as? Bool { ns.isEnabled = e }
    if let c = it["checked"] as? Bool { ns.state = c ? .on : .off }
    if let h = it["hidden"] as? Bool { ns.isHidden = h }
    if let img = imageFromB64(it["icon"] as? String, template: it["isTemplateIcon"] as? Bool ?? false) { ns.image = img }
}

/// 处理一行入站 JSON：无 type 字段 = 整份菜单（首行初始化也长这样）；有 type 按动作分派
private func handleLine(_ line: String) {
    guard let data = line.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
    switch obj["type"] as? String {
    case "exit": exit(0)
    case "update-menu": if let m = obj["menu"] as? [String: Any] { applyMenu(m) }
    case "update-item": if let it = obj["item"] as? [String: Any] { applyItemUpdate(it) }
    case "update-menu-and-item":
        if let m = obj["menu"] as? [String: Any] { applyMenu(m) }
        if let it = obj["item"] as? [String: Any] { applyItemUpdate(it) }
    default: applyMenu(obj) // 无 type 字段：整份菜单（首行初始化）
    }
}

/// stdin 行泵：字节级按 \n 切分（0x0A 不会出现在多字节 UTF-8 序列内部，中文标题安全），
/// 不完整尾部跨 chunk 累积；UI 操作统一切回主线程
private func startStdinPump() {
    var pending = Data()
    FileHandle.standardInput.readabilityHandler = { fh in
        let chunk = fh.availableData
        if chunk.isEmpty { exit(0) } // EOF：父进程已走，跟着退
        pending.append(chunk)
        while let nl = pending.firstIndex(of: 0x0A) {
            let line = pending.subdata(in: 0 ..< nl)
            pending.removeSubrange(0 ... nl)
            if let s = String(data: line, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty {
                DispatchQueue.main.async { handleLine(s) }
            }
        }
    }
}

// ---- 主流程：建状态栏图标 → 起 stdin 行泵 → 报 ready → 进 App 主循环（exit 动作或 EOF 退出）----
let app = NSApplication.shared
_ = app.setActivationPolicy(.accessory) // 助手自身也不占 Dock（与 .app 侧 LSUIElement 一致）
statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
startStdinPump()
emit(["type": "ready"]) // 客户端收到 ready 后才下发初始菜单
app.run()
