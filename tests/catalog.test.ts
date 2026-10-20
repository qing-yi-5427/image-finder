import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Catalog } from "../src/core/catalog.js";
import type { ArtworkPayload } from "../src/contracts.js";
const artwork = (tags = ["初音ミク"]): ArtworkPayload => ({
  id: "81470181",
  title: "测试作品",
  creator: { id: "123", name: "画师" },
  pageCount: 2,
  publishedAt: "2020-01-01",
  tags: tags.map((name) => ({
    name,
    translation: "translation is not an alias",
  })),
  raw: { fixture: true },
});
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "finder-catalog-"));
  const c = new Catalog(path.join(dir, "data"));
  const root = c.addRoot(path.join(dir, "source"));
  const insert = c.db.prepare(
    "INSERT INTO files(id,root_id,relative_path,bytes,mtime_ms,added_at,artwork_id,page,width,height,format) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  );
  insert.run(
    "a",
    root.id,
    "81470181_p0.jpg",
    10,
    1,
    1,
    "81470181",
    0,
    2000,
    3000,
    "jpeg",
  );
  insert.run(
    "b",
    root.id,
    "81470181_p1.jpg",
    20,
    2,
    2,
    "81470181",
    1,
    3000,
    2000,
    "jpeg",
  );
  insert.run(
    "c",
    root.id,
    "12345678_p0.png",
    30,
    3,
    3,
    "12345678",
    0,
    null,
    null,
    "png",
  );
  return { c, dir, root };
}
test("source refresh preserves manual tags, exclusion, rating, favorite, collection; same artwork inherits", async () => {
  const { c } = await fixture();
  try {
    c.applyArtwork(artwork());
    const tag = (c.tags()[0] as any).id;
    const manual = c.createTag("我的标签", "style");
    c.overrideTags(["a"], [tag], "exclude");
    c.overrideTags(["a"], [manual], "add");
    c.setFavorite(["a"], true);
    c.setRating(["a"], 5);
    const collection = c.createCollection("收藏夹", "normal");
    c.collectionItems(collection, ["a"]);
    c.applyArtwork(artwork());
    assert.equal(
      c.query({ filter: { tags: [{ ids: [tag] }] } }).items[0].id,
      "b",
    );
    assert.equal(c.query({ filter: { tags: [{ ids: [manual] }] } }).total, 1);
    assert.equal(
      c.query({
        filter: { favorite: true, ratingMin: 5, collectionId: collection },
      }).total,
      1,
    );
    assert.equal(c.tags("translation").length, 0);
  } finally {
    c.close();
  }
});
test("alias conflict rejected and tag merge preserves exclusion + smart rules", async () => {
  const { c } = await fixture();
  try {
    const a = c.createTag("初音ミク", "character", ["Hatsune Miku"]);
    const b = c.createTag("初音未来", "character");
    assert.throws(() => c.addAlias(b, "hatsune miku"), /ALIAS_CONFLICT/);
    c.overrideTags(["a"], [a], "add");
    c.overrideTags(["a"], [b], "exclude");
    const smart = c.createCollection("角色", "smart", { tags: [{ ids: [a] }] });
    c.mergeTags(a, b);
    assert.equal(c.query({ filter: { collectionId: smart } }).total, 0);
    assert.equal((c.collections()[0] as any).filter.tags[0].ids[0], b);
    assert.equal(c.tags("Hatsune")[0].id, b);
  } finally {
    c.close();
  }
});
test("structured combinations, exclusions, grouping, smart constraints remain intersections", async () => {
  const { c } = await fixture();
  try {
    c.applyArtwork(artwork());
    const t = (c.tags()[0] as any).id;
    assert.equal(
      c.query({
        filter: { heightMin: 2560, tags: [{ ids: [t] }], excludeTagIds: [] },
      }).total,
      1,
    );
    assert.equal(c.query({ filter: { text: "初音" } }).total, 2);
    assert.equal(c.query({ filter: { text: "测试%" } }).total, 0);
    const smart = c.createCollection("高图", "smart", { heightMin: 2560 });
    assert.equal(
      c.query({ filter: { collectionId: smart, heightMin: 1000 } }).total,
      1,
    );
    const grouped = c.query({
      filter: { heightMin: 2560 },
      stackArtworks: true,
    });
    assert.equal(grouped.total, 1);
    assert.equal(grouped.items[0].matchedCount, 1);
    assert.equal(grouped.items[0].localCount, 2);
    assert.equal(c.query({ limit: 1, offset: 0 }).items[0].id, "c");
    assert.equal(c.query({ limit: 1, offset: 1 }).items[0].id, "b");
  } finally {
    c.close();
  }
});
test("SQL color filtering leaves unanalyzed explicit; small color mass excluded", async () => {
  const { c } = await fixture();
  try {
    c.db.prepare("INSERT INTO features VALUES(?,?,?,?,?,?)").run(
      "a",
      JSON.stringify([
        { hex: "#0000ff", weight: 0.01 },
        { hex: "#ffffff", weight: 0.99 },
      ]),
      0.9,
      0.01,
      "neutral",
      "test",
    );
    c.db
      .prepare("INSERT INTO features VALUES(?,?,?,?,?,?)")
      .run(
        "b",
        JSON.stringify([{ hex: "#0000ff", weight: 1 }]),
        0.2,
        1,
        "cool",
        "test",
      );
    assert.deepEqual(
      c
        .query({
          filter: { color: { hex: "#0000ff", tolerance: 1, minWeight: 0.1 } },
        })
        .items.map((x) => x.id),
      ["b"],
    );
    assert.equal(
      c.query({
        filter: {
          color: {
            hex: "#0000ff",
            tolerance: 1,
            minWeight: 0.1,
            includeUnanalyzed: true,
          },
        },
      }).total,
      2,
    );
  } finally {
    c.close();
  }
});
test("WAL consistent backup and JSON export recover manual organization", async () => {
  const { c, dir } = await fixture();
  const backup = path.join(dir, "backup.sqlite");
  const exported = path.join(dir, "export.json");
  try {
    const tag = c.createTag("手动", "content", ["manual"]);
    c.overrideTags(["a"], [tag], "add");
    c.setFavorite(["a"], true);
    const collection = c.createCollection("已选", "normal");
    c.collectionItems(collection, ["a"]);
    await c.backup(backup);
    await c.export(exported);
    const json = JSON.parse(await readFile(exported, "utf8"));
    assert.equal(json.file_tag_overrides.length, 1);
    assert.equal(json.collection_items.length, 1);
    assert.equal(json.files[0].id, "a");
    const restore = await mkdtemp(path.join(tmpdir(), "finder-restored-"));
    await copyFile(backup, path.join(restore, "catalog.sqlite"));
    const restored = new Catalog(restore);
    try {
      assert.equal(
        restored.query({
          filter: {
            favorite: true,
            collectionId: collection,
            tags: [{ ids: [tag] }],
          },
        }).total,
        1,
      );
    } finally {
      restored.close();
    }
  } finally {
    c.close();
  }
});
test("invalid source page cannot overwrite prior good metadata", async () => {
  const { c } = await fixture();
  try {
    c.applyArtwork(artwork());
    assert.throws(
      () => c.applyArtwork({ ...artwork(["bad"]), pageCount: 1 }),
      /PAGE_OUT_OF_RANGE/,
    );
    assert.equal(c.tags("bad").length, 0);
    assert.equal(c.tags("初音").length, 1);
  } finally {
    c.close();
  }
});

