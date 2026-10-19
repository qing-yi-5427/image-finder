import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
test("model downloads resume Range partials and reject corrupt same-size cache before publishing", async () => {
  const payload = Buffer.alloc(65536);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  const expected = createHash("sha256").update(payload).digest("hex");
  const requests: string[] = [];
  let corrupt = false;
  const server = http.createServer((req, res) => {
    const range = req.headers.range;
    requests.push(range ?? "full");
    const start = range
      ? Number(range.replace("bytes=", "").replace("-", ""))
      : 0;
    if (range)
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${payload.length - 1}/${payload.length}`,
      });
    else res.writeHead(200);
    res.end(
      corrupt ? Buffer.alloc(payload.length - start) : payload.subarray(start),
    );
    corrupt = false;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const module = await import(
      new URL("../../scripts/ai-download.mjs", import.meta.url).href
    );
    const base = await mkdtemp(path.join(tmpdir(), "finder-download-"));
    const destination = path.join(base, "model.bin");
    await writeFile(destination + ".part", payload.subarray(0, 1024));
    const address = server.address() as any;
    const url = `http://127.0.0.1:${address.port}/weights`;
    await module.download(url, destination, payload.length, expected);
    assert.equal(requests[0], "bytes=1024-");
    assert.deepEqual(await readFile(destination), payload);
    await writeFile(destination, Buffer.alloc(payload.length));
    corrupt = true;
    await module.download(url, destination, payload.length, expected);
    assert.ok(requests.length >= 3);
    assert.deepEqual(await readFile(destination), payload);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
