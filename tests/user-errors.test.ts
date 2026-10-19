import test from "node:test";
import assert from "node:assert/strict";
import { userError } from "../src/user-errors.js";

test("user errors remove IPC wrappers and give directory recovery advice", () => {
  assert.equal(
    userError(
      new Error(
        "Error invoking remote method 'image-finder:invoke': Error: 所选目录与原索引不匹配。",
      ),
    ),
    "所选目录与原索引不匹配。",
  );
  assert.match(
    userError(
      new Error(
        "Error invoking remote method 'image-finder:invoke': Error: ENOENT: no such file or directory, realpath 'E:/missing.jpg'",
      ),
    ),
    /重新扫描原目录/,
  );
  assert.match(userError(new Error("ROOT_OVERLAP")), /已关联的原目录重叠/);
  assert.match(userError(new Error("EACCES: denied")), /访问权限/);
});