test("author paging and collection deletion preserve indexed files", async () => {
  const { c } = await fixture();
  try {
    c.applyArtwork(artwork());
    c.db.prepare("INSERT INTO creators VALUES(?,?)").run("unused", "Unused");
    assert.deepEqual(c.authors("画师"), [
      { id: "123", name: "画师", usageCount: 2 },
    ]);
    assert.equal(c.authors("", 0, 1).length, 1);
    assert.equal(c.authors("", 1, 1).length, 1);
    assert.deepEqual(c.authors("", 2, 1), []);
    const collection = c.createCollection("delete me", "normal");
    c.collectionItems(collection, ["a", "b"]);
    c.deleteCollection(collection);
    assert.deepEqual(c.collections(), []);
    assert.equal(
      (c.db.prepare("SELECT COUNT(*) n FROM collection_items").get() as any).n,
      0,
    );
    assert.equal(c.query({}).total, 3);
    c.deleteCollection(collection);
  } finally {
    c.close();
  }
});

test("color sorting can retain distant and unknown files with stable unknown-last order", async () => {
  const { c } = await fixture();
  try {
    const insert = c.db.prepare("INSERT INTO features VALUES(?,?,?,?,?,?)");
    insert.run(
      "a",
      JSON.stringify([{ hex: "#ff0000", weight: 1 }]),
      0.5,
      1,
      "warm",
      "test",
    );
    insert.run(
      "b",
      JSON.stringify([{ hex: "#0000ff", weight: 1 }]),
      0.5,
      1,
      "cool",
      "test",
    );
    for (const stackArtworks of [false, true]) {
      const result = c.query({
        filter: { color: { hex: "#ff0000", tolerance: 0, restrict: false } },
        sort: "color",
        stackArtworks,
      });
      assert.deepEqual(
        result.items.map((f) => f.id),
        stackArtworks ? ["a", "c"] : ["a", "b", "c"],
      );
      assert.equal(result.total, stackArtworks ? 2 : 3);
    }
    assert.deepEqual(
      c
        .query({
          filter: { color: { hex: "#ff0000", tolerance: 0 } },
          sort: "color",
        })
        .items.map((f) => f.id),
      ["a"],
    );
  } finally {
    c.close();
  }
});

