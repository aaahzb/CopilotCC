"use strict";

const readline = require("node:readline");

// 固定行为探针：真实 PTY 必须传播尺寸、连续输出、UTF-8 中文和退出码。
console.log(`SIZE:${process.stdout.columns}x${process.stdout.rows}`);
process.stdout.on("resize", () => {
  console.log(`SIZE:${process.stdout.columns}x${process.stdout.rows}`);
});

let ticks = 0;
const timer = setInterval(() => {
  ticks += 1;
  console.log(`TICK:${ticks}`);
}, 100);

readline.createInterface({ input: process.stdin, terminal: true }).on("line", (line) => {
  if (line === "ECHO") console.log("中文输出:你好");
  if (line === "EXIT") {
    clearInterval(timer);
    process.exit(7);
  }
});
