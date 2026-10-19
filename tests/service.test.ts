import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  utimes,
  readFile,
  rename,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { ImageFinderService } from "../src/core/service.js";
async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), "finder-service-"));
  const source = path.join(base, "source");
  await mkdir(source);
  await writeFile(
    path.join(source, "81470181_p0.png"),
    await sharp({
      create: { width: 128, height: 256, channels: 3, background: "#3366cc" },
    })
      .png()
      .toBuffer(),
  );
  await utimes(path.join(source, "81470181_p0.png"), new Date(0), new Date(0));
  const service = new ImageFinderService(path.join(base, "data"));
  const root = await service.invoke("library.add", { directory: source });
  await service.invoke("library.scan", { rootId: root.id });
  return {
    service,
    root,
    base,
    source,
    file: (await service.invoke("files.query")).items[0],
  };
}
test("service contract connects detail, alias category pagination and inherit reset", async () => {
  const { service: s, file } = await fixture();
  try {
    s.catalog.applyArtwork({
      id: "81470181",
      title: "Test",
      creator: { id: "1", name: "creator" },
      pageCount: 1,
      publishedAt: "2020",
      tags: [{ name: "初音ミク" }],
      raw: {},
    });
    const tags = await s.invoke("tags.list");
    await s.invoke("tags.update", { tagId: tags[0].id, category: "character" });
    const style = await s.invoke("tags.create", {
      name: "0style",
      category: "style",
    });
    assert.equal(
      (await s.invoke("tags.list", { category: "character", limit: 1 }))[0].id,
      tags[0].id,
    );
    await s.invoke("tags.addAlias", { tagId: tags[0].id, alias: "初音未来" });
    await s.invoke("tags.override", {
      fileIds: [file.id],
      tagId: tags[0].id,
      mode: "exclude",
    });
    assert.equal(
      (
        await s.invoke("files.query", {
          filter: { tags: [{ ids: [tags[0].id] }] },
        })
      ).total,
      0,
    );
    await s.invoke("tags.override", {
      fileIds: [file.id],
      tagId: tags[0].id,
      mode: "inherit",
    });
    const detail = await s.invoke("files.detail", { fileId: file.id });
    assert.equal(detail.tags[0].effective, true);
    assert.ok(detail.tags[0].aliases.includes("初音未来"));
    assert.equal(detail.tags[0].rawSource[0].name, "初音ミク");
    assert.equal(detail.source.creatorId, "1");
    assert.equal(detail.processing.status, "pending");
    assert.equal(detail.format, "png");
    assert.equal(
      (await s.invoke("files.query", { filter: { formats: ["png"] } })).total,
      1,
    );
    await assert.rejects(
      s.invoke("files.favorite", {
        fileIds: [file.id, "unknown"],
        favorite: true,
      }),
      /FILE_NOT_FOUND/,
    );
    assert.equal(
      (await s.invoke("files.detail", { fileId: file.id })).favorite,
      false,
    );
    assert.ok(style);
  } finally {
    await s.close();
  }
});
test("service backup restore and safe output destinations preserve source originals", async () => {
  const { service: s, file, base, source } = await fixture();
  try {
    const tag = await s.invoke("tags.create", {
      name: "manual",
      category: "content",
    });
    await s.invoke("tags.override", {
      fileIds: [file.id],
      tagId: tag,
      mode: "add",
    });
    const collection = await s.invoke("collections.create", {
      name: "my collection",
      kind: "normal",
    });
    await s.invoke("collections.add", {
      collectionId: collection,
      fileIds: [file.id],
    });
    await s.invoke("files.favorite", { fileIds: [file.id], favorite: true });
    const backup = path.join(base, "backup.sqlite");
    await s.invoke("system.backup", { destination: backup });
    await s.invoke("system.export", {
      destination: path.join(base, "export.json"),
    });
    assert.equal(
      JSON.parse(await readFile(path.join(base, "export.json"), "utf8"))
        .file_tag_overrides.length,
      1,
    );
    await assert.rejects(
      s.invoke("system.export", {
        destination: path.join(source, "do-not-write.json"),
      }),
      /SOURCE_OUTPUT_FORBIDDEN/,
    );
    await assert.rejects(
      s.invoke("system.backup", {
        destination: path.join(base, "data", "catalog.sqlite"),
      }),
      /CATALOG_OUTPUT_FORBIDDEN/,
    );
    await assert.rejects(
      s.invoke("system.export", {
        destination: path.join(base, "export.json"),
      }),
      /OUTPUT_EXISTS/,
    );
    await s.invoke("files.favorite", { fileIds: [file.id], favorite: false });
    await s.invoke("system.restore", { source: backup });
    assert.equal(
      (
        await s.invoke("files.query", {
          filter: {
            favorite: true,
            collectionId: collection,
            tags: [{ ids: [tag] }],
          },
        })
      ).total,
      1,
    );
  } finally {
    await s.close();
  }
});
test("service serializes maintenance with processing; close cancels pending local work safely", async () => {
  const { service: s, file } = await fixture();
  const work = s.invoke("images.processPending", { limit: 1 });
  const clear = s.invoke("system.clearCache");
  await Promise.all([work, clear]);
  assert.equal(
    (await s.invoke("files.detail", { fileId: file.id })).processing.status,
    "pending",
  );
  await s.invoke("files.rate", { fileIds: [file.id], rating: 4 });
  const processing = s.invoke("images.processPending", { limit: 1 });
  const closing = s.close();
  await Promise.allSettled([processing, closing]);
  await assert.rejects(s.invoke("system.stats"), /SERVICE_CLOSING/);
});
test("service offline root retains manual metadata, relocation keeps stable fileId", async () => {
  const { service: s, file, source, base, root } = await fixture();
  try {
    await s.invoke("files.rate", { fileIds: [file.id], rating: 5 });
    await s.invoke("local.pause", { kind: "scan" });
    const moved = path.join(base, "moved");
    await rename(source, moved);
    const offline = await s.invoke("library.scan", { rootId: root.id });
    assert.equal(offline.complete, false);
    assert.equal(
      (await s.invoke("files.detail", { fileId: file.id })).rating,
      5,
    );
    await s.invoke("library.relocate", { rootId: root.id, directory: moved });
    await s.invoke("library.scan", { rootId: root.id });
    assert.equal((await s.invoke("files.query")).items[0].id, file.id);
    assert.equal(
      (await s.invoke("files.detail", { fileId: file.id })).rating,
      5,
    );
  } finally {
    await s.close();
  }
});
test("cross-directory restore rebuilds missing preview on demand and invalid restore rolls back", async () => {
  const { service: s, file, base } = await fixture();
  let restored: ImageFinderService | undefined;
  try {
    await s.invoke("files.rate", { fileIds: [file.id], rating: 5 });
    await s.invoke("images.processPending", { limit: 1 });
    const backup = path.join(base, "migrate.sqlite");
    await s.invoke("system.backup", { destination: backup });
    restored = new ImageFinderService(path.join(base, "second-data"));
    const result = await restored.invoke("system.restore", { source: backup });
    assert.ok(result.local);
    const detail = await restored.invoke("files.detail", { fileId: file.id });
    assert.equal(detail.processing.status, "pending");
    assert.ok(detail.palette.length > 0);
    const preview = await restored.invoke("images.resolve", {
      fileId: file.id,
      variant: "thumbnail",
    });
    assert.ok((await readFile(preview.path)).length > 0);
    assert.equal(
      (await restored.invoke("files.detail", { fileId: file.id })).rating,
      5,
    );
    await restored.invoke("library.scan", { rootId: file.rootId });
    assert.equal((await restored.invoke("files.query")).total, 1);
    await restored.invoke("settings.update", { cacheLimitBytes: 0 });
    assert.equal(
      (await restored.invoke("files.detail", { fileId: file.id })).processing
        .status,
      "evicted",
    );
    assert.equal(
      (await restored.invoke("images.processPending", { limit: 1 })).processed,
      0,
    );
    const requested = await restored.invoke("images.resolve", {
      fileId: file.id,
      variant: "thumbnail",
    });
    assert.ok((await readFile(requested.path)).length > 0);
    const invalid = path.join(base, "invalid.sqlite");
    await writeFile(invalid, "not sqlite");
    await assert.rejects(
      restored.invoke("system.restore", { source: invalid }),
    );
    assert.equal(
      (await restored.invoke("files.detail", { fileId: file.id })).rating,
      5,
    );
  } finally {
    await s.close();
    if (restored) await restored.close();
  }
});
test("data directory itself and overlapping source roots are rejected", async () => {
  const { service: s, base, source } = await fixture();
  try {
    await assert.rejects(
      s.invoke("library.add", { directory: base }),
      /ROOT_OVERLAP/,
    );
    await assert.rejects(
      s.invoke("library.add", { directory: path.join(base, "data") }),
      /SOURCE_DATA_OVERLAP/,
    );
    const nested = path.join(source, "nested");
    await mkdir(nested);
    await assert.rejects(
      s.invoke("library.add", { directory: nested }),
      /ROOT_OVERLAP/,
    );
  } finally {
    await s.close();
  }
});
test("concurrent thumbnail requests decode once and cached hits do not interrupt scanning", async () => {
  const { service: s, file } = await fixture();
  try {
    let calls = 0;
    const process = s.images.process.bind(s.images);
    s.images.process = async (id) => {
      calls++;
      return process(id);
    };
    const previews = await Promise.all(
      Array.from({ length: 8 }, () =>
        s.invoke("images.resolve", { fileId: file.id, variant: "thumbnail" }),
      ),
    );
    assert.equal(calls, 1);
    assert.ok(previews.every((x) => x.path === previews[0].path));
    await s.invoke("images.resolve", { fileId: file.id, variant: "thumbnail" });
    assert.equal(calls, 1);
  } finally {
    await s.close();
  }
});
test("public jobs page counts follows the renderer array contract", async () => {
  const { service: s } = await fixture();
  try {
    await s.invoke("jobs.enqueue", { artworkIds: ["81470181"] });
    const page = await s.invoke("jobs.list", {});
    assert.ok(Array.isArray(page.counts));
    assert.equal(
      page.counts.find((x: any) => x.status === "waiting")?.count,
      1,
    );
  } finally {
    await s.close();
  }
});
test("startPaused gates persisted active source and AI states before dispatch", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "finder-start-paused-"));
  let service = new ImageFinderService(data, {startPaused:true});
  service.queue.enqueue(["12345"]);
  service.catalog.db.exec("UPDATE source_state SET paused=0,reason='challenge'; UPDATE ai_state SET paused=0");
  await service.close();
  let requests = 0;
  service = new ImageFinderService(data, {startPaused:true,fetcher:async()=>{requests++;throw new Error('must not dispatch');}});
  try {
    assert.equal(service.queue.sourceState().paused,1);
    assert.equal(service.queue.sourceState().reason,'challenge');
    assert.ok(service.ai.status().queues.every(q=>q.paused));
    assert.equal(service.local.status().scanPaused,true);
    assert.equal(service.local.status().imagesPaused,true);
    assert.equal(await service.queue.tick(),false);
    assert.equal(requests,0);
    assert.equal(service.queue.list()[0].attempts,0);
  } finally {await service.close();}
});