test("persistent classify and merge undo restore only affected metadata and reject conflicts atomically", async () => {
  const { c, dir } = await fixture();
  c.applyArtwork(artwork(["source", "target"]));
  const source = (c.tags("source")[0] as any).id;
  const target = (c.tags("target")[0] as any).id;
  const collection = c.createCollection("smart", "smart", {
    tags: [{ ids: [source, target] }],
  });
  c.overrideTags(["a"], [source], "add");
  c.overrideTags(["a"], [target], "exclude");
  const merged = c.mergeTags(source, target);
  assert.equal(c.tags().length, 1);
  assert.ok(merged.undoId);
  c.close();
  const reopened = new Catalog(path.join(dir, "data"));
  try {
    reopened.setRating(["a"], 5);
    reopened.undoTags(merged.undoId);
    assert.equal(reopened.tags().length, 2);
    assert.equal(reopened.getFile("a").rating, 5);
    assert.deepEqual((reopened.collections()[0] as any).filter.tags[0].ids, [
      source,
      target,
    ]);
    assert.equal(
      (reopened.db.prepare("SELECT COUNT(*) n FROM artwork_tags").get() as any)
        .n,
      2,
    );
    assert.equal(
      (
        reopened.db
          .prepare("SELECT COUNT(*) n FROM file_tag_overrides")
          .get() as any
      ).n,
      2,
    );
    const classified = reopened.classifyTags([source, target], "style");
    reopened.updateTag(target, { category: "character" });
    assert.throws(() => reopened.undoTags(classified.undoId), /UNDO_CONFLICT/);
    assert.equal((reopened.tags("source")[0] as any).category, "style");
    assert.equal((reopened.tags("target")[0] as any).category, "character");
    reopened.updateTag(target, { category: "style" });
    reopened.undoTags(classified.undoId);
    assert.equal((reopened.tags("source")[0] as any).category, "uncategorized");
    assert.throws(() => reopened.undoTags(classified.undoId), /UNDO_NOT_FOUND/);
    const mergedAgain = reopened.mergeTags(source, target);
    reopened.updateCollection(collection, { filter: { favorite: true } });
    assert.throws(() => reopened.undoTags(mergedAgain.undoId), /UNDO_CONFLICT/);
    assert.equal(reopened.tags().length, 1);
  } finally {
    reopened.close();
  }
});

