/** Fixed HTTPS multipart endpoint; never log credentials or raw responses. */
export async function requestSauce(apiKey: string, preview: Uint8Array) {
  const form = new FormData();
  form.set("api_key", apiKey);
  form.set("output_type", "2");
  form.set("db", "5");
  form.set("numres", "10");
  form.set(
    "file",
    new Blob([new Uint8Array(preview)], { type: "image/jpeg" }),
    "preview.jpg",
  );
  const response = await fetch("https://saucenao.com/search.php", {
    method: "POST",
    body: form,
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (Number(response.headers.get("content-length") ?? 0) > 2 * 1024 * 1024)
    throw new Error("SAUCE_RESPONSE_TOO_LARGE");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SAUCE_EMPTY_RESPONSE");
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    size += r.value.byteLength;
    if (size > 2 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("SAUCE_RESPONSE_TOO_LARGE");
    }
    parts.push(r.value);
  }
  return {
    status: response.status,
    body: Buffer.concat(parts).toString("utf8"),
  };
}
