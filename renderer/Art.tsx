import { useState, useEffect } from "react";
import type { FileItem } from "../src/contracts.js";
import { imageUrl, titleOf } from "./model";
import { Icon } from "./ui";
export function Art({
  item,
  original = false,
  style,
}: {
  item: FileItem;
  original?: boolean;
  style?: React.CSSProperties;
}) {
  const [failed, setFailed] = useState(false),
    [retry, setRetry] = useState(0);
  useEffect(
    () => setFailed(false),
    [item.id, item.thumbnailKey, item.mtimeMs, item.bytes, original],
  );
  return (
    <div
      className="if-art"
      style={{
        ...style,
        aspectRatio:
          item.width && item.height ? String(item.width / item.height) : "1",
      }}
    >
      {failed ? (
        <div
          className="if-placeholder"
          title="点击重试预览"
          onClick={(e) => {
            e.stopPropagation();
            setRetry((n) => n + 1);
            setFailed(false);
          }}
        >
          <Icon name="image-off" size={25} />
          <span>{item.missing ? "文件缺失或目录离线" : "预览暂时不可用"}</span>
          <small>点击重试预览</small>
        </div>
      ) : (
        <img
          loading={original ? "eager" : "lazy"}
          src={`${imageUrl(item.id, original)}&v=${encodeURIComponent(`${item.mtimeMs}-${item.bytes}-${item.thumbnailKey ?? "pending"}-${retry}`)}`}
          alt={titleOf(item)}
          draggable={false}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}