test("classification undo survives reopening the catalog", async () => {
  const { c, dir } = await fixture();
  const tag = c.createTag("persistent", "content");
  const { undoId } = c.classifyTags([tag], "style");
  c.close();
  const reopened = new Catalog(path.join(dir, "data"));
  try {
    reopened.undoTags(undoId);
    assert.equal((reopened.tags("persistent")[0] as any).category, "content");
  } finally {
    reopened.close();
  }
});

test("merge preserves each source raw name and translation through merge and undo", async () => {
  const { c } = await fixture();
  try {
    c.applyArtwork(artwork(["source", "target"]));
    const source = (c.tags("source")[0] as any).id;
    const target = (c.tags("target")[0] as any).id;
    const rows = () =>
      c.db
        .prepare(
          "SELECT artwork_id,tag_id,raw_name,translation FROM artwork_tags ORDER BY artwork_id,raw_name",
        )
        .all() as any[];
    const before = rows();
    const { undoId } = c.mergeTags(source, target);
    assert.deepEqual(
      rows(),
      before.map((row) => ({ ...row, tag_id: target })),
    );
    assert.equal(rows().length, 2);
    assert.equal((c.tags("target")[0] as any).usageCount, 2);
    c.undoTags(undoId);
    assert.deepEqual(rows(), before);
  } finally {
    c.close();
  }
});

test("restore accepts old backups without undo schema and clears current undo history", async () => {
  const { c, dir } = await fixture();
  try {
    const backup = path.join(dir, "old.sqlite");
    const tag = c.createTag("old schema", "content");
    await c.backup(backup);
    const { default: Database } = await import("better-sqlite3");
    const old = new Database(backup);
    old.exec("DROP TABLE tag_undo;DROP TABLE organization_undo");
    old.close();
    const { undoId } = c.classifyTags([tag], "style");
    const organization = c.applyOrganization({
      fileIds: ["a"],
      favorite: true,
    });
    await c.restore(backup);
    assert.equal((c.tags("old schema")[0] as any).category, "content");
    assert.throws(() => c.undoTags(undoId), /UNDO_NOT_FOUND/);
    assert.throws(
      () => c.undoOrganization(organization.undoId),
      /UNDO_NOT_FOUND/,
    );
  } finally {
    c.close();
  }
});

test("organization applies multiple fields and tags atomically, persists undo and preserves unrelated fields", async () => {
  const { c, dir } = await fixture();
  const existing = c.createTag("existing", "content");
  assert.throws(
    () =>
      c.applyOrganization({
        fileIds: ["a", "b"],
        favorite: true,
        rating: 4,
        tags: [
          { name: "new first", mode: "add" },
          { tagId: "missing", mode: "exclude" },
        ],
      }),
    /TAG_NOT_FOUND/,
  );
  assert.equal(c.getFile("a").favorite, false);
  assert.equal(c.getFile("b").rating, 0);
  assert.deepEqual(c.tags("new first"), []);
  const { undoId } = c.applyOrganization({
    fileIds: ["a", "b"],
    favorite: true,
    rating: 4,
    tags: [
      { name: "new tag", mode: "add" },
      { tagId: existing, mode: "exclude" },
    ],
  });
  assert.equal(c.getFile("a").favorite, true);
  assert.equal(c.getFile("b").rating, 4);
  assert.equal((c.tags("new tag")[0] as any).category, "uncategorized");
  c.close();
  const reopened = new Catalog(path.join(dir, "data"));
  try {
    reopened.setRating(["c"], 5);
    reopened.undoOrganization(undoId);
    assert.equal(reopened.getFile("a").favorite, false);
    assert.equal(reopened.getFile("b").rating, 0);
    assert.equal(reopened.getFile("c").rating, 5);
    assert.deepEqual(reopened.tags("new tag"), []);
    assert.equal(
      (
        reopened.db
          .prepare("SELECT COUNT(*) n FROM file_tag_overrides")
          .get() as any
      ).n,
      0,
    );
    assert.equal(reopened.tags("existing").length, 1);
  } finally {
    reopened.close();
  }
});

