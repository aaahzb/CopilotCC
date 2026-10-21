import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Claude Code 侧边栏",
    // version 缺省继承 package.json（release CI 按 tag 改写 package.json）
    // 固定 key → 固定扩展 ID（cnalihjaacpahpjkpneacjcfbhboglno），桥接 Origin 白名单要用
    key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsCxrz7hkE/bk3KIQBPScgsiurmqb00Ff1RFcnkpJ6tCZniqGY9ERGtqg5JvRWPAPQLDZDBXJKU4yHxncbfxTcqwg/J0lqkNzrUn5A9GivdhzjDG6ERRE31pr9vxz1cfHQbveZaCSspG9Dico8NgGajX0//nLJKaGz9TeOR4902SS4YnfQ4aRxyKRSzAeghdQYtOoUh2fXhO3S94PQmFTlWyAW0XaxDbmn5vWpK9NDqkeBJmq1v9t2EtNCCWIUB3xZ9e0kd7t+K7ZnI3O6htVxv9G9/Ttx1wST+CGDq1q8S/rqCyDKyIisntgYnHq5sC/44pmZziwpF1wkGQmmGhkXwIDAQAB",
    permissions: ["sidePanel", "activeTab", "scripting", "storage", "contextMenus"],
    host_permissions: ["ws://127.0.0.1/*", "ws://localhost/*", "http://*/*", "https://*/*"],
    action: { default_title: "Claude Code 侧边栏" },
  },
});
