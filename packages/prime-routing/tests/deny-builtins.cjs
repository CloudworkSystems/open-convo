const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function denyDangerousBuiltins(request, parent, isMain) {
  if (request === "node:child_process" || request === "child_process" || request === "node:net" || request === "net" || request === "node:http" || request === "http" || request === "node:https" || request === "https") {
    throw new Error(`test blocked ${request}`);
  }
  return originalLoad.call(this, request, parent, isMain);
};
global.fetch = () => {
  throw new Error("test blocked fetch");
};