test("organization undo rejects field or new-tag association conflicts without partial restoration", async () => {
  const { c } = await fixture();
  try {
    const { undoId } = c.applyOrganization({
      fileIds: ["a", "b"],
      favorite: true,
      rating: 4,
      tags: [{ name: "new tag", mode: "add" }],
    });
    c.setRating(["b"], 5);
    assert.throws(() => c.undoOrganization(undoId), /UNDO_CONFLICT/);
    assert.equal(c.getFile("a").favorite, true);
    assert.equal(c.getFile("a").rating, 4);
    c.setRating(["b"], 4);
    const tag = (c.tags("new tag")[0] as any).id;
    c.overrideTags(["c"], [tag], "add");
    assert.throws(() => c.undoOrganization(undoId), /UNDO_CONFLICT/);
    assert.equal(c.getFile("a").rating, 4);
    assert.equal(c.tags("new tag").length, 1);
    c.overrideTags(["c"], [tag], "clear");
    c.undoOrganization(undoId);
    assert.equal(c.getFile("a").rating, 0);
    assert.deepEqual(c.tags("new tag"), []);
    const next = c.applyOrganization({ fileIds: ["a"], favorite: true });
    c.setRating(["a"], 5);
    c.undoOrganization(next.undoId);
    assert.equal(c.getFile("a").favorite, false);
    assert.equal(c.getFile("a").rating, 5);
  } finally {
    c.close();
  }
});

test("organization rolls back fields, new tags and earlier overrides on a late SQL failure", async () => {
  const { c } = await fixture();
  try {
    c.db.exec(
      "CREATE TRIGGER fail_last_override BEFORE INSERT ON file_tag_overrides WHEN NEW.file_id='b' AND NEW.action='exclude' BEGIN SELECT RAISE(ABORT, 'fixture_failure'); END",
    );
    assert.throws(
      () =>
        c.applyOrganization({
          fileIds: ["a", "b"],
          favorite: true,
          rating: 4,
          tags: [
            { name: "first", mode: "add" },
            { name: "second", mode: "exclude" },
          ],
        }),
      /fixture_failure/,
    );
    assert.equal(c.getFile("a").favorite, false);
    assert.equal(c.getFile("b").rating, 0);
    assert.deepEqual(c.tags(), []);
    assert.equal(
      (c.db.prepare("SELECT COUNT(*) n FROM file_tag_overrides").get() as any)
        .n,
      0,
    );
    assert.equal(
      (c.db.prepare("SELECT COUNT(*) n FROM organization_undo").get() as any).n,
      0,
    );
  } finally {
    c.close();
  }
});

test("organization collection add/remove undo retains prior membership and rejects conflicts atomically", async () => {
  const { c } = await fixture();
  try {
    const collectionId = c.createCollection("normal", "normal");
    c.collectionItems(collectionId, ["a"]);
    const members = () =>
      (
        c.db
          .prepare(
            "SELECT file_id FROM collection_items WHERE collection_id=? ORDER BY file_id",
          )
          .all(collectionId) as any[]
      ).map((r) => r.file_id);
    const add = c.applyOrganization({
      fileIds: ["a", "b"],
      collection: { collectionId, mode: "add" },
    });
    assert.deepEqual(members(), ["a", "b"]);
    c.collectionItems(collectionId, ["c"]);
    c.updateCollection(collectionId, { name: "renamed" });
    c.undoOrganization(add.undoId);
    assert.deepEqual(members(), ["a", "c"]);
    assert.equal(c.collections()[0].name, "renamed");
    const remove = c.applyOrganization({
      fileIds: ["a", "b", "c"],
      favorite: true,
      collection: { collectionId, mode: "remove" },
    });
    assert.deepEqual(members(), []);
    c.collectionItems(collectionId, ["a"]);
    assert.throws(() => c.undoOrganization(remove.undoId), /UNDO_CONFLICT/);
    assert.equal(c.getFile("b").favorite, true);
    assert.deepEqual(members(), ["a"]);
    c.collectionItems(collectionId, ["a"], true);
    c.undoOrganization(remove.undoId);
    assert.deepEqual(members(), ["a", "c"]);
    assert.equal(c.getFile("b").favorite, false);
    const deletion = c.applyOrganization({
      fileIds: ["b"],
      favorite: true,
      collection: { collectionId, mode: "add" },
    });
    c.deleteCollection(collectionId);
    assert.throws(() => c.undoOrganization(deletion.undoId), /UNDO_CONFLICT/);
    assert.equal(c.getFile("b").favorite, true);
    const smart = c.createCollection("smart", "smart", { favorite: true });
    assert.throws(
      () =>
        c.applyOrganization({
          fileIds: ["a"],
          collection: { collectionId: smart, mode: "add" },
        }),
      /NORMAL_COLLECTION_REQUIRED/,
    );
    assert.throws(
      () =>
        c.applyOrganization({
          fileIds: ["a"],
          collection: { collectionId: "missing", mode: "add" },
        }),
      /NORMAL_COLLECTION_REQUIRED/,
    );
  } finally {
    c.close();
  }
});


test("lean totals equal returned matches for projected metadata, compound filters, sorts and stacking", async () => {
 const {c,root}=await fixture();
 try {
  c.applyArtwork(artwork());const tag=(c.tags()[0] as any).id;
  c.db.prepare("INSERT INTO features VALUES('a',?,0.8,0.9,'warm','fixture'),('b',?,0.2,0.1,'cool','fixture')").run('[{"hex":"#ff0000","weight":1}]','[{"hex":"#0000ff","weight":1}]');
  const smart=c.createCollection("published warm","smart",{publishedAfter:"2019",tone:{warmth:"warm"}});
  const filters:import("../src/contracts.js").Filter[]=[{}, {missing:false},{rootIds:[root.id]},{creatorIds:["123"]},{publishedAfter:"2019",publishedBefore:"2021"},{text:"画师"},{text:"测试"},{text:"初音"},{tags:[{ids:[tag],mode:"all"}]},{excludeTagIds:[tag]},{tone:{warmth:"warm"}},{tone:{brightnessMin:0.5,saturationMax:1}},{color:{hex:"#ff0000",tolerance:10}},{color:{hex:"#ff0000",includeUnanalyzed:true,tolerance:10}},{color:{hex:"#ff0000",restrict:false}},{collectionId:smart},{creatorIds:["123"],tone:{warmth:"cool"},heightMin:1000},{directory:{rootId:root.id,relativePath:""},formats:["jpeg"],orientation:"portrait"},{favorite:false,ratingMin:0,bytesMax:20,addedAfter:1},{artworkIds:["81470181"],pixelsMin:100,aspect:2/3}];
  for(const filter of filters)for(const sort of ["added_desc","name","rating_desc","pixels_desc","color"] as const)for(const stackArtworks of [false,true]) {
   const page=c.query({filter,sort,stackArtworks,limit:500});assert.equal(page.total,page.items.length,JSON.stringify({filter,sort,stackArtworks}));
   const first=c.query({filter,sort,stackArtworks,limit:1});assert.equal(first.total,page.total);assert.deepEqual(first.items,page.items.slice(0,1));
  }
  const ranked=c.rankedQuery({filter:{creatorIds:["123"]},limit:500},new Map([["a",0.7],["c",0.9]]));assert.equal(ranked.total,ranked.items.length);assert.deepEqual(ranked.items.map(i=>i.id),["a"]);
 }finally{c.close();}
});
